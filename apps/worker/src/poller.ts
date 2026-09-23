import type { Logger } from '@overhead/core';
import {
  ProviderError,
  processTick,
  type AircraftPositionProvider,
  type DetectionLocation,
  type DetectionParams,
} from '@overhead/flight-tracking';
import type { WorkerStore } from './store';

export interface PollerOptions {
  provider: AircraftPositionProvider;
  store: WorkerStore;
  logger: Logger;
  pollIntervalS: number;
  detection?: Partial<DetectionParams>;
  retentionIntervalMs?: number;
  /** Backoff after consecutive failures: base * 2^(n-1), capped. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  clock?: () => Date;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface LocationHealth {
  failures: number;
  nextAttemptAt: number;
}

/**
 * Providers only return aircraft inside the queried radius, so querying
 * exactly the search radius would hide the sample that shows an aircraft
 * leaving; every pass would then wait for the gap timeout. Query a margin
 * beyond it so exits are observed on the next poll.
 */
export function queryRadiusNm(searchRadiusNm: number): number {
  return Math.min(250, searchRadiusNm + Math.max(1, searchRadiusNm * 0.2));
}

export interface CycleSummary {
  locations: number;
  polled: number;
  skipped: number;
  failed: number;
  createdOverflights: number;
}

/**
 * Polls every active location once per interval, feeds observations into
 * the overflight state machine and persists the result. Failures back off
 * per location (and globally on provider rate limits) without affecting
 * other locations.
 */
export class Poller {
  private readonly health = new Map<string, LocationHealth>();
  private providerPausedUntil = 0;
  private lastRetentionAt = 0;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(private readonly options: PollerOptions) {}

  private now(): Date {
    return (this.options.clock ?? (() => new Date()))();
  }

  private backoffMs(failures: number, retryAfterMs: number | null): number {
    const base = this.options.backoffBaseMs ?? 15_000;
    const max = this.options.backoffMaxMs ?? 15 * 60_000;
    const exp = Math.min(max, base * 2 ** Math.max(0, failures - 1));
    const jitter = exp * 0.2 * (this.options.random ?? Math.random)();
    return Math.max(retryAfterMs ?? 0, Math.round(exp + jitter));
  }

  async runCycle(): Promise<CycleSummary> {
    const { store, provider, logger } = this.options;
    const summary: CycleSummary = {
      locations: 0,
      polled: 0,
      skipped: 0,
      failed: 0,
      createdOverflights: 0,
    };
    let locations: DetectionLocation[];
    try {
      locations = await store.listActiveLocations();
    } catch (err) {
      logger.error('failed to load locations', { error_code: 'db_error', error: safeMessage(err) });
      summary.failed++;
      return summary;
    }
    summary.locations = locations.length;

    for (const location of locations) {
      if (this.stopped) break;
      const startedAt = this.now();
      const h = this.health.get(location.id) ?? { failures: 0, nextAttemptAt: 0 };
      if (startedAt.getTime() < Math.max(h.nextAttemptAt, this.providerPausedUntil)) {
        summary.skipped++;
        continue;
      }
      try {
        const positions = await provider.getAircraftNear({
          latitude: location.latitude,
          longitude: location.longitude,
          radiusNm: queryRadiusNm(location.searchRadiusNm),
        });
        const active = await store.loadActivePasses(location.id, provider.name);
        const now = this.now();
        const result = processTick({
          location,
          provider: provider.name,
          now,
          positions,
          active,
          params: this.options.detection,
        });
        const outcome = await store.applyTick(location, result);
        summary.polled++;
        summary.createdOverflights += outcome.createdOverflights;
        this.health.set(location.id, { failures: 0, nextAttemptAt: 0 });

        for (const f of result.finalized) {
          logger.info('pass finalized', {
            location_id: location.id,
            icao24: f.pass.icao24,
            reason: f.reason,
            status: f.overflight?.status ?? 'dropped',
            drop_reason: f.dropReason,
          });
        }
        await store.recordPollRun({
          locationId: location.id,
          provider: provider.name,
          startedAt,
          finishedAt: this.now(),
          status: 'ok',
          aircraftCount: positions.length,
          activePassCount: result.upserts.length,
          startedPassCount: result.started,
          finalizedCount: result.finalized.length,
          rejectedSampleCount: result.rejected.length,
          errorCode: null,
        });
      } catch (err) {
        summary.failed++;
        const failures = h.failures + 1;
        const retryAfter = err instanceof ProviderError ? err.retryAfterMs : null;
        const delay = this.backoffMs(failures, retryAfter);
        this.health.set(location.id, { failures, nextAttemptAt: startedAt.getTime() + delay });
        const code = err instanceof ProviderError ? err.code : 'processing_error';
        if (err instanceof ProviderError && err.code === 'rate_limited') {
          this.providerPausedUntil = startedAt.getTime() + delay;
        }
        logger.warn('location poll failed', {
          location_id: location.id,
          error_code: code,
          error: safeMessage(err),
          consecutive_failures: failures,
          backoff_ms: delay,
        });
        await this.safely(() =>
          store.recordError({
            component: 'poller',
            errorCode: code,
            message: safeMessage(err),
            locationId: location.id,
            context: { consecutive_failures: failures, backoff_ms: delay },
          }),
        );
        await this.safely(() =>
          store.recordPollRun({
            locationId: location.id,
            provider: provider.name,
            startedAt,
            finishedAt: this.now(),
            status: code === 'rate_limited' ? 'rate_limited' : 'error',
            aircraftCount: 0,
            activePassCount: 0,
            startedPassCount: 0,
            finalizedCount: 0,
            rejectedSampleCount: 0,
            errorCode: code,
          }),
        );
      }
    }

    await this.maybeApplyRetention();
    return summary;
  }

  private async maybeApplyRetention(): Promise<void> {
    const interval = this.options.retentionIntervalMs;
    if (!interval) return;
    const now = this.now().getTime();
    if (now - this.lastRetentionAt < interval) return;
    this.lastRetentionAt = now;
    await this.safely(async () => {
      const result = await this.options.store.applyRetention();
      this.options.logger.info('retention applied', { deleted: result });
    });
  }

  private async safely(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.options.logger.error('bookkeeping write failed', { error: safeMessage(err) });
    }
  }

  /** Run until stop() is called. Cycles are spaced by the poll interval. */
  async start(): Promise<void> {
    const intervalMs = this.options.pollIntervalS * 1000;
    const sleep =
      this.options.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          this.wake = () => {
            clearTimeout(t);
            resolve();
          };
        }));
    while (!this.stopped) {
      const started = Date.now();
      const summary = await this.runCycle();
      this.options.logger.debug('cycle complete', { ...summary });
      const elapsed = Date.now() - started;
      if (!this.stopped) await sleep(Math.max(0, intervalMs - elapsed));
    }
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }
}

/** Error text safe for logs: never includes URLs or coordinates. */
export function safeMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/-?\d{1,3}\.\d{3,}/g, '[num]')
    .slice(0, 500);
}
