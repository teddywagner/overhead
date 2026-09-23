import type { ProviderName } from '@overhead/core';
import type {
  ActivePass,
  DetectionLocation,
  OverflightDraft,
  TickResult,
} from '@overhead/flight-tracking';
import type { ApplyTickOutcome, PollRunRecord, WorkerErrorRecord, WorkerStore } from './store';

/**
 * In-memory WorkerStore with the same idempotency semantics as the Postgres
 * store (unique pass key per owner/location/provider, one active pass per
 * aircraft). State is JSON-serialised to mimic a database round-trip.
 */
export class InMemoryWorkerStore implements WorkerStore {
  locations: DetectionLocation[] = [];
  active = new Map<string, string>();
  overflights = new Map<string, OverflightDraft & { id: string }>();
  pollRuns: PollRunRecord[] = [];
  errors: WorkerErrorRecord[] = [];
  /** Inject a failure into the next applyTick call (crash simulation). */
  failNextApply: Error | null = null;

  private activeKey = (locationId: string, provider: string, icao24: string) =>
    `${locationId}|${provider}|${icao24}`;

  async listActiveLocations(): Promise<DetectionLocation[]> {
    return structuredClone(this.locations);
  }

  async loadActivePasses(locationId: string, provider: ProviderName): Promise<ActivePass[]> {
    return [...this.active.entries()]
      .filter(([k]) => k.startsWith(`${locationId}|${provider}|`))
      .map(([, v]) => JSON.parse(v) as ActivePass);
  }

  async applyTick(location: DetectionLocation, result: TickResult): Promise<ApplyTickOutcome> {
    if (this.failNextApply) {
      const err = this.failNextApply;
      this.failNextApply = null;
      throw err;
    }
    const outcome: ApplyTickOutcome = { createdOverflights: 0, existingOverflights: 0 };
    // Stage then commit, mirroring the transaction in PostgresWorkerStore.
    const active = new Map(this.active);
    const overflights = new Map(this.overflights);
    for (const f of result.finalized) {
      if (f.overflight) {
        const o = f.overflight;
        const key = `${o.ownerId}|${o.locationId}|${o.provider}|${o.providerPassKey}`;
        if (overflights.has(key)) outcome.existingOverflights++;
        else {
          overflights.set(key, { ...structuredClone(o), id: crypto.randomUUID() });
          outcome.createdOverflights++;
        }
      }
      const k = this.activeKey(location.id, f.pass.provider, f.pass.icao24);
      const existing = active.get(k);
      if (
        existing &&
        (JSON.parse(existing) as ActivePass).providerPassKey === f.pass.providerPassKey
      ) {
        active.delete(k);
      }
    }
    for (const p of result.upserts) {
      active.set(this.activeKey(location.id, p.provider, p.icao24), JSON.stringify(p));
    }
    this.active = active;
    this.overflights = overflights;
    return outcome;
  }

  async recordPollRun(run: PollRunRecord): Promise<void> {
    this.pollRuns.push(run);
  }

  async recordError(error: WorkerErrorRecord): Promise<void> {
    this.errors.push(error);
  }

  async applyRetention() {
    return [];
  }
}
