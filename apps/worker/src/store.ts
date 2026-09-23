import type { ProviderName } from '@overhead/core';
import type {
  ActivePass,
  DetectionLocation,
  FinalizedPass,
  OverflightDraft,
  PassDetail,
  PassSample,
  TickResult,
} from '@overhead/flight-tracking';
import type { Sql } from '@overhead/database';

export interface PollRunRecord {
  locationId: string | null;
  provider: ProviderName;
  startedAt: Date;
  finishedAt: Date;
  status: 'ok' | 'error' | 'rate_limited' | 'skipped';
  aircraftCount: number;
  activePassCount: number;
  startedPassCount: number;
  finalizedCount: number;
  rejectedSampleCount: number;
  errorCode: string | null;
}

export interface WorkerErrorRecord {
  component: string;
  errorCode: string;
  /** Must already be safe: no coordinates, tokens or URLs. */
  message: string;
  locationId: string | null;
  context?: Record<string, unknown>;
}

export interface ApplyTickOutcome {
  createdOverflights: number;
  existingOverflights: number;
}

/**
 * Persistence boundary for the worker. Every write is idempotent so a tick
 * can be retried after a crash without duplicating overflights.
 */
export interface WorkerStore {
  listActiveLocations(): Promise<DetectionLocation[]>;
  loadActivePasses(locationId: string, provider: ProviderName): Promise<ActivePass[]>;
  applyTick(location: DetectionLocation, result: TickResult): Promise<ApplyTickOutcome>;
  recordPollRun(run: PollRunRecord): Promise<void>;
  recordError(error: WorkerErrorRecord): Promise<void>;
  applyRetention(): Promise<Array<{ table_name: string; deleted_count: number }>>;
}

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function rowToActivePass(r: Row): ActivePass {
  const prevAt = isoOrNull(r.prev_observed_at);
  const prev: PassSample | null =
    prevAt === null
      ? null
      : {
          observedAt: prevAt,
          latitude: Number(r.prev_latitude),
          longitude: Number(r.prev_longitude),
          altitudeFt: numOrNull(r.prev_altitude_ft),
          groundspeedKnots: null,
          trackDegrees: null,
        };
  return {
    ownerId: String(r.owner_id),
    locationId: String(r.location_id),
    provider: r.provider as ProviderName,
    icao24: String(r.icao24),
    providerPassKey: String(r.provider_pass_key),
    aircraftId: (r.aircraft_id as string | null) ?? null,
    callsign: (r.callsign as string | null) ?? null,
    firstSeenAt: iso(r.first_seen_at),
    lastSeenAt: iso(r.last_seen_at),
    closestSeenAt: iso(r.closest_seen_at),
    minimumDistanceM: Number(r.minimum_distance_m),
    minimumAltitudeFt: numOrNull(r.minimum_altitude_ft),
    prev,
    current: {
      observedAt: iso(r.current_observed_at),
      latitude: Number(r.current_latitude),
      longitude: Number(r.current_longitude),
      altitudeFt: numOrNull(r.current_altitude_ft),
      groundspeedKnots: numOrNull(r.current_groundspeed_knots),
      trackDegrees: numOrNull(r.current_track_degrees),
    },
    sampleCount: Number(r.sample_count),
    state: (typeof r.state === 'string' ? JSON.parse(r.state) : r.state) as PassDetail,
  };
}

const intOrNull = (v: number | null) => (v === null ? null : Math.round(v));

export class PostgresWorkerStore implements WorkerStore {
  constructor(private readonly sql: Sql) {}

