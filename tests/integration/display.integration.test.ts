/**
 * Display selection and the admin board against local Supabase: the worker
 * commits selections from real overflight rows, owners can read but not
 * write them, other users see nothing, and /admin/v1 is closed to non-admins
 * while giving admins a working preview.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { silentLogger } from '@overhead/core';
import { createUserClient, type Sql } from '@overhead/database';
import { DEFAULT_DISPLAY_SETTINGS } from '@overhead/display';
import { PostgresDisplayStore, DisplayScheduler } from '../../apps/worker/src/display-scheduler';
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
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const mac = () =>
  Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0'),
  ).join(':');

describe.skipIf(skipIntegration)('display selection', () => {
  const env = ENV!;
  let sql: Sql;
  let owner: TestUser;
  let other: TestUser;
  let locationId: string;
  let deviceId: string;
  const aircraftIds: string[] = [];
  let app: ReturnType<typeof makeApp>['app'];
  let deps: ReturnType<typeof makeApp>['deps'];

  beforeAll(async () => {
    ({ app, deps } = makeApp(env));
    sql = sqlFor(env);
    owner = await createTestUser(env, 'display');
    other = await createTestUser(env, 'display-other');
    type Id = Array<{ id: string }>;
    locationId = (
      (await sql`
      insert into public.locations (owner_id, name, latitude, longitude, timezone)
      values (${owner.id}, 'Display test', 0.3, 0.3, 'America/New_York') returning id`) as Id
    )[0]!.id;
    deviceId = (
      (await sql`
      insert into public.devices (owner_id, location_id, name, mac_address)
      values (${owner.id}, ${locationId}, 'Display frame', ${mac()}) returning id`) as Id
    )[0]!.id;
    await sql`insert into private.device_credentials (device_id, setup_secret_hash)
              values (${deviceId}, ${'0'.repeat(64)})`;

    const planes = [
      { type: 'B738', op: 'EXA', dist: 150, mins: 30, status: 'qualified' },
      { type: 'A388', op: 'UAE', dist: 600, mins: 90, status: 'qualified' },
      { type: 'B738', op: 'EXA', dist: 300, mins: 60, status: 'qualified' },
      { type: 'C172', op: null, dist: 2500, mins: 45, status: 'near_miss' },
    ];
    for (const [i, p] of planes.entries()) {
      const icao = hex();
      const [a] = (await sql`
        insert into public.aircraft (icao24, icao_type_code, operator_icao, model)
        values (${icao}, ${p.type}, ${p.op}, ${p.type}) returning id`) as Array<{ id: string }>;
      aircraftIds.push(a!.id);
      const at = minutesAgo(p.mins);
      await sql`
        insert into public.overflights (owner_id, location_id, aircraft_id, provider, provider_pass_key,
          icao24, first_seen_at, closest_seen_at, last_seen_at, local_date, minimum_distance_m,
          closest_altitude_ft, status, qualification_reason)
        values (${owner.id}, ${locationId}, ${a!.id}, 'mock', ${`display:${icao}:${i}`}, ${icao},
          ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz, current_date, ${p.dist}, 4000,
          ${p.status},
          ${p.status === 'qualified' ? 'crossed_within_overhead_radius' : 'outside_overhead_radius'})`;
    }
  });

  afterAll(async () => {
    await sql`delete from private.admins where user_id in (${owner.id}, ${other.id})`;
    await deleteTestUser(env, owner);
    await deleteTestUser(env, other);
    if (aircraftIds.length) await sql`delete from public.aircraft where id in ${sql(aircraftIds)}`;
    await sql.close();
    await deps.close();
  });

  test('the worker commits a selection from recorded passes, then holds it', async () => {
    // Only this test's frame, so other local data is never touched.
    class OneFrameStore extends PostgresDisplayStore {
      override async devices() {
        return (await super.devices()).filter((d) => d.deviceId === deviceId);
      }
    }
    const scheduler = new DisplayScheduler({
      store: new OneFrameStore(sql),
      logger: silentLogger,
      intervalS: 60,
    });

    expect(await scheduler.runOnce()).toEqual({ devices: 1, committed: 1, errors: 0 });
    expect(await scheduler.runOnce()).toEqual({ devices: 1, committed: 0, errors: 0 });

    const rows = (await sql`
      select reason, items, settings from public.display_selections where device_id = ${deviceId}`) as Array<{
      reason: string;
      items: Array<{ icao_type_code: string; display_order: number }>;
      settings: { max_planes: number };
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('initial');
    // Defaults: near misses out, one EXA 737 only, so two planes.
    expect(rows[0]!.items.map((i) => i.icao_type_code).sort()).toEqual(['A388', 'B738']);
    expect(rows[0]!.settings.max_planes).toBe(DEFAULT_DISPLAY_SETTINGS.max_planes);
  });

  test('owners can read their selections but not write them; others see nothing', async () => {
    const mine = createUserClient(env, owner.token);
    const read = await mine.from('display_selections').select('id').eq('device_id', deviceId);
    expect(read.data).toHaveLength(1);
    const write = await mine.from('display_selections').insert({
      owner_id: owner.id,
      device_id: deviceId,
      selected_at: new Date().toISOString(),
      reason: 'changed',
      overflight_ids: [],
      items: [],
    });
    expect(write.error).not.toBeNull();

    const theirs = createUserClient(env, other.token);
    expect((await theirs.from('display_selections').select('id')).data).toEqual([]);
    expect((await theirs.from('device_display_settings').select('device_id')).data).toEqual([]);
  });

  test('/admin/v1 is closed to signed-in users who are not admins', async () => {
    expect((await call(app, 'GET', '/admin/v1/me', null)).status).toBe(401);
    expect((await call(app, 'GET', '/admin/v1/users', owner)).status).toBe(403);
  });

  test('admins see users and frames, edit settings and preview drafts', async () => {
    await sql`insert into private.admins (user_id) values (${owner.id})`;

    const users = await call<{ items: Array<{ id: string; device_count: number }> }>(
      app,
      'GET',
      '/admin/v1/users',
      owner,
    );
    expect(users.status).toBe(200);
    expect(users.body.data.items.find((u) => u.id === owner.id)?.device_count).toBe(1);

    const detail = await call<{
      device: { has_custom_settings: boolean; current_selection: { items: unknown[] } | null };
      location: { overhead_radius_m: number } & Record<string, unknown>;
    }>(app, 'GET', `/admin/v1/devices/${deviceId}`, owner);
    expect(detail.status).toBe(200);
    expect(detail.body.data.device.has_custom_settings).toBe(false);
    expect(detail.body.data.device.current_selection?.items).toHaveLength(2);
    expect(Object.keys(detail.body.data.location)).not.toContain('latitude');

    const patched = await call(
      app,
      'PATCH',
      `/admin/v1/devices/${deviceId}/display-settings`,
      owner,
      {
        include_near_misses: true,
        one_per_operator_type: false,
        max_planes: 4,
      },
    );
    expect(patched.status).toBe(200);
    const [row] = (await sql`
      select max_planes, include_near_misses from public.device_display_settings
       where device_id = ${deviceId}`) as Array<{
      max_planes: number;
      include_near_misses: boolean;
    }>;
    expect(row).toEqual({ max_planes: 4, include_near_misses: true });

    const preview = await call<{
      selected: Array<{ icao_type_code: string }>;
      candidates: Array<{ type_sightings: number | null; icao_type_code: string }>;
      decision: { commit: boolean; reason: string };
    }>(app, 'POST', `/admin/v1/devices/${deviceId}/display-preview`, owner, {
      settings: { max_planes: 3 },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.data.selected).toHaveLength(3);
    expect(preview.body.data.candidates).toHaveLength(4);
    expect(
      preview.body.data.candidates.find((c) => c.icao_type_code === 'B738')?.type_sightings,
    ).toBe(2);
    expect(preview.body.data.decision.commit).toBe(false); // within the dwell time
  });

  test('retention still runs with the selection history step', async () => {
    const rows = (await sql`select * from private.apply_retention()`) as Array<{
      table_name: string;
    }>;
    expect(rows.map((r) => r.table_name)).toContain('display_selections');
  });
});
