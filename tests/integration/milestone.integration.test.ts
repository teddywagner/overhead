/**
 * First milestone, end to end against local Supabase:
 *  1. an authenticated owner has a location
 *  2. the mock provider returns an aircraft crossing it
 *  3. the worker creates and updates an active pass
 *  4. the pass is finalised as a qualifying overflight
 *  5. a second run does not create a duplicate
 *  6. the API returns the completed overflight
 *  7. a different user cannot access it
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { silentLogger } from '@overhead/core';
import type { Sql } from '@overhead/database';
import {
  MOCK_SCENARIOS,
  MockAircraftProvider,
  type DetectionLocation,
} from '@overhead/flight-tracking';
import { Poller } from '../../apps/worker/src/poller';
import { PostgresWorkerStore } from '../../apps/worker/src/store';
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

/** Only poll the location created by this test. */
class ScopedStore extends PostgresWorkerStore {
  constructor(
    sql: Sql,
    private readonly locationId: string,
  ) {
    super(sql);
  }
  override async listActiveLocations(): Promise<DetectionLocation[]> {
    return (await super.listActiveLocations()).filter((l) => l.id === this.locationId);
  }
}

describe.skipIf(skipIntegration)('milestone: mocked overflight end to end', () => {
  const env = ENV!;
  let sql: Sql;
  let owner: TestUser;
  let other: TestUser;
  let app: ReturnType<typeof makeApp>['app'];
  let locationId: string;
  const epoch = Date.parse('2026-09-20T14:00:00Z');

  const runWorker = async (fromS: number, toS: number) => {
    let now = epoch + fromS * 1000;
    const clock = () => new Date(now);
    const poller = new Poller({
      provider: new MockAircraftProvider({
        scenario: MOCK_SCENARIOS['direct-crossing']!,
        epoch: new Date(epoch),
        clock,
      }),
      store: new ScopedStore(sql, locationId),
      logger: silentLogger,
      pollIntervalS: 15,
      clock,
    });
    for (let t = fromS; t <= toS; t += 15) {
      now = epoch + t * 1000;
      const summary = await poller.runCycle();
      expect(summary.failed).toBe(0);
    }
  };

  beforeAll(async () => {
    sql = sqlFor(env);
    owner = await createTestUser(env, 'owner');
    other = await createTestUser(env, 'other');
    app = makeApp(env).app;
    const created = await call<{ id: string }>(app, 'POST', '/api/v1/locations', owner, {
      name: 'Milestone test site',
      latitude: -0.25,
      longitude: 0.25,
      timezone: 'UTC',
    });
    expect(created.status).toBe(201);
    locationId = created.body.data.id;
  });

  afterAll(async () => {
    await deleteTestUser(env, owner);
    await deleteTestUser(env, other);
    await sql.close();
  });

  test('worker creates, updates and finalises the pass exactly once', async () => {
    await runWorker(0, 150);
    const active = await sql`
      select provider_pass_key, sample_count from private.active_passes where location_id = ${locationId}`;
    expect(active).toHaveLength(1);
    expect(Number(active[0].sample_count)).toBeGreaterThan(1);

    await runWorker(165, 600);
    const remaining =
      await sql`select 1 from private.active_passes where location_id = ${locationId}`;
    expect(remaining).toHaveLength(0);
    const rows = await sql`
      select status, qualification_reason, provider_pass_key, minimum_distance_m
        from public.overflights where location_id = ${locationId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('qualified');
    expect(rows[0].provider_pass_key).toBe(active[0].provider_pass_key);
    expect(Number(rows[0].minimum_distance_m)).toBeLessThan(1200);

    const points = await sql`
      select count(*)::int as n from public.overflight_points p
        join public.overflights o on o.id = p.overflight_id where o.location_id = ${locationId}`;
    expect(points[0].n).toBeGreaterThan(2);
  });

  test('a second run over the same traffic does not duplicate', async () => {
    await runWorker(0, 600);
    const rows = await sql`select id from public.overflights where location_id = ${locationId}`;
    expect(rows).toHaveLength(1);
  });

  test('the owner reads the overflight through the API', async () => {
    const list = await call<{ items: Array<{ id: string; status: string; aircraft: unknown }> }>(
      app,
      'GET',
      `/api/v1/overflights?location_id=${locationId}&status=qualified`,
      owner,
    );
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    const item = list.body.data.items[0]!;
    expect(item).not.toHaveProperty('closest_latitude');
    const detail = await call<Record<string, unknown>>(
      app,
      'GET',
      `/api/v1/overflights/${item.id}`,
      owner,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.closest_latitude).toBeUndefined();
    const withPos = await call<Record<string, unknown>>(
      app,
      'GET',
      `/api/v1/overflights/${item.id}?include_position=true`,
      owner,
    );
    expect(typeof withPos.body.data.closest_latitude).toBe('number');
    const points = await call<{ items: unknown[] }>(
      app,
      'GET',
      `/api/v1/overflights/${item.id}/points`,
      owner,
    );
    expect(points.body.data.items.length).toBeGreaterThan(2);
    const hangar = await call<{ items: Array<{ registration: string; pass_count: number }> }>(
      app,
      'GET',
      '/api/v1/hangar',
      owner,
    );
    expect(
      hangar.body.data.items.some((h) => h.registration === 'N101OH' && h.pass_count >= 1),
    ).toBe(true);
  });

  test('another user cannot see or reach it', async () => {
    const [row] =
      await sql`select id, aircraft_id from public.overflights where location_id = ${locationId}`;
    const list = await call<{ items: unknown[] }>(app, 'GET', '/api/v1/overflights', other);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(0);
    expect((await call(app, 'GET', `/api/v1/overflights/${row.id}`, other)).status).toBe(404);
    expect((await call(app, 'GET', `/api/v1/overflights/${row.id}/points`, other)).status).toBe(
      404,
    );
    expect((await call(app, 'GET', `/api/v1/locations/${locationId}`, other)).status).toBe(404);
    expect((await call(app, 'GET', `/api/v1/hangar/${row.aircraft_id}`, other)).status).toBe(404);
    expect((await call(app, 'GET', `/api/v1/aircraft/${row.aircraft_id}`, other)).status).toBe(404);
    const hangar = await call<{ items: unknown[] }>(app, 'GET', '/api/v1/hangar', other);
    expect(hangar.body.data.items).toHaveLength(0);
  });

  test('passes from the adsb.lol provider persist under its own provider name', async () => {
    const created = await call<{ id: string }>(app, 'POST', '/api/v1/locations', owner, {
      name: 'adsb.lol site',
      latitude: -0.5,
      longitude: 0.5,
      timezone: 'UTC',
    });
    const previous = locationId;
    locationId = created.body.data.id;
    let now = epoch;
    const clock = () => new Date(now);
    const mock = new MockAircraftProvider({
      scenario: MOCK_SCENARIOS['direct-crossing']!,
      epoch: new Date(epoch),
      clock,
    });
    // Same traffic, reported as adsb.lol (exercises the DB provider checks).
    const provider = {
      name: 'adsb_lol' as const,
      getAircraftNear: mock.getAircraftNear.bind(mock),
    };
    const poller = new Poller({
      provider,
      store: new ScopedStore(sql, locationId),
      logger: silentLogger,
      pollIntervalS: 15,
      clock,
    });
    for (let t = 0; t <= 600; t += 15) {
      now = epoch + t * 1000;
      expect((await poller.runCycle()).failed).toBe(0);
    }
    const rows = await sql`
      select provider, provider_pass_key, status from public.overflights where location_id = ${locationId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('adsb_lol');
    expect(String(rows[0].provider_pass_key).startsWith('adsb_lol:')).toBe(true);
    locationId = previous;
  });

  test('a worker restart mid-pass resumes from persisted state', async () => {
    // Fresh location, crash-and-restart halfway through the crossing.
    const created = await call<{ id: string }>(app, 'POST', '/api/v1/locations', owner, {
      name: 'Restart site',
      latitude: -0.75,
      longitude: 0.75,
      timezone: 'UTC',
    });
    const previous = locationId;
    locationId = created.body.data.id;
    await runWorker(0, 180);
    await runWorker(195, 600); // new Poller instance == new process
    const rows = await sql`select status from public.overflights where location_id = ${locationId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('qualified');
    locationId = previous;
  });
});
