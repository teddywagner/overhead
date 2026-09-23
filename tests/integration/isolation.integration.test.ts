/**
 * Cross-user isolation, Data API grants and Storage policies against local
 * Supabase. Every resource created by `alice` must be invisible and
 * immutable to `bob`, through both the Overhead API and raw PostgREST.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BUCKETS } from '@overhead/core';
import { createUserClient, type Sql } from '@overhead/database';
import { createClient } from '@supabase/supabase-js';
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe.skipIf(skipIntegration)('cross-user isolation', () => {
  const env = ENV!;
  let sql: Sql;
  let alice: TestUser;
  let bob: TestUser;
  let app: ReturnType<typeof makeApp>['app'];
  const ids = {} as Record<
    | 'location'
    | 'aircraft'
    | 'overflight'
    | 'sourceImage'
    | 'artPath'
    | 'artToken'
    | 'art'
    | 'poster'
    | 'device',
    string
  >;

  beforeAll(async () => {
    sql = sqlFor(env);
    alice = await createTestUser(env, 'alice');
    bob = await createTestUser(env, 'bob');
    app = makeApp(env).app;

    const loc = await call<{ id: string }>(app, 'POST', '/api/v1/locations', alice, {
      name: 'Alice site',
      latitude: 0.9,
      longitude: -0.9,
    });
    expect(loc.status).toBe(201);
    ids.location = loc.body.data.id;

    // An overflight owned by Alice (as the worker would write it).
    const [aircraft] = await sql`
      insert into public.aircraft (icao24, registration, icao_type_code, metadata_source)
      values (${`f${crypto.randomUUID().slice(0, 5)}`}, 'N900OH', 'B738', 'test') returning id`;
    ids.aircraft = aircraft.id;
    const [ovf] = await sql`
      insert into public.overflights (owner_id, location_id, aircraft_id, provider, provider_pass_key, icao24,
        first_seen_at, closest_seen_at, last_seen_at, local_date, minimum_distance_m, status, qualification_reason)
      values (${alice.id}, ${ids.location}, ${ids.aircraft}, 'mock', 'mock:test:1', 'f00abc',
        now() - interval '2 min', now() - interval '1 min', now(), current_date, 100, 'qualified',
        'crossed_within_overhead_radius') returning id`;
    ids.overflight = ovf.id;

    const src = await call<{ id: string }>(app, 'POST', '/api/v1/source-images', alice, {
      source_provider: 'manual',
      license_name: 'CC BY 4.0',
    });
    expect(src.status).toBe(201);
    ids.sourceImage = src.body.data.id;

    const upload = await call<{ path: string; token: string }>(
      app,
      'POST',
      '/api/v1/art-assets/upload-url',
      alice,
      {
        filename: 'B738 Example.png',
        content_type: 'image/png',
      },
    );
    expect(upload.status).toBe(201);
    ids.artPath = upload.body.data.path;
    ids.artToken = upload.body.data.token;

    const art = await call<{ id: string }>(app, 'POST', '/api/v1/art-assets', alice, {
      scope: 'type',
      icao_type_code: 'B738',
      storage_path: ids.artPath,
      source_image_id: ids.sourceImage,
    });
    expect(art.status).toBe(201);
    ids.art = art.body.data.id;

    const poster = await call<{ id: string }>(app, 'POST', '/api/v1/posters', alice, {
      location_id: ids.location,
      local_date: '2026-09-20',
      template_version: 'v0',
    });
    expect(poster.status).toBe(201);
    ids.poster = poster.body.data.id;

    const device = await call<{ device: { id: string }; setup_secret: string }>(
      app,
      'POST',
      '/api/v1/devices',
      alice,
      {
        name: 'Alice frame',
        mac_address: `aa:bb:cc:${crypto.randomUUID().slice(0, 2)}:${crypto.randomUUID().slice(0, 2)}:01`,
        location_id: ids.location,
      },
    );
    expect(device.status).toBe(201);
    ids.device = device.body.data.device.id;
  });

  afterAll(async () => {
    await deleteTestUser(env, alice);
    await deleteTestUser(env, bob);
    await sql`delete from public.aircraft where id = ${ids.aircraft}`;
    await sql.close();
  });

  const resources = [
    ['locations', 'location'],
    ['overflights', 'overflight'],
    ['source-images', 'sourceImage'],
    ['art-assets', 'art'],
    ['posters', 'poster'],
    ['devices', 'device'],
    ['aircraft', 'aircraft'],
  ] as const;

  test('the owner can read every resource', async () => {
    for (const [path, key] of resources) {
      const res = await call(app, 'GET', `/api/v1/${path}/${ids[key]}`, alice);
      expect(res.status, `GET ${path}`).toBe(200);
    }
  });

  test('another user gets 404 on GET, PATCH and DELETE of every resource', async () => {
    const patches: Record<string, unknown> = {
      locations: { name: 'pwned' },
      'source-images': { creator: 'pwned' },
      'art-assets': { reviewer_notes: 'pwned' },
      posters: { template_version: 'pwned' },
      devices: { name: 'pwned' },
      aircraft: { model: 'pwned' },
    };
    for (const [path, key] of resources) {
      expect(
        (await call(app, 'GET', `/api/v1/${path}/${ids[key]}`, bob)).status,
        `GET ${path}`,
      ).toBe(404);
      if (patches[path]) {
        const res = await call(app, 'PATCH', `/api/v1/${path}/${ids[key]}`, bob, patches[path]);
        expect(res.status, `PATCH ${path}`).toBe(404);
      }
      if (!['overflights', 'aircraft'].includes(path)) {
        expect(
          (await call(app, 'DELETE', `/api/v1/${path}/${ids[key]}`, bob)).status,
          `DELETE ${path}`,
        ).toBe(404);
      }
    }
    for (const action of ['approve', 'reject']) {
      expect(
        (await call(app, 'POST', `/api/v1/art-assets/${ids.art}/${action}`, bob, {})).status,
      ).toBe(404);
    }
    expect(
      (await call(app, 'POST', `/api/v1/devices/${ids.device}/rotate-setup-secret`, bob, {}))
        .status,
    ).toBe(404);
    expect(
      (await call(app, 'POST', `/api/v1/devices/${ids.device}/request-reset`, bob)).status,
    ).toBe(404);
    expect(
      (await call(app, 'POST', `/api/v1/posters/${ids.poster}/device-binary-upload-url`, bob))
        .status,
    ).toBe(404);
    // Nothing was modified.
    const [loc] = await sql`select name from public.locations where id = ${ids.location}`;
    expect(loc.name).toBe('Alice site');
  });

  test("another user's lists are empty", async () => {
    for (const path of [
      'locations',
      'overflights',
      'source-images',
      'art-assets',
      'posters',
      'devices',
      'aircraft',
      'hangar',
    ]) {
      const res = await call<{ items: unknown[] }>(app, 'GET', `/api/v1/${path}`, bob);
      expect(res.status, path).toBe(200);
      expect(res.body.data.items, path).toHaveLength(0);
    }
  });

  test('another user cannot reference foreign records', async () => {
    const poster = await call(app, 'POST', '/api/v1/posters', bob, {
      location_id: ids.location,
      local_date: '2026-09-20',
      template_version: 'v0',
    });
    expect(poster.status).toBe(400);
    const bobLoc = await call<{ id: string }>(app, 'POST', '/api/v1/locations', bob, {
      name: 'Bob site',
      latitude: 1,
      longitude: 1,
    });
    const bobPoster = await call<{ id: string }>(app, 'POST', '/api/v1/posters', bob, {
      location_id: bobLoc.body.data.id,
      local_date: '2026-09-20',
      template_version: 'v0',
    });
    expect(bobPoster.status).toBe(201);
    const item = await call(app, 'POST', `/api/v1/posters/${bobPoster.body.data.id}/items`, bob, {
      items: [{ overflight_id: ids.overflight, art_asset_id: ids.art, display_order: 0 }],
    });
    expect(item.status).not.toBe(201);
    const device = await call(app, 'POST', '/api/v1/devices', bob, {
      name: 'Bob frame',
      mac_address: 'aa:bb:cc:dd:ee:77',
      location_id: ids.location,
    });
    expect(device.status).toBe(400);
  });

  test('raw PostgREST: anon has no access; authenticated cannot write worker-owned data', async () => {
    const anon = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false },
    });
    for (const table of [
      'locations',
      'overflights',
      'aircraft',
      'devices',
      'posters',
      'hangar_aircraft',
    ]) {
      const { data, error } = await anon.from(table).select('*').limit(1);
      expect(error?.code === '42501' || (data ?? []).length === 0, `anon ${table}`).toBe(true);
    }
    const db = createUserClient(env, bob.token);
    const insert = await db.from('overflights').insert({
      owner_id: bob.id,
      location_id: ids.location,
      provider: 'mock',
      provider_pass_key: 'forged',
      icao24: 'f00001',
      first_seen_at: new Date().toISOString(),
      closest_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      local_date: '2026-09-20',
      minimum_distance_m: 1,
      status: 'qualified',
      qualification_reason: 'crossed_within_overhead_radius',
    });
    expect(insert.error?.code).toBe('42501');

    const alices = createUserClient(env, alice.token);
    const telemetry = await alices.from('devices').update({ battery_mv: 1 }).eq('id', ids.device);
    expect(telemetry.error?.code).toBe('42501');
    const binary = await alices
      .from('posters')
      .update({ binary_sha256: 'a'.repeat(64) })
      .eq('id', ids.poster);
    expect(binary.error?.code).toBe('42501');
    const forgedApproval = await alices
      .from('art_assets')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', ids.art);
    expect(forgedApproval.error).not.toBeNull(); // object not uploaded yet → WITH CHECK fails

    // The private schema is not exposed at all.
    const priv = await fetch(`${env.SUPABASE_URL}/rest/v1/device_credentials?select=*`, {
      headers: {
        apikey: env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${alice.token}`,
        'Accept-Profile': 'private',
      },
    });
    expect(priv.ok).toBe(false);
  });

  test('storage: owner-prefixed uploads only, and approval requires the object', async () => {
    const early = await call<unknown>(
      app,
      'POST',
      `/api/v1/art-assets/${ids.art}/approve`,
      alice,
      {},
    );
    expect(early.status).toBe(409);
    expect(early.body.error?.code).toBe('storage_object_missing');

    const aliceDb = createUserClient(env, alice.token);
    const up = await aliceDb.storage
      .from(BUCKETS.aircraftArt)
      .uploadToSignedUrl(ids.artPath!, ids.artToken!, new Blob([PNG], { type: 'image/png' }));
    expect(up.error).toBeNull();

    const bobDb = createUserClient(env, bob.token);
    const intrude = await bobDb.storage
      .from(BUCKETS.aircraftArt)
      .upload(`${alice.id}/art/intruder.png`, new Blob([PNG], { type: 'image/png' }));
    expect(intrude.error).not.toBeNull();
    const peek = await bobDb.storage.from(BUCKETS.aircraftArt).download(ids.artPath!);
    expect(peek.error).not.toBeNull();
    const bobUploadUrl = await bobDb.storage
      .from(BUCKETS.aircraftArt)
      .createSignedUploadUrl(`${alice.id}/art/x.png`);
    expect(bobUploadUrl.error).not.toBeNull();

    const approved = await call<{ status: string; approved_at: string }>(
      app,
      'POST',
      `/api/v1/art-assets/${ids.art}/approve`,
      alice,
      { reviewer_notes: 'looks right' },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('approved');
    expect(approved.body.data.approved_at).toBeTruthy();

    // Paths outside the owner's prefix are refused by the API before storage.
    const foreign = await call(app, 'PATCH', `/api/v1/art-assets/${ids.art}`, alice, {
      storage_path: `${bob.id}/art/x.png`,
    });
    expect(foreign.status).toBe(400);
  });

  test('hangar shows artwork availability for the owner only', async () => {
    const hangar = await call<{
      items: Array<{ aircraft_id: string; has_artwork: boolean; best_art_scope: string }>;
    }>(app, 'GET', '/api/v1/hangar', alice);
    const entry = hangar.body.data.items.find((h) => h.aircraft_id === ids.aircraft);
    expect(entry?.has_artwork).toBe(true);
    expect(entry?.best_art_scope).toBe('type');
  });
});
