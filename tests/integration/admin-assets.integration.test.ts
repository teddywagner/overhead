/**
 * Admin artwork and coverage against local Supabase and Storage: an admin
 * uploads artwork into a user's folder, approves it, sees it cover that
 * user's most-seen operator + type, and gets signed image links.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createAdminClient, type Sql } from '@overhead/database';
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

const hex = () => `a${crypto.randomUUID().replace(/-/g, '').slice(0, 5)}`;
// 1×1 transparent PNG.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (ch) => ch.charCodeAt(0),
);

describe.skipIf(skipIntegration)('admin artwork and coverage', () => {
  const env = ENV!;
  let sql: Sql;
  let admin: TestUser;
  let owner: TestUser;
  let app: ReturnType<typeof makeApp>['app'];
  let deps: ReturnType<typeof makeApp>['deps'];
  const aircraftIds: string[] = [];
  const objects: string[] = [];

  beforeAll(async () => {
    ({ app, deps } = makeApp(env));
    sql = sqlFor(env);
    admin = await createTestUser(env, 'art-admin');
    owner = await createTestUser(env, 'art-owner');
    await sql`insert into private.admins (user_id) values (${admin.id})`;
    const [loc] = (await sql`
      insert into public.locations (owner_id, name, latitude, longitude)
      values (${owner.id}, 'Art test', 0.2, 0.2) returning id`) as Array<{ id: string }>;
    for (let i = 0; i < 3; i++) {
      const icao = hex();
      const [a] = (await sql`
        insert into public.aircraft (icao24, registration, icao_type_code, operator_icao, model)
        values (${icao}, ${`N${i}ART`}, 'ZZ9', 'ZZA', 'Test 9') returning id`) as Array<{
        id: string;
      }>;
      aircraftIds.push(a!.id);
      await sql`
        insert into public.overflights (owner_id, location_id, aircraft_id, provider, provider_pass_key,
          icao24, registration, first_seen_at, closest_seen_at, last_seen_at, local_date,
          minimum_distance_m, status, qualification_reason)
        values (${owner.id}, ${loc!.id}, ${a!.id}, 'mock', ${`art:${icao}`}, ${icao}, ${`N${i}ART`},
          now(), now(), now(), current_date, 100, 'qualified', 'crossed_within_overhead_radius')`;
    }
  });

  afterAll(async () => {
    if (objects.length) await createAdminClient(env).storage.from('aircraft-art').remove(objects);
    await deleteTestUser(env, admin);
    await deleteTestUser(env, owner);
    if (aircraftIds.length) await sql`delete from public.aircraft where id in ${sql(aircraftIds)}`;
    await sql.close();
    await deps.close();
  });

  test('coverage shows a gap before any artwork exists', async () => {
    const res = await call<{
      items: Array<{ operator_icao: string; sightings: number; best_scope: string | null }>;
    }>(app, 'GET', `/admin/v1/art-coverage?owner_id=${owner.id}`, admin);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({
      operator_icao: 'ZZA',
      sightings: 3,
      best_scope: null,
    });
  });

  test('admin uploads artwork for the user, approves it, and coverage picks it up', async () => {
    const up = await call<{ path: string; token: string }>(
      app,
      'POST',
      '/admin/v1/art-assets/upload-url',
      admin,
      { owner_id: owner.id, filename: 'zz9.png', content_type: 'image/png' },
    );
    expect(up.status).toBe(201);
    expect(up.body.data.path.startsWith(`${owner.id}/art/`)).toBe(true);
    objects.push(up.body.data.path);
    const stored = await createAdminClient(env)
      .storage.from('aircraft-art')
      .uploadToSignedUrl(up.body.data.path, up.body.data.token, PNG, { contentType: 'image/png' });
    expect(stored.error).toBeNull();

    const created = await call<{
      id: string;
      status: string;
      image_url: string | null;
      sightings_30d: number;
    }>(app, 'POST', '/admin/v1/art-assets', admin, {
      owner_id: owner.id,
      storage_path: up.body.data.path,
      scope: 'operator_type',
      operator_icao: 'ZZA',
      icao_type_code: 'ZZ9',
      approve: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('approved');
    expect(created.body.data.sightings_30d).toBe(3);
    expect(created.body.data.image_url).toContain('/storage/v1/object/sign/aircraft-art/');
    const img = await fetch(created.body.data.image_url!);
    expect(img.status).toBe(200);

    const [row] =
      (await sql`select owner_id from public.art_assets where id = ${created.body.data.id}`) as Array<{
        owner_id: string;
      }>;
    expect(row!.owner_id).toBe(owner.id);

    const coverage = await call<{
      items: Array<{ best_scope: string; best_thumbnail_url: string | null }>;
    }>(app, 'GET', `/admin/v1/art-coverage?owner_id=${owner.id}`, admin);
    expect(coverage.body.data.items[0]!.best_scope).toBe('operator_type');
    expect(coverage.body.data.items[0]!.best_thumbnail_url).not.toBeNull();

    const list = await call<{ items: Array<{ id: string }>; counts: Record<string, number> }>(
      app,
      'GET',
      `/admin/v1/art-assets?owner_id=${owner.id}`,
      admin,
    );
    expect(list.body.data.items.map((a) => a.id)).toEqual([created.body.data.id]);
    expect(list.body.data.counts).toEqual({ approved: 1 });
  });

  test('source images and posters list across owners', async () => {
    await sql`insert into public.source_images (owner_id, source_provider, license_name)
              values (${owner.id}, 'test', 'CC-BY-4.0')`;
    const images = await call<{ items: Array<{ license_name: string }> }>(
      app,
      'GET',
      `/admin/v1/source-images?owner_id=${owner.id}`,
      admin,
    );
    expect(images.status).toBe(200);
    expect(images.body.data.items[0]!.license_name).toBe('CC-BY-4.0');
    const posters = await call<{ items: unknown[] }>(
      app,
      'GET',
      `/admin/v1/posters?owner_id=${owner.id}`,
      admin,
    );
    expect(posters.status).toBe(200);
    expect(posters.body.data.items).toEqual([]);
  });

  test('the owner cannot use the admin asset routes', async () => {
    expect((await call(app, 'GET', '/admin/v1/art-assets', owner)).status).toBe(403);
  });
});
