/**
 * The admin photo collection and route details against local Supabase: the
 * first saved photo of an operator + type fills its slot, a later one is
 * offered for comparison, choosing it replaces the best, and removing the
 * best empties the slot. Also: the owner's overflight list carries route
 * names, and closest-approach coordinates only when asked for.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Sql } from '@overhead/database';
import type { PhotoCandidate } from '@overhead/flight-tracking';
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

const hex = () => `b${crypto.randomUUID().replace(/-/g, '').slice(0, 5)}`;

interface Pick {
  id: string;
  collection: {
    status: string;
    slot: { operator_icao: string | null; icao_type_code: string } | null;
    best: { id: string; icao24: string | null } | null;
  };
}
interface Report {
  items: Array<{
    icao24: string;
    collection_best: { id: string } | null;
    recent_routes: Array<{
      origin_code: string | null;
      destination_code: string | null;
      origin_name: string | null;
      destination_name: string | null;
      flight_number: string | null;
      passes: number;
    }>;
  }>;
  collection: Array<{
    operator_icao: string | null;
    icao_type_code: string;
    airframes: number;
    best: { id: string } | null;
  }>;
}

describe.skipIf(skipIntegration)('photo collection and routes', () => {
  const env = ENV!;
  let sql: Sql;
  let admin: TestUser;
  let owner: TestUser;
  let app: ReturnType<typeof makeApp>['app'];
  let deps: ReturnType<typeof makeApp>['deps'];
  let locationId: string;
  const icaos = [hex(), hex(), hex()];
  const aircraftIds: string[] = [];

  const photo = (icao24: string): PhotoCandidate => ({
    provider: 'wikimedia_commons',
    thumbnailUrl: `https://upload.test/${icao24}/thumb.jpg`,
    imageUrl: `https://upload.test/${icao24}/full.jpg`,
    pageUrl: `https://commons.test/File:${icao24}.jpg`,
    creator: 'Someone',
    licenseName: 'CC BY 2.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/2.0',
  });
  const pick = (icao24: string) =>
    call<Pick>(app, 'POST', `/admin/v1/aircraft-photos/${icao24}/picks`, admin, {
      image_url: photo(icao24).imageUrl,
    });
  const report = async () =>
    (await call<Report>(app, 'GET', `/admin/v1/seen-aircraft?owner_id=${owner.id}`, admin)).body
      .data;

  beforeAll(async () => {
    ({ app, deps } = makeApp(env));
    deps.aircraftPhotos = {
      photo: async () => null,
      candidates: async (icao24) => ({ items: [photo(icao24)], failed: [] }),
    };
    sql = sqlFor(env);
    admin = await createTestUser(env, 'collection-admin');
    owner = await createTestUser(env, 'collection-owner');
    await sql`insert into private.admins (user_id) values (${admin.id})`;
    const [loc] = (await sql`
      insert into public.locations (owner_id, name, latitude, longitude)
      values (${owner.id}, 'Collection test', 0.2, 0.2) returning id`) as Array<{ id: string }>;
    locationId = loc!.id;
    // Two United-style 737-800s (same slot) and one aircraft of unknown type.
    const types = ['ZZ8', 'ZZ8', null];
    for (const [i, icao] of icaos.entries()) {
      const [a] = (await sql`
        insert into public.aircraft (icao24, registration, icao_type_code, operator_icao)
        values (${icao}, ${`N${i}COL`}, ${types[i]}, 'ZZU') returning id`) as Array<{
        id: string;
      }>;
      aircraftIds.push(a!.id);
      const route = JSON.stringify({ route: { originName: 'Origin City', destinationName: null } });
      await sql`
        insert into public.overflights (owner_id, location_id, aircraft_id, provider,
          provider_pass_key, icao24, registration, callsign, flight_number, origin_code,
          destination_code, first_seen_at, closest_seen_at, last_seen_at, local_date,
          minimum_distance_m, closest_altitude_ft, closest_latitude, closest_longitude, status,
          qualification_reason, raw_summary)
        values (${owner.id}, ${locationId}, ${a!.id}, 'mock', ${`col:${icao}`}, ${icao},
          ${`N${i}COL`}, 'ZZU123', 'ZU123', 'KAAA', 'KBBB', now(), now(), now(), current_date,
          150, 3000, 0.201, 0.2, 'qualified', 'crossed_within_overhead_radius',
          ${route}::jsonb)`;
    }
  });

  afterAll(async () => {
    await deleteTestUser(env, admin);
    await deleteTestUser(env, owner);
    if (aircraftIds.length) await sql`delete from public.aircraft where id in ${sql(aircraftIds)}`;
    await sql.close();
    await deps.close();
  });

  test('seen aircraft lists each airframe’s routes and every empty slot', async () => {
    const r = await report();
    const first = r.items.find((i) => i.icao24 === icaos[0])!;
    expect(first.recent_routes).toEqual([
      expect.objectContaining({
        origin_code: 'KAAA',
        destination_code: 'KBBB',
        origin_name: 'Origin City',
        destination_name: null,
        flight_number: 'ZU123',
        passes: 1,
      }),
    ]);
    expect(first.collection_best).toBeNull();
    // Known types only: the unknown-type aircraft has no slot.
    expect(r.collection).toEqual([
      expect.objectContaining({
        operator_icao: 'ZZU',
        icao_type_code: 'ZZ8',
        airframes: 2,
        best: null,
      }),
    ]);
  });

  test('the first photo fills the slot; a later one is offered for comparison', async () => {
    const one = await pick(icaos[0]!);
    expect(one.status).toBe(201);
    expect(one.body.data.collection).toMatchObject({
      status: 'added',
      slot: { operator_icao: 'ZZU', icao_type_code: 'ZZ8' },
      best: { id: one.body.data.id, icao24: icaos[0] },
    });

    const two = await pick(icaos[1]!);
    expect(two.body.data.collection).toMatchObject({
      status: 'kept_existing',
      best: { id: one.body.data.id },
    });

    let r = await report();
    expect(r.collection[0]!.best?.id).toBe(one.body.data.id);
    // Both airframes in the slot point at the same best photo.
    for (const icao of icaos.slice(0, 2)) {
      expect(r.items.find((i) => i.icao24 === icao)!.collection_best?.id).toBe(one.body.data.id);
    }

    const choose = await call<{ best: { id: string } }>(
      app,
      'PUT',
      '/admin/v1/photo-collection',
      admin,
      { source_image_id: two.body.data.id },
    );
    expect(choose.status).toBe(200);
    expect(choose.body.data.best.id).toBe(two.body.data.id);
    r = await report();
    expect(r.collection[0]!.best?.id).toBe(two.body.data.id);

    // Removing the best photo empties the slot.
    const del = await call(
      app,
      'DELETE',
      `/admin/v1/aircraft-photos/picks/${two.body.data.id}`,
      admin,
    );
    expect(del.status).toBe(200);
    r = await report();
    expect(r.collection[0]!.best).toBeNull();
  });

  test('an aircraft of unknown type has no slot', async () => {
    const res = await pick(icaos[2]!);
    expect(res.status).toBe(201);
    expect(res.body.data.collection).toEqual({ status: 'no_type', slot: null, best: null });
    const choose = await call(app, 'PUT', '/admin/v1/photo-collection', admin, {
      source_image_id: res.body.data.id,
    });
    expect(choose.status).toBe(400);
  });

  test('only the admin who saved a photo can make it their best', async () => {
    const res = await pick(icaos[0]!);
    await sql`insert into private.admins (user_id) values (${owner.id})`;
    try {
      const other = await call(app, 'PUT', '/admin/v1/photo-collection', owner, {
        source_image_id: res.body.data.id,
      });
      expect(other.status).toBe(404);
    } finally {
      await sql`delete from private.admins where user_id = ${owner.id}`;
    }
  });

  test('the owner’s overflight list has route names, and positions only on request', async () => {
    type Row = {
      origin_name: string | null;
      destination_name: string | null;
      closest_latitude?: number | null;
    };
    const base = `/api/v1/overflights?location_id=${locationId}`;
    const plain = await call<{ items: Row[] }>(app, 'GET', base, owner);
    expect(plain.status).toBe(200);
    expect(plain.body.data.items).toHaveLength(3);
    expect(plain.body.data.items[0]).toMatchObject({
      origin_name: 'Origin City',
      destination_name: null,
    });
    expect(plain.body.data.items[0]).not.toHaveProperty('closest_latitude');

    const withPos = await call<{ items: Row[] }>(
      app,
      'GET',
      `${base}&include_position=true`,
      owner,
    );
    expect(withPos.body.data.items[0]!.closest_latitude).toBeCloseTo(0.201);

    // Other users see none of it.
    const other = await call<{ items: Row[] }>(app, 'GET', `${base}&include_position=true`, admin);
    expect(other.body.data.items).toHaveLength(0);
  });
});
