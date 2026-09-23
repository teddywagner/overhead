import { describe, expect, test } from 'bun:test';
import { DEFAULT_DISPLAY_SETTINGS, type DisplayCandidate } from '@overhead/display';
import type { AdminDevice } from '../src/admin-repo';
import { createApp } from '../src/app';
import { USER_ID, VALID_TOKEN, makeDeps } from './fakes';

const DEVICE_ID = '77777777-0000-4000-8000-000000000001';
const LOCATION_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-23T18:00:00Z');
const auth = { Authorization: `Bearer ${VALID_TOKEN}`, 'Content-Type': 'application/json' };

function device(): AdminDevice {
  return {
    id: DEVICE_ID,
    owner_id: USER_ID,
    owner_email: 'dev@overhead.local',
    name: 'Hallway frame',
    location_id: LOCATION_ID,
    location_name: 'Test site',
    timezone: 'America/New_York',
    poll_interval_seconds: 3600,
    battery_mv: null,
    rssi: null,
    firmware_version: null,
    last_boot_reason: null,
    last_seen_at: null,
    created_at: NOW.toISOString(),
    enrollment_state: 'pending',
    settings: DEFAULT_DISPLAY_SETTINGS,
    has_custom_settings: false,
    current_selection: null,
    selections_24h: 0,
  };
}

function candidate(id: string, over: Partial<DisplayCandidate> = {}): DisplayCandidate {
  return {
    overflight_id: id,
    icao24: id.slice(-6),
    registration: null,
    callsign: null,
    flight_number: null,
    origin_code: null,
    destination_code: null,
    origin_name: null,
    destination_name: null,
    closest_seen_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
    status: 'qualified',
    minimum_distance_m: 200,
    closest_altitude_ft: 3000,
    icao_type_code: null,
    manufacturer: null,
    model: null,
    operator_name: null,
    operator_icao: null,
    aircraft_class: null,
    art_asset_id: null,
    art_scope: null,
    airframe_sightings: 1,
    type_sightings: null,
    ...over,
  };
}

function setup({ admin = true } = {}) {
  const deps = makeDeps({ clock: () => NOW });
  if (admin) deps.admin.admins.add(USER_ID);
  deps.admin.devices.push(device());
  deps.admin.locations.push({
    id: LOCATION_ID,
    owner_id: USER_ID,
    name: 'Test site',
    timezone: 'America/New_York',
    search_radius_nm: 5,
    overhead_radius_m: 1200,
    max_altitude_ft: 15000,
    is_active: true,
  });
  return { deps, app: createApp(deps) };
}