  async listActiveLocations(): Promise<DetectionLocation[]> {
    const rows = (await this.sql`
      select id, owner_id, latitude, longitude, search_radius_nm, overhead_radius_m,
             max_altitude_ft, timezone
        from public.locations
       where is_active
       order by created_at, id`) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      ownerId: String(r.owner_id),
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      searchRadiusNm: Number(r.search_radius_nm),
      overheadRadiusM: Number(r.overhead_radius_m),
      maxAltitudeFt: Number(r.max_altitude_ft),
      timezone: String(r.timezone),
    }));
  }

  async loadActivePasses(locationId: string, provider: ProviderName): Promise<ActivePass[]> {
    const rows = (await this.sql`
      select * from private.active_passes
       where location_id = ${locationId} and provider = ${provider}`) as Row[];
    return rows.map(rowToActivePass);
  }

  async applyTick(location: DetectionLocation, result: TickResult): Promise<ApplyTickOutcome> {
    const outcome: ApplyTickOutcome = { createdOverflights: 0, existingOverflights: 0 };
    if (result.finalized.length === 0 && result.upserts.length === 0) return outcome;

    await this.sql.begin(async (tx) => {
      for (const f of result.finalized) {
        if (f.overflight) {
          const created = await this.persistOverflight(tx as unknown as Sql, f);
          if (created) outcome.createdOverflights++;
          else outcome.existingOverflights++;
        }
        // Delete by pass key so a new pass for the same aircraft survives.
        await tx`
          delete from private.active_passes
           where location_id = ${location.id} and provider = ${f.pass.provider}
             and icao24 = ${f.pass.icao24} and provider_pass_key = ${f.pass.providerPassKey}`;
      }
      for (const p of result.upserts) await this.upsertActivePass(tx as unknown as Sql, p);
    });
    return outcome;
  }

  private async upsertAircraft(tx: Sql, o: OverflightDraft): Promise<string> {
    const raw = JSON.stringify({
      type_description: o.typeDescription,
      source_operator: o.operatorName,
    });
    const rows = (await tx`
      insert into public.aircraft (icao24, registration, icao_type_code, operator_name,
                                   metadata_source, raw_metadata)
      values (${o.icao24}, ${o.registration}, ${o.icaoTypeCode}, ${o.operatorName},
              ${o.provider}, ${raw}::jsonb)
      on conflict (icao24) do update set
        registration = case when public.aircraft.metadata_source = 'manual'
                            then public.aircraft.registration
                            else coalesce(excluded.registration, public.aircraft.registration) end,
        icao_type_code = case when public.aircraft.metadata_source = 'manual'
                              then public.aircraft.icao_type_code
                              else coalesce(excluded.icao_type_code, public.aircraft.icao_type_code) end,
        operator_name = coalesce(public.aircraft.operator_name, excluded.operator_name)
      returning id, (xmax = 0) as inserted`) as Row[];
    const row = rows[0]!;
    if (row.inserted) {
      await tx`
        insert into private.enrichment_attempts (aircraft_id, icao24, provider, status, details)
        values (${row.id as string}, ${o.icao24}, ${o.provider},
                ${o.registration || o.icaoTypeCode ? 'success' : 'not_found'},
                ${JSON.stringify({ stage: 'observation' })}::jsonb)`;
    }
    return String(row.id);
  }

  /** Returns true when a new overflight row was created. */
  private async persistOverflight(tx: Sql, f: FinalizedPass): Promise<boolean> {
    const o = f.overflight!;
    const aircraftId = await this.upsertAircraft(tx, o);
    const inserted = (await tx`
      insert into public.overflights (
        owner_id, location_id, aircraft_id, provider, provider_pass_key, icao24, registration,
        callsign, first_seen_at, closest_seen_at, last_seen_at, local_date, minimum_distance_m,
        minimum_altitude_ft, closest_altitude_ft, closest_latitude, closest_longitude, heading,
        status, qualification_reason, raw_summary)
      values (
        ${o.ownerId}, ${o.locationId}, ${aircraftId}, ${o.provider}, ${o.providerPassKey},
        ${o.icao24}, ${o.registration}, ${o.callsign}, ${o.firstSeenAt}::timestamptz,
        ${o.closestSeenAt}::timestamptz, ${o.lastSeenAt}::timestamptz, ${o.localDate}::date,
        ${o.minimumDistanceM}, ${intOrNull(o.minimumAltitudeFt)}, ${intOrNull(o.closestAltitudeFt)},
        ${o.closestLatitude}, ${o.closestLongitude}, ${o.heading}, ${o.status},
        ${o.qualificationReason}, ${JSON.stringify(o.rawSummary)}::jsonb)
      on conflict on constraint overflights_idempotency_key do nothing
      returning id`) as Row[];

    let overflightId: string;
    if (inserted.length > 0) {
      overflightId = String(inserted[0]!.id);
    } else {
      const existing = (await tx`
        select id from public.overflights
         where owner_id = ${o.ownerId} and location_id = ${o.locationId}
           and provider = ${o.provider} and provider_pass_key = ${o.providerPassKey}`) as Row[];
      overflightId = String(existing[0]!.id);
    }

    for (const p of o.points) {
      await tx`
        insert into public.overflight_points (overflight_id, observed_at, latitude, longitude,
                                              altitude_ft, groundspeed_knots, track_degrees, source)
        values (${overflightId}, ${p.observedAt}::timestamptz, ${p.latitude}, ${p.longitude},
                ${intOrNull(p.altitudeFt)}, ${p.groundspeedKnots},
                ${p.trackDegrees === null ? null : p.trackDegrees % 360}, ${p.source})
        on conflict on constraint overflight_points_unique_sample do nothing`;
    }
    return inserted.length > 0;
  }

  private async upsertActivePass(tx: Sql, p: ActivePass): Promise<void> {
    await tx`
      insert into private.active_passes (
        owner_id, location_id, icao24, aircraft_id, provider, provider_pass_key, callsign,
        first_seen_at, last_seen_at, closest_seen_at, minimum_distance_m, minimum_altitude_ft,
        prev_observed_at, prev_latitude, prev_longitude, prev_altitude_ft,
        current_observed_at, current_latitude, current_longitude, current_altitude_ft,
        current_groundspeed_knots, current_track_degrees, sample_count, state)
      values (
        ${p.ownerId}, ${p.locationId}, ${p.icao24}, ${p.aircraftId}, ${p.provider},
        ${p.providerPassKey}, ${p.callsign}, ${p.firstSeenAt}::timestamptz,
        ${p.lastSeenAt}::timestamptz, ${p.closestSeenAt}::timestamptz, ${p.minimumDistanceM},
        ${intOrNull(p.minimumAltitudeFt)}, ${p.prev?.observedAt ?? null}::timestamptz,
        ${p.prev?.latitude ?? null}, ${p.prev?.longitude ?? null},
        ${intOrNull(p.prev?.altitudeFt ?? null)}, ${p.current.observedAt}::timestamptz,
        ${p.current.latitude}, ${p.current.longitude}, ${intOrNull(p.current.altitudeFt)},
        ${p.current.groundspeedKnots}, ${p.current.trackDegrees}, ${p.sampleCount},
        ${JSON.stringify(p.state)}::jsonb)
      on conflict on constraint active_passes_one_per_aircraft do update set
        aircraft_id = excluded.aircraft_id,
        provider_pass_key = excluded.provider_pass_key,
        callsign = excluded.callsign,
        first_seen_at = excluded.first_seen_at,
        last_seen_at = excluded.last_seen_at,
        closest_seen_at = excluded.closest_seen_at,
        minimum_distance_m = excluded.minimum_distance_m,
        minimum_altitude_ft = excluded.minimum_altitude_ft,
        prev_observed_at = excluded.prev_observed_at,
        prev_latitude = excluded.prev_latitude,
        prev_longitude = excluded.prev_longitude,
        prev_altitude_ft = excluded.prev_altitude_ft,
        current_observed_at = excluded.current_observed_at,
        current_latitude = excluded.current_latitude,
        current_longitude = excluded.current_longitude,
        current_altitude_ft = excluded.current_altitude_ft,
        current_groundspeed_knots = excluded.current_groundspeed_knots,
        current_track_degrees = excluded.current_track_degrees,
        sample_count = excluded.sample_count,
        state = excluded.state`;
  }

  async recordPollRun(run: PollRunRecord): Promise<void> {
    await this.sql`
      insert into private.provider_poll_runs (
        location_id, provider, started_at, finished_at, status, aircraft_count, active_pass_count,
        started_pass_count, finalized_count, rejected_sample_count, error_code, duration_ms)
      values (
        ${run.locationId}, ${run.provider}, ${run.startedAt.toISOString()}::timestamptz, ${run.finishedAt.toISOString()}::timestamptz, ${run.status},
        ${run.aircraftCount}, ${run.activePassCount}, ${run.startedPassCount}, ${run.finalizedCount},
        ${run.rejectedSampleCount}, ${run.errorCode},
        ${Math.max(0, run.finishedAt.getTime() - run.startedAt.getTime())})`;
  }

  async recordError(e: WorkerErrorRecord): Promise<void> {
    await this.sql`
      insert into private.worker_errors (component, error_code, message, location_id, context)
      values (${e.component}, ${e.errorCode}, ${e.message.slice(0, 1000)}, ${e.locationId},
              ${JSON.stringify(e.context ?? {})}::jsonb)`;
  }

  async applyRetention(): Promise<Array<{ table_name: string; deleted_count: number }>> {
    const rows = (await this.sql`select * from private.apply_retention()`) as Row[];
    return rows.map((r) => ({
      table_name: String(r.table_name),
      deleted_count: Number(r.deleted_count),
    }));
  }
}
