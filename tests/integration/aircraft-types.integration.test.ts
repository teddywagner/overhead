/**
 * Aircraft type reference table against local Supabase: loader keeps manual
 * rows, and the enricher fills make/model from the type table when adsbdb has
 * nothing, without overwriting existing values. Also checks it is readable
 * by signed-in users but not writable by them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { silentLogger } from '@overhead/core';
import { createUserClient, type Sql } from '@overhead/database';
import type { AircraftTypeRecord } from '@overhead/flight-tracking';
import {
  fillAircraftFromTypes,
  upsertAircraftTypes,
} from '../../apps/worker/src/aircraft-types-store';
import { Enricher } from '../../apps/worker/src/enricher';
import { PostgresEnrichmentStore } from '../../apps/worker/src/enrichment-store';
import {
  ENV,
  createTestUser,
  deleteTestUser,
  skipIntegration,
  sqlFor,
  type TestUser,
} from './harness';

const hex = () => `d${crypto.randomUUID().replace(/-/g, '').slice(0, 5)}`;
const record = (code: string, manufacturer: string, model: string): AircraftTypeRecord => ({
  icaoTypeCode: code,
  name: `${manufacturer.toUpperCase()} ${model}`,
  manufacturer,
  model,
  aircraftClass: 'helicopter',
  engineCount: 1,
  engineType: 'turbine',
  wakeCategory: 'L',
});

describe.skipIf(skipIntegration)('aircraft type reference', () => {
  const env = ENV!;
  let sql: Sql;
  let user: TestUser;
  const codes = { a: 'ZZ1', b: 'ZZ2', manual: 'ZZ3' };
  const aircraftIds: string[] = [];

  beforeAll(async () => {
    sql = sqlFor(env);
    user = await createTestUser(env, 'types');
    await sql`delete from public.aircraft_types where icao_type_code in (${codes.a}, ${codes.b}, ${codes.manual})`;
    await sql`insert into public.aircraft_types (icao_type_code, name, manufacturer, model, source)
              values (${codes.manual}, 'MY NAME', 'Hand Edited', 'Mine', 'manual')`;
  });

  afterAll(async () => {
    if (aircraftIds.length) await sql`delete from public.aircraft where id in ${sql(aircraftIds)}`;
    await sql`delete from public.aircraft_types where icao_type_code in (${codes.a}, ${codes.b}, ${codes.manual})`;
    await deleteTestUser(env, user);
    await sql.close();
  });

  test('the loader writes types but keeps manual rows', async () => {
    const result = await upsertAircraftTypes(
      sql,
      [
        record(codes.a, 'Bell', '407'),
        record(codes.b, 'Robinson', 'R-44'),
        record(codes.manual, 'Loader', 'Value'),
      ],
      'tar1090-db',
    );
    expect(result).toEqual({ written: 2, keptManual: 1 });
    const [manual] =
      await sql`select manufacturer, model, source from public.aircraft_types where icao_type_code = ${codes.manual}`;
    expect(manual).toEqual({ manufacturer: 'Hand Edited', model: 'Mine', source: 'manual' });
  });

  test('the enricher fills make/model from the type table when adsbdb has nothing', async () => {
    const [unknown] =
      await sql`insert into public.aircraft (icao24, icao_type_code) values (${hex()}, ${codes.a}) returning id`;
    const [partial] =
      await sql`insert into public.aircraft (icao24, icao_type_code, model) values (${hex()}, ${codes.b}, 'Raven II') returning id`;
    aircraftIds.push(String(unknown.id), String(partial.id));
    const enricher = new Enricher({
      client: { aircraft: async () => null, route: async () => null }, // adsbdb: not found
      store: new PostgresEnrichmentStore(sql),
      logger: silentLogger,
      intervalS: 30,
      batchSize: 500,
    });
    await enricher.runOnce();
    const rows =
      await sql`select id, manufacturer, model from public.aircraft where id in ${sql(aircraftIds)}`;
    const byId = new Map(rows.map((r: { id: string }) => [r.id, r]));
    expect(byId.get(String(unknown.id))).toMatchObject({ manufacturer: 'Bell', model: '407' });
    // Existing model kept; only the empty manufacturer filled.
    expect(byId.get(String(partial.id))).toMatchObject({
      manufacturer: 'Robinson',
      model: 'Raven II',
    });
    expect(await fillAircraftFromTypes(sql, String(unknown.id))).toBe(0); // nothing left to fill
  });

  test('signed-in users can read types but not change them', async () => {
    const db = createUserClient(env, user.token);
    const read = await db
      .from('aircraft_types')
      .select('icao_type_code, manufacturer')
      .eq('icao_type_code', codes.a);
    expect(read.error).toBeNull();
    expect(read.data).toEqual([{ icao_type_code: codes.a, manufacturer: 'Bell' }]);
    const write = await db
      .from('aircraft_types')
      .update({ manufacturer: 'Hacked' })
      .eq('icao_type_code', codes.a);
    expect(write.error?.code).toBe('42501');
  });
});
