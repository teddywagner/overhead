import { describe, expect, test } from 'bun:test';
import { DEFAULT_DISPLAY_SETTINGS, type DisplayCandidate } from '@overhead/display';
import { ProviderError } from '@overhead/flight-tracking';
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

  test('seen aircraft passes normalised filters to the repository', async () => {
    const { app, deps } = setup();
    const res = await send(
      app,
      'GET',
      '/admin/v1/seen-aircraft?days=7&type_code=a21n&operator=jbu&manufacturer=Airbus,Boeing',
    );
    expect(res.status).toBe(200);
    expect(deps.adminAssets.seenFilters[0]).toEqual({
      viewerId: USER_ID,
      ownerId: undefined,
      days: 7,
      includeNearMisses: false,
      typeCode: 'A21N',
      operatorIcao: 'JBU',
      manufacturers: ['Airbus', 'Boeing'],
      excludeHelicopters: false,
      limit: 200,
    });
    for (const bad of ['manufacturer=%27%3Bdrop', 'days=0', 'limit=501', 'operator=JB']) {
      expect((await send(app, 'GET', `/admin/v1/seen-aircraft?${bad}`)).status).toBe(400);
    }
  });

  test('aircraft photos map Planespotters results and fail soft', async () => {
    const { app, deps } = setup();
    const path = '/admin/v1/aircraft-photos/a3e07a?registration=n349tv';
    expect((await send(app, 'GET', path)).status).toBe(503); // not configured

    const asked: Array<[string, string | null]> = [];
    let fail = false;
    deps.aircraftPhotos = {
      async photo(icao24, registration) {
        asked.push([icao24, registration]);
        if (fail) throw new ProviderError('rate_limited', 'slow down', true, null, 429);
        return icao24 === 'a3e07a'
          ? {
              thumbnailUrl: 'https://t.test/1_t.jpg',
              largeUrl: 'https://t.test/1_280.jpg',
              pageUrl: 'https://p.test/photo/1',
              photographer: 'Gerrit Griem',
            }
          : null;
      },
      candidates: async () => ({ items: [], failed: [] }),
    };
    type PhotoBody = { data: { photo: unknown } };
    const res = await send(app, 'GET', path);
    expect(res.status).toBe(200);
    expect(((await res.json()) as PhotoBody).data.photo).toEqual({
      thumbnail_url: 'https://t.test/1_t.jpg',
      large_url: 'https://t.test/1_280.jpg',
      page_url: 'https://p.test/photo/1',
      photographer: 'Gerrit Griem',
    });
    expect(asked[0]).toEqual(['a3e07a', 'N349TV']);

    const none = await send(app, 'GET', '/admin/v1/aircraft-photos/~2afe91');
    expect(((await none.json()) as PhotoBody).data.photo).toBeNull();
    expect(asked[1]).toEqual(['~2afe91', null]);

    fail = true;
    expect((await send(app, 'GET', path)).status).toBe(503);
    for (const bad of ['zzzzzz', 'a3e07a?registration=../x']) {
      expect((await send(app, 'GET', `/admin/v1/aircraft-photos/${bad}`)).status).toBe(400);
    }
  });

  test('photos can be picked from the offered candidates and unpicked', async () => {
    const { app, deps } = setup();
    const offered = {
      provider: 'wikimedia_commons' as const,
      thumbnailUrl: 'https://upload.test/thumb.jpg',
      imageUrl: 'https://upload.test/full.jpg',
      pageUrl: 'https://commons.test/File:N349TV.jpg',
      creator: 'Someone',
      licenseName: 'CC BY 2.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/2.0',
    };
    deps.aircraftPhotos = {
      photo: async () => null,
      candidates: async () => ({ items: [offered], failed: ['adsbdb'] }),
    };
    const list = await send(app, 'GET', '/admin/v1/aircraft-photos/a3e07a/candidates');
    expect(((await list.json()) as { data: unknown }).data).toEqual({
      items: [
        {
          provider: 'wikimedia_commons',
          thumbnail_url: offered.thumbnailUrl,
          image_url: offered.imageUrl,
          page_url: offered.pageUrl,
          creator: 'Someone',
          license_name: 'CC BY 2.0',
          license_url: offered.licenseUrl,
        },
      ],
      failed: ['adsbdb'],
    });

    const picks = '/admin/v1/aircraft-photos/a3e07a/picks';
    // Only photos the server offered for this airframe can be saved.
    expect((await send(app, 'POST', picks, { image_url: 'https://evil.test/x.jpg' })).status).toBe(
      404,
    );
    expect(
      (await send(app, 'POST', picks, { image_url: 'http://upload.test/full.jpg' })).status,
    ).toBe(400);
    const unknown = '/admin/v1/aircraft-photos/abcdef/picks';
    expect((await send(app, 'POST', unknown, { image_url: offered.imageUrl })).status).toBe(404);

    type Pick = {
      id: string;
      license_name: string;
      collection: { status: string; slot: unknown; best: { id: string } | null };
    };
    const saved = await send(app, 'POST', picks, { image_url: offered.imageUrl });
    expect(saved.status).toBe(201);
    const { data } = (await saved.json()) as { data: Pick };
    expect(data.license_name).toBe('CC BY 2.0');
    expect(deps.adminAssets.picks[0]).toMatchObject({ owner_id: USER_ID, icao24: 'a3e07a' });
    // The first photo of a United 737-800 fills that collection slot.
    expect(data.collection).toMatchObject({
      status: 'added',
      slot: { operator_icao: 'UAL', icao_type_code: 'B738' },
      best: { id: data.id },
    });

    // A second one keeps the existing best and returns it for comparison...
    const again = await send(app, 'POST', picks, { image_url: offered.imageUrl });
    const second = ((await again.json()) as { data: Pick }).data;
    expect(second.collection).toMatchObject({ status: 'kept_existing', best: { id: data.id } });
    // ...until the admin chooses it.
    const choose = await send(app, 'PUT', '/admin/v1/photo-collection', {
      source_image_id: second.id,
    });
    expect(choose.status).toBe(200);
    expect(((await choose.json()) as { data: unknown }).data).toMatchObject({
      operator_icao: 'UAL',
      icao_type_code: 'B738',
      best: { id: second.id, icao24: 'a3e07a' },
    });
    const missing = await send(app, 'PUT', '/admin/v1/photo-collection', {
      source_image_id: '99999999-9999-4999-8999-999999999999',
    });
    expect(missing.status).toBe(404);

    const path = `/admin/v1/aircraft-photos/picks/${data.id}`;
    expect((await send(app, 'DELETE', path)).status).toBe(200);
    expect((await send(app, 'DELETE', path)).status).toBe(404);
  });

  test('a photo of an aircraft with no known type has no collection slot', async () => {
    const { app, deps } = setup();
    deps.adminAssets.aircraftSlots.clear();
    const offered = {
      provider: 'planespotters' as const,
      thumbnailUrl: 'https://t.plnspttrs.net/1_280.jpg',
      imageUrl: 'https://t.plnspttrs.net/1_1000.jpg',
      pageUrl: 'https://www.planespotters.net/photo/1',
      creator: 'Someone',
      licenseName: null,
      licenseUrl: null,
    };
    deps.aircraftPhotos = {
      photo: async () => null,
      candidates: async () => ({ items: [offered], failed: [] }),
    };
    const res = await send(app, 'POST', '/admin/v1/aircraft-photos/a3e07a/picks', {
      image_url: offered.imageUrl,
    });
    const { data } = (await res.json()) as { data: { id: string; collection: unknown } };
    expect(data.collection).toEqual({ status: 'no_type', slot: null, best: null });
    const choose = await send(app, 'PUT', '/admin/v1/photo-collection', {
      source_image_id: data.id,
    });
    expect(choose.status).toBe(400);
  });

  test('cutouts are queued only for photos whose licence allows edited copies', async () => {
    const { app, deps } = setup();
    const image = (id: string, source_provider: string, license_name: string | null) => ({
      id,
      owner_id: USER_ID,
      owner_email: null,
      aircraft_id: null,
      aircraft_registration: null,
      aircraft_type: null,
      source_provider,
      source_page_url: null,
      original_file_url: 'https://upload.test/full.jpg',
      storage_path: null,
      creator: null,
      license_name,
      license_url: null,
      attribution_text: null,
      view_angle_score: null,
      identity_confidence: null,
      created_at: new Date().toISOString(),
      art_count: 0,
      image_url: null,
      cutout: null,
      cutout_refusal: null,
    });
    const commons = '55555555-5555-4555-8555-555555555555';
    const spotted = '66666666-6666-4666-8666-666666666666';
    deps.adminAssets.sourceImages.push(
      image(commons, 'wikimedia_commons', 'CC BY-SA 4.0'),
      image(spotted, 'planespotters', null),
    );
    const ok = await send(app, 'POST', `/admin/v1/source-images/${commons}/cutout`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { cutout: unknown } }).data.cutout).toMatchObject({
      status: 'pending',
    });
    const refused = await send(app, 'POST', `/admin/v1/source-images/${spotted}/cutout`);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(
      /Planespotters/,
    );
    const missing = await send(
      app,
      'POST',
      '/admin/v1/source-images/77777777-7777-4777-8777-777777777777/cutout',
    );
    expect(missing.status).toBe(404);
  });

  test('asset routes are admin-only', async () => {
    const { app } = setup({ admin: false });
    for (const path of [
      '/admin/v1/art-assets',
      '/admin/v1/art-coverage',
      '/admin/v1/seen-aircraft',
      '/admin/v1/aircraft-photos/a3e07a',
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
