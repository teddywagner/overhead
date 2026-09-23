/**
 * adsbdb enrichment persistence against local Supabase, with a fake adsbdb
 * client (no network): fills gaps only, takes the operator from the flight,
 * leaves manual edits alone and never repeats a finished lookup.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { silentLogger } from '@overhead/core';
import type { Sql } from '@overhead/database';
import type { AircraftDetails, FlightRoute } from '@overhead/flight-tracking';
import { Enricher } from '../../apps/worker/src/enricher';
import { PostgresEnrichmentStore } from '../../apps/worker/src/enrichment-store';
import {
  ENV,
  call,
  createTestUser,
  deleteTestUser,
  makeApp,
  skipIntegration,
  sqlFor,
  type TestUser,
} from './harness';

const hex = () => `e${crypto.randomUUID().replace(/-/g, '').slice(0, 5)}`;

describe.skipIf(skipIntegration)('adsbdb enrichment persistence', () => {
  const env = ENV!;
  let sql: Sql;
  let owner: TestUser;
  const ids: Record<'location' | 'plain' | 'manual' | 'overflight' | 'oldOverflight', string> =
    {} as never;
  const hexes = { plain: hex(), manual: hex() };
  const lookups: string[] = [];

  const client = {
    aircraft: async (h: string): Promise<AircraftDetails | null> => {
      lookups.push(`aircraft:${h}`);
      return {
        manufacturer: 'Boeing',
        model: '737-8',
        registration: 'N349TV',
        icaoTypeCode: 'B38M',
        country: 'United States',
        registeredOwner: 'Lessor LLC',
      };
    },
    route: async (c: string): Promise<FlightRoute | null> => {
      lookups.push(`route:${c}`);
      return {
        airlineName: 'American Airlines',
        airlineIcao: 'AAL',
        airlineIata: 'AA',
        flightNumber: 'AA2995',
        originCode: 'JFK',
        destinationCode: 'MEX',
        originName: 'New York',
        destinationName: 'Mexico City',
      };
    },
  };

  const newEnricher = () =>
    new Enricher({
      client,
      store: new PostgresEnrichmentStore(sql),
      logger: silentLogger,
      intervalS: 30,
      batchSize: 100,
    });

  beforeAll(async () => {
    sql = sqlFor(env);
    owner = await createTestUser(env, 'enrich');
    const app = makeApp(env).app;
    const loc = await call<{ id: string }>(app, 'POST', '/api/v1/locations', owner, {
      name: 'Enrichment site',
      latitude: 0.7,
      longitude: 0.7,
    });
    ids.location = loc.body.data.id;
    const [plain] = await sql`
      insert into public.aircraft (icao24, registration, icao_type_code, metadata_source)
      values (${hexes.plain}, 'N349TV', 'B38M', 'adsb_lol') returning id`;
    const [manual] = await sql`
      insert into public.aircraft (icao24, model, operator_name, metadata_source)
      values (${hexes.manual}, 'My own model name', 'My operator', 'manual') returning id`;
    ids.plain = plain.id;
    ids.manual = manual.id;
    const insertOverflight = async (
      aircraftId: string,
      key: string,
      callsign: string,
      ageDays: number,
    ) => {
      const [o] = await sql`
        insert into public.overflights (owner_id, location_id, aircraft_id, provider, provider_pass_key, icao24,
          callsign, first_seen_at, closest_seen_at, last_seen_at, local_date, minimum_distance_m, status,
          qualification_reason)
        values (${owner.id}, ${ids.location}, ${aircraftId}, 'adsb_lol', ${key}, 'f00abc', ${callsign},
          now() - make_interval(days => ${ageDays}) - interval '2 min',
          now() - make_interval(days => ${ageDays}) - interval '1 min',
          now() - make_interval(days => ${ageDays}), current_date, 100, 'qualified',
          'crossed_within_overhead_radius') returning id`;
      return String(o.id);
    };
    ids.overflight = await insertOverflight(ids.manual, 'k-recent', 'AAL2995', 0);
    ids.oldOverflight = await insertOverflight(ids.plain, 'k-old', 'AAL2995', 30);
    await insertOverflight(ids.plain, 'k-private', 'N349TV', 0); // not an airline callsign
  });

  afterAll(async () => {
    await deleteTestUser(env, owner);
    await sql`delete from public.aircraft where id in (${ids.plain}, ${ids.manual})`;
    await sql.close();
  });

  test('fills empty aircraft fields without overwriting existing ones', async () => {
    await newEnricher().runOnce();
    const [plain] =
      await sql`select manufacturer, model, country, registration, raw_metadata from public.aircraft where id = ${ids.plain}`;
    expect(plain).toMatchObject({
      manufacturer: 'Boeing',
      model: '737-8',
      country: 'United States',
      registration: 'N349TV',
    });
    expect(plain.raw_metadata.adsbdb.registeredOwner).toBe('Lessor LLC');
    const [manual] =
      await sql`select manufacturer, model, operator_name from public.aircraft where id = ${ids.manual}`;
    expect(manual.model).toBe('My own model name'); // existing value kept
    expect(manual.manufacturer).toBe('Boeing'); // gap filled
    expect(manual.operator_name).toBe('My operator'); // manual operator not replaced by the route
  });

  test('adds flight number and route to recent airline flights only', async () => {
    const [recent] =
      await sql`select flight_number, origin_code, destination_code, raw_summary from public.overflights where id = ${ids.overflight}`;
    expect(recent).toMatchObject({
      flight_number: 'AA2995',
      origin_code: 'JFK',
      destination_code: 'MEX',
    });
    expect(recent.raw_summary.route.airlineName).toBe('American Airlines');
    const [old] =
      await sql`select flight_number from public.overflights where id = ${ids.oldOverflight}`;
    expect(old.flight_number).toBeNull(); // older than the 7-day route lookback
    // Once for the recent flight; the 30-day-old flight with the same callsign is skipped.
    expect(lookups.filter((l) => l === 'route:AAL2995')).toHaveLength(1);
    expect(lookups).not.toContain('route:N349TV');
  });

  test('takes the operator from the flight for non-manual aircraft', async () => {
    const [o] = await sql`
      insert into public.overflights (owner_id, location_id, aircraft_id, provider, provider_pass_key, icao24,
        callsign, first_seen_at, closest_seen_at, last_seen_at, local_date, minimum_distance_m, status,
        qualification_reason)
      values (${owner.id}, ${ids.location}, ${ids.plain}, 'adsb_lol', 'k-plain', 'f00abc', 'AAL2996',
        now() - interval '2 min', now() - interval '1 min', now(), current_date, 100, 'qualified',
        'crossed_within_overhead_radius') returning id`;
    await newEnricher().runOnce();
    const [plain] =
      await sql`select operator_name, operator_icao, operator_iata from public.aircraft where id = ${ids.plain}`;
    expect(plain).toMatchObject({
      operator_name: 'American Airlines',
      operator_icao: 'AAL',
      operator_iata: 'AA',
    });
    const [flight] = await sql`select flight_number from public.overflights where id = ${o.id}`;
    expect(flight.flight_number).toBe('AA2995');
  });

  test('never repeats a finished lookup (including after a worker restart)', async () => {
    const before = lookups.length;
    await newEnricher().runOnce();
    await newEnricher().runOnce();
    expect(lookups.length).toBe(before);
    const attempts = await sql`
      select kind, status, count(*)::int as n from private.enrichment_attempts
       where provider = 'adsbdb' and (aircraft_id in (${ids.plain}, ${ids.manual}))
       group by 1, 2 order by 1, 2`;
    expect(attempts).toEqual([
      { kind: 'aircraft', status: 'success', n: 2 },
      { kind: 'route', status: 'success', n: 2 },
    ]);
  });
});