const send = (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: auth,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('/admin/v1 access', () => {
  test('requires a signed-in user', async () => {
    const { app } = setup();
    const res = await app.request('/admin/v1/me');
    expect(res.status).toBe(401);
  });

  test('signed-in users who are not admins get 403 on every route', async () => {
    const { app } = setup({ admin: false });
    for (const path of ['/admin/v1/me', '/admin/v1/users', `/admin/v1/devices/${DEVICE_ID}`]) {
      const res = await send(app, 'GET', path);
      expect(res.status).toBe(403);
    }
    const res = await send(app, 'PATCH', `/admin/v1/devices/${DEVICE_ID}/display-settings`, {
      max_planes: 4,
    });
    expect(res.status).toBe(403);
  });

  test('admins can list users and frames', async () => {
    const { app } = setup();
    expect((await send(app, 'GET', '/admin/v1/me')).status).toBe(200);
    const res = await send(app, 'GET', '/admin/v1/devices');
    const body = (await res.json()) as { data: { items: AdminDevice[] } };
    expect(body.data.items.map((d) => d.id)).toEqual([DEVICE_ID]);
  });
});

describe('display settings', () => {
  test('patches merge into the current settings', async () => {
    const { app, deps } = setup();
    const res = await send(app, 'PATCH', `/admin/v1/devices/${DEVICE_ID}/display-settings`, {
      max_planes: 4,
      weights: { rarity: 8 },
    });
    expect(res.status).toBe(200);
    const saved = deps.admin.devices[0]!.settings;
    expect(saved.max_planes).toBe(4);
    expect(saved.weights).toEqual({ ...DEFAULT_DISPLAY_SETTINGS.weights, rarity: 8 });
  });

  test('rejects out-of-range values, unknown fields and half-set quiet hours', async () => {
    const { app } = setup();
    const path = `/admin/v1/devices/${DEVICE_ID}/display-settings`;
    for (const body of [
      { max_planes: 5 },
      { weights: { rarity: 11 } },
      { colour: 'red' },
      { quiet_start_hour: 22 },
    ]) {
      expect((await send(app, 'PATCH', path, body)).status).toBe(400);
    }
    expect(
      (await send(app, 'PATCH', path, { quiet_start_hour: 22, quiet_end_hour: 6 })).status,
    ).toBe(200);
  });
});

describe('POST /admin/v1/devices/{id}/display-preview', () => {
  test('scores candidates with draft settings, explains exclusions and saves nothing', async () => {
    const { app, deps } = setup();
    const a = candidate('00000000-0000-4000-8000-00000000000a', { minimum_distance_m: 50 });
    const b = candidate('00000000-0000-4000-8000-00000000000b', { status: 'near_miss' });
    deps.admin.preview = {
      device: {
        deviceId: DEVICE_ID,
        ownerId: USER_ID,
        locationId: LOCATION_ID,
        timeZone: 'America/New_York',
        pollIntervalSeconds: 3600,
        rules: { overhead_radius_m: 1200, max_altitude_ft: 15000 },
        settings: DEFAULT_DISPLAY_SETTINGS,
      },
      candidates: [a, b],
      current: null,
    };
    const res = await send(app, 'POST', `/admin/v1/devices/${DEVICE_ID}/display-preview`, {
      settings: { max_planes: 1 },
      poll_interval_seconds: 1800,
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        settings: { max_planes: number };
        selected: Array<{ overflight_id: string }>;
        candidates: Array<{ overflight_id: string; excluded: string | null }>;
        decision: { commit: boolean; reason: string };
        wake_schedule: string[];
      };
    };
    expect(data.settings.max_planes).toBe(1);
    expect(data.selected.map((s) => s.overflight_id)).toEqual([a.overflight_id]);
    expect(data.candidates.find((c) => c.overflight_id === b.overflight_id)?.excluded).toBe(
      'near_miss',
    );
    expect(data.decision).toEqual({ commit: true, reason: 'initial' });
    expect(data.wake_schedule[0]).toBe('2026-09-23T18:30:00.000Z');
    expect(deps.admin.devices[0]!.has_custom_settings).toBe(false);
  });

  test('404 for an unknown frame', async () => {
    const { app } = setup();
    const res = await send(
      app,
      'POST',
      '/admin/v1/devices/99999999-0000-4000-8000-000000000009/display-preview',
      {},
    );
    expect(res.status).toBe(404);
  });
});

describe('PATCH /admin/v1/locations/{id}', () => {
  test('keeps the overhead radius inside the search radius', async () => {
    const { app } = setup();
    const bad = await send(app, 'PATCH', `/admin/v1/locations/${LOCATION_ID}`, {
      overhead_radius_m: 20_000,
    });
    expect(bad.status).toBe(400);
    const good = await send(app, 'PATCH', `/admin/v1/locations/${LOCATION_ID}`, {
      max_altitude_ft: 10_000,
    });
    expect(good.status).toBe(200);
  });

  test('does not accept coordinates', async () => {
    const { app } = setup();
    const res = await send(app, 'PATCH', `/admin/v1/locations/${LOCATION_ID}`, { latitude: 1 });
    expect(res.status).toBe(400);
  });
});

describe('admin role', () => {
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const user = (id: string) => ({
    id,
    email: `${id.slice(0, 4)}@example.test`,
    display_name: null,
    created_at: NOW.toISOString(),
    last_sign_in_at: null,
    is_admin: false,
    device_count: 0,
    location_count: 0,
    overflight_count: 0,
    last_overflight_at: null,
  });

  test('admins can grant and revoke admin access for others', async () => {
    const { app, deps } = setup();
    deps.admin.users.push(user(USER_ID), user(OTHER));
    expect((await send(app, 'PUT', `/admin/v1/users/${OTHER}/admin`)).status).toBe(200);
    expect(deps.admin.admins.has(OTHER)).toBe(true);
    expect((await send(app, 'DELETE', `/admin/v1/users/${OTHER}/admin`)).status).toBe(200);
    expect(deps.admin.admins.has(OTHER)).toBe(false);
  });

  test('cannot remove your own access; unknown users are 404', async () => {
    const { app, deps } = setup();
    deps.admin.users.push(user(USER_ID));
    expect((await send(app, 'DELETE', `/admin/v1/users/${USER_ID}/admin`)).status).toBe(409);
    expect(deps.admin.admins.has(USER_ID)).toBe(true);
    expect((await send(app, 'PUT', `/admin/v1/users/${OTHER}/admin`)).status).toBe(404);
  });
});

describe('artwork', () => {
  const OWNER = USER_ID;
  const upload = { owner_id: OWNER, filename: 'b738.png', content_type: 'image/png' };

  test("upload URLs land in the owner's art folder; unknown owners are 404", async () => {
    const { app, deps } = setup();
    expect((await send(app, 'POST', '/admin/v1/art-assets/upload-url', upload)).status).toBe(404);
    deps.adminAssets.owners.add(OWNER);
    const res = await send(app, 'POST', '/admin/v1/art-assets/upload-url', upload);
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { path: string } };
    expect(data.path.startsWith(`${OWNER}/art/`)).toBe(true);
  });

  test('create requires an owned path, valid scope fields and an uploaded file to approve', async () => {
    const { app, deps } = setup();
    deps.adminAssets.owners.add(OWNER);
    const path = `${OWNER}/art/11111111-1111-4111-8111-111111111111-b738.png`;
    const base = { owner_id: OWNER, storage_path: path, scope: 'type', icao_type_code: 'B738' };

    expect(
      (
        await send(app, 'POST', '/admin/v1/art-assets', {
          ...base,
          storage_path: 'someone-else/art/x.png',
        })
      ).status,
    ).toBe(400);
    expect(
      (await send(app, 'POST', '/admin/v1/art-assets', { ...base, icao_type_code: undefined }))
        .status,
    ).toBe(400);
    const missing = await send(app, 'POST', '/admin/v1/art-assets', { ...base, approve: true });
    expect(missing.status).toBe(409);

    deps.adminAssets.objects.add(path);
    const created = await send(app, 'POST', '/admin/v1/art-assets', { ...base, approve: true });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { status: string; approved_at: string } };
    expect(data.status).toBe('approved');
    expect(data.approved_at).toBe(NOW.toISOString());
  });

  test('review approves only uploaded artwork; tag edits keep scope rules', async () => {
    const { app, deps } = setup();
    const id = await deps.adminAssets.createArt(OWNER, {
      scope: 'operator_type',
      icao_type_code: 'B738',
      operator_icao: 'EXA',
      livery_name: null,
      registration: null,
      reviewer_notes: null,
      storage_path: `${OWNER}/art/a.png`,
      status: 'pending_review',
    });
    const review = (status: string) =>
      send(app, 'POST', `/admin/v1/art-assets/${id}/review`, { status, reviewer_notes: 'ok' });
    expect((await review('approved')).status).toBe(409);
    deps.adminAssets.objects.add(`${OWNER}/art/a.png`);
    expect((await review('approved')).status).toBe(200);
    expect((await review('archived')).status).toBe(200);
    expect(deps.adminAssets.art[0]!.approved_at).toBeNull();

    const bad = await send(app, 'PATCH', `/admin/v1/art-assets/${id}`, { operator_icao: null });
    expect(bad.status).toBe(400);
    const good = await send(app, 'PATCH', `/admin/v1/art-assets/${id}`, { livery_name: 'Retro' });
    expect(good.status).toBe(200);
  });

  test('asset routes are admin-only', async () => {
    const { app } = setup({ admin: false });
    for (const path of [
      '/admin/v1/art-assets',
      '/admin/v1/art-coverage',
      '/admin/v1/source-images',
      '/admin/v1/posters',
    ]) {
      expect((await send(app, 'GET', path)).status).toBe(403);
    }
  });
});

describe('frame location', () => {
  test("a frame can only be pointed at one of its owner's locations", async () => {
    const { app, deps } = setup();
    deps.admin.locations.push({
      id: '44444444-4444-4444-8444-444444444444',
      owner_id: '99999999-9999-4999-8999-999999999999',
      name: 'Someone else',
      timezone: 'UTC',
      search_radius_nm: 5,
      overhead_radius_m: 1200,
      max_altitude_ft: 15000,
      is_active: true,
    });
    const path = `/admin/v1/devices/${DEVICE_ID}`;
    expect(
      (await send(app, 'PATCH', path, { location_id: '44444444-4444-4444-8444-444444444444' }))
        .status,
    ).toBe(400);
    expect((await send(app, 'PATCH', path, { location_id: LOCATION_ID })).status).toBe(200);
  });
});
