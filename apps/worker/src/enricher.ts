import type { Logger } from '@overhead/core';
import { ProviderError, type AdsbdbClient } from '@overhead/flight-tracking';
import type { EnrichmentStore } from './enrichment-store';
import { safeMessage } from './poller';

export interface EnricherOptions {
  client: Pick<AdsbdbClient, 'aircraft' | 'route'>;
  store: EnrichmentStore;
  logger: Logger;
  intervalS: number;
  /** Lookups of each kind per round. */
  batchSize: number;
  /** Pause after a rate limit or repeated failures. */
  pauseMs?: number;
  clock?: () => Date;
}

export interface EnrichmentRound {
  aircraft: number;
  routes: number;
  errors: number;
  paused: boolean;
}

/**
 * Fills in aircraft details (manufacturer, model, country) and flight
 * routes (operator, flight number, origin, destination) from adsbdb.
 * Runs beside the poller so lookups never delay polling. Existing rows are
 * backfilled naturally: anything without a logged lookup is picked up.
 */
export class Enricher {
  private pausedUntil = 0;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(private readonly options: EnricherOptions) {}

  private now(): number {
    return (this.options.clock ?? (() => new Date()))().getTime();
  }

  async runOnce(): Promise<EnrichmentRound> {
    const { client, store, logger, batchSize } = this.options;
    const round: EnrichmentRound = { aircraft: 0, routes: 0, errors: 0, paused: false };
    if (this.now() < this.pausedUntil) return { ...round, paused: true };

    const pause = (err: unknown) => {
      const retryAfter = err instanceof ProviderError ? err.retryAfterMs : null;
      this.pausedUntil =
        this.now() + Math.max(retryAfter ?? 0, this.options.pauseMs ?? 10 * 60_000);
      round.paused = true;
      logger.warn('enrichment paused', {
        error: safeMessage(err),
        resume_in_ms: this.pausedUntil - this.now(),
      });
    };
    const codeOf = (err: unknown) => (err instanceof ProviderError ? err.code : 'processing_error');

    try {
      for (const target of await store.aircraftNeedingDetails(batchSize)) {
        if (this.stopped) break;
        try {
          const details = await client.aircraft(target.icao24);
          await store.saveAircraftDetails(target, details, details ? 'success' : 'not_found');
          round.aircraft++;
        } catch (err) {
          round.errors++;
          await store
            .saveAircraftDetails(target, null, 'error', codeOf(err))
            .catch(() => undefined);
          if (err instanceof ProviderError && (err.code === 'rate_limited' || !err.retryable)) {
            pause(err);
            return round;
          }
        }
      }
      for (const target of await store.overflightsNeedingRoute(batchSize)) {
        if (this.stopped) break;
        try {
          const route = await client.route(target.callsign);
          await store.saveRoute(target, route, route ? 'success' : 'not_found');
          round.routes++;
        } catch (err) {
          round.errors++;
          await store.saveRoute(target, null, 'error', codeOf(err)).catch(() => undefined);
          if (err instanceof ProviderError && (err.code === 'rate_limited' || !err.retryable)) {
            pause(err);
            return round;
          }
        }
      }
    } catch (err) {
      // Database trouble: log and try again next round.
      round.errors++;
      logger.error('enrichment round failed', { error: safeMessage(err) });
    }
    if (round.aircraft || round.routes) logger.info('enrichment round', { ...round });
    return round;
  }

  async start(): Promise<void> {
    const intervalMs = this.options.intervalS * 1000;
    while (!this.stopped) {
      await this.runOnce();
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }
}
