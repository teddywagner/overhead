import type { AircraftDetails, FlightRoute } from '@overhead/flight-tracking';
import type { Sql } from '@overhead/database';
import { fillAircraftFromTypes } from './aircraft-types-store';

export type LookupStatus = 'success' | 'not_found' | 'error';

export interface AircraftToEnrich {
  id: string;
  icao24: string;
}

export interface OverflightToEnrich {
  id: string;
  aircraftId: string | null;
  callsign: string;
}

/**
 * Persistence for adsbdb enrichment. Every lookup is logged in
 * private.enrichment_attempts, which is what stops repeat lookups: a
 * success or not_found is final, an error is retried after an hour.
 */
export interface EnrichmentStore {
  aircraftNeedingDetails(limit: number): Promise<AircraftToEnrich[]>;
  overflightsNeedingRoute(limit: number): Promise<OverflightToEnrich[]>;
  saveAircraftDetails(
    target: AircraftToEnrich,
    details: AircraftDetails | null,
    status: LookupStatus,
    errorCode?: string,
  ): Promise<void>;
  saveRoute(
    target: OverflightToEnrich,
    route: FlightRoute | null,
    status: LookupStatus,
    errorCode?: string,
  ): Promise<void>;
}

/** Routes are looked up by callsign as of today, so only for recent flights. */
export const ROUTE_LOOKBACK_DAYS = 7;
const RETRY_ERRORS_AFTER = '1 hour';

type Row = Record<string, unknown>;

export class PostgresEnrichmentStore implements EnrichmentStore {
  constructor(private readonly sql: Sql) {}

  async aircraftNeedingDetails(limit: number): Promise<AircraftToEnrich[]> {
    const rows = (await this.sql`
      select a.id, a.icao24
        from public.aircraft a
       where a.icao24 !~ '^~'
         and not exists (
           select 1 from private.enrichment_attempts e
            where e.aircraft_id = a.id and e.provider = 'adsbdb' and e.kind = 'aircraft'
              and (e.status in ('success', 'not_found')
                   or e.attempted_at > now() - ${RETRY_ERRORS_AFTER}::interval))
       order by a.created_at desc
       limit ${limit}`) as Row[];
    return rows.map((r) => ({ id: String(r.id), icao24: String(r.icao24) }));
  }

  async overflightsNeedingRoute(limit: number): Promise<OverflightToEnrich[]> {
    const rows = (await this.sql`
      select o.id, o.aircraft_id, o.callsign
        from public.overflights o
       where o.callsign ~ '^[A-Z]{3}[0-9]{1,4}[A-Z]{0,2}$'
         and o.flight_number is null
         and o.closest_seen_at > now() - make_interval(days => ${ROUTE_LOOKBACK_DAYS})
         and not exists (
           select 1 from private.enrichment_attempts e
            where e.overflight_id = o.id and e.provider = 'adsbdb' and e.kind = 'route'
              and (e.status in ('success', 'not_found')
                   or e.attempted_at > now() - ${RETRY_ERRORS_AFTER}::interval))
       order by o.closest_seen_at desc
       limit ${limit}`) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      aircraftId: (r.aircraft_id as string | null) ?? null,
      callsign: String(r.callsign),
    }));
  }

  async saveAircraftDetails(
    target: AircraftToEnrich,
    d: AircraftDetails | null,
    status: LookupStatus,
    errorCode?: string,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      if (d) {
        // Fill gaps only: never overwrite existing (including manual) values.
        await tx`
          update public.aircraft set
            manufacturer = coalesce(manufacturer, ${d.manufacturer}),
            model = coalesce(model, ${d.model}),
            country = coalesce(country, ${d.country}),
            registration = coalesce(registration, ${d.registration}),
            icao_type_code = coalesce(icao_type_code, ${d.icaoTypeCode}),
            raw_metadata = raw_metadata || jsonb_build_object('adsbdb', ${JSON.stringify(d)}::jsonb)
          where id = ${target.id}`;
      }
      // Whatever adsbdb could not supply, take from the aircraft type table.
      await fillAircraftFromTypes(tx as unknown as Sql, target.id);
      await tx`
        insert into private.enrichment_attempts
          (aircraft_id, icao24, provider, kind, status, error_code)
        values (${target.id}, ${target.icao24}, 'adsbdb', 'aircraft', ${status}, ${errorCode ?? null})`;
    });
  }

  async saveRoute(
    target: OverflightToEnrich,
    r: FlightRoute | null,
    status: LookupStatus,
    errorCode?: string,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      if (r) {
        await tx`
          update public.overflights set
            flight_number = coalesce(flight_number, ${r.flightNumber}),
            origin_code = coalesce(origin_code, ${r.originCode}),
            destination_code = coalesce(destination_code, ${r.destinationCode}),
            raw_summary = raw_summary || jsonb_build_object('route', ${JSON.stringify(r)}::jsonb)
          where id = ${target.id}`;
        if (target.aircraftId && (r.airlineName || r.airlineIcao)) {
          // Operator comes from the flight (who is flying it), not the
          // registered owner. Manual corrections are left alone.
          await tx`
            update public.aircraft set
              operator_name = coalesce(${r.airlineName}, operator_name),
              operator_icao = coalesce(${r.airlineIcao}, operator_icao),
              operator_iata = coalesce(${r.airlineIata}, operator_iata)
            where id = ${target.aircraftId}
              and coalesce(metadata_source, '') <> 'manual'`;
        }
      }
      const icao24 = target.aircraftId
        ? ((
            (await tx`select icao24 from public.aircraft where id = ${target.aircraftId}`) as Row[]
          )[0]?.icao24 as string | undefined)
        : undefined;
      await tx`
        insert into private.enrichment_attempts
          (aircraft_id, overflight_id, icao24, provider, kind, status, error_code, details)
        values (${target.aircraftId}, ${target.id}, ${icao24 ?? 'unknown'}, 'adsbdb', 'route',
                ${status}, ${errorCode ?? null}, ${JSON.stringify({ callsign: target.callsign })}::jsonb)`;
    });
  }
}
