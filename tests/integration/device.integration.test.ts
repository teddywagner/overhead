/**
 * Device enrollment and display against local Supabase: management API →
 * setup → poster binary upload + verification → display with a signed URL
 * the frame can actually download and hash-check.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BUCKETS, sha256Hex } from '@overhead/core';
import { createUserClient, type Sql } from '@overhead/database';
import { PANEL_IMAGE_BYTES } from '@overhead/device-protocol';
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

describe.skipIf(skipIntegration)('FlightPortrait device flow', () => {
  const env = ENV!;
  let sql: Sql;
  let owner: TestUser;
  let app: ReturnType<typeof makeApp>['app'];
  const mac = `aa:bb:cc:${crypto.randomUUID().slice(0, 2)}:${crypto.randomUUID().slice(0, 2)}:02`;
  let deviceId: string;
  let setupSecret: string;
  let posterId: string;
  let token: string;

  const device = (path: string, init: RequestInit = {}) => app.request(`/device/v1${path}`, init);

  beforeAll(async () => {
    sql = sqlFor(env);
    owner = await createTestUser(env, 'frame-owner');
    app = makeApp(env).app;
    const loc = await call<{ id: string }>(app, 'POST', '/api/v1/locations', owner, {
      name: 'Frame site',
      latitude: 0.3,
      longitude: 0.3,
    });
    const created = await call<{
      device: { id: string; enrollment_state: string };
      setup_secret: string;
    }>(app, 'POST', '/api/v1/devices', owner, {
      name: 'Hall',
      mac_address: mac.toUpperCase(),
      location_id: loc.body.data.id,
      poll_interval_seconds: 1800,
    });
    expect(created.status).toBe(201);
    deviceId = created.body.data.device.id;
    setupSecret = created.body.data.setup_secret;
    expect(created.body.data.device.enrollment_state).toBe('pending');

    const poster = await call<{ id: string }>(app, 'POST', '/api/v1/posters', owner, {
      location_id: loc.body.data.id,
      local_date: '2026-09-20',
      template_version: 'v0',
    });
    posterId = poster.body.data.id;
  });

  afterAll(async () => {
    await deleteTestUser(env, owner);
    await sql.close();
  });

  test('only the hash of the setup secret is stored, and it is never returned again', async () => {
    const [cred] =
      await sql`select setup_secret_hash from private.device_credentials where device_id = ${deviceId}`;
    expect(cred.setup_secret_hash).toBe(sha256Hex(setupSecret));
    const fetched = await call<Record<string, unknown>>(
      app,
      'GET',
      `/api/v1/devices/${deviceId}`,
      owner,
    );
    expect(JSON.stringify(fetched.body)).not.toContain(setupSecret);
  });

  test('setup issues a token; only its hash is stored', async () => {
    const res = await device('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac, hw_rev: 'proto-e1004', provision_secret: setupSecret }),
    });
    expect(res.status).toBe(200);
    token = ((await res.json()) as { device_token: string }).device_token;
    const [cred] = await sql`
      select token_hash, enrollment_state from private.device_credentials where device_id = ${deviceId}`;
    expect(cred.token_hash).toBe(sha256Hex(token));
    expect(cred.enrollment_state).toBe('enrolled');
  });

  test('display is 503 until a verified binary exists', async () => {
    const res = await device('/display', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(503);
  });

  test('upload, verify and serve the poster binary with its exact hash', async () => {
    const upload = await call<{ path: string; token: string; bucket: string }>(
      app,
      'POST',
      `/api/v1/posters/${posterId}/device-binary-upload-url`,
      owner,
    );
    expect(upload.status).toBe(201);
    expect(upload.body.data.bucket).toBe(BUCKETS.deviceBinaries);
    const bytes = new Uint8Array(PANEL_IMAGE_BYTES).fill(0x11);
    bytes.fill(0x00, 0, 600 * 100); // a black band so it is not trivially uniform
    const db = createUserClient(env, owner.token);
    const put = await db.storage
      .from(BUCKETS.deviceBinaries)
      .uploadToSignedUrl(
        upload.body.data.path,
        upload.body.data.token,
        new Blob([bytes], { type: 'application/octet-stream' }),
      );
    expect(put.error).toBeNull();

    const ready = await call<{ status: string; binary_sha256: string }>(
      app,
      'PATCH',
      `/api/v1/posters/${posterId}`,
      owner,
      {
        status: 'ready',
      },
    );
    expect(ready.status).toBe(200);
    expect(ready.body.data.status).toBe('ready');
    expect(ready.body.data.binary_sha256).toBe(sha256Hex(bytes));

    const res = await device('/display', {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Battery-Mv': '3900',
        'X-Rssi': '-60',
        'X-Fw-Version': '0.1.0',
        'X-Boot-Reason': 'rtc',
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      image_url: string;
      image_hash: string;
      sleep_s: number;
      firmware: null;
      reset: boolean;
    };
    expect(body.image_hash).toBe(`sha256:${sha256Hex(bytes)}`);
    expect(body.sleep_s).toBe(1800);
    expect(body.firmware).toBeNull();
    expect(body.reset).toBe(false);
    expect(body.image_url.length).toBeLessThanOrEqual(767);

    // What the frame does next: download, check size and hash.
    const image = new Uint8Array(await (await fetch(body.image_url)).arrayBuffer());
    expect(image.byteLength).toBe(PANEL_IMAGE_BYTES);
    expect(`sha256:${sha256Hex(image)}`).toBe(body.image_hash);

    const [d] =
      await sql`select battery_mv, rssi, firmware_version, last_boot_reason from public.devices where id = ${deviceId}`;
    expect(d).toMatchObject({
      battery_mv: 3900,
      rssi: -60,
      firmware_version: '0.1.0',
      last_boot_reason: 'rtc',
    });
  });

  test('an invalid binary is rejected and never served', async () => {
    const upload = await call<{ path: string; token: string }>(
      app,
      'POST',
      `/api/v1/posters/${posterId}/device-binary-upload-url`,
      owner,
    );
    const db = createUserClient(env, owner.token);
    await db.storage
      .from(BUCKETS.deviceBinaries)
      .uploadToSignedUrl(
        upload.body.data.path,
        upload.body.data.token,
        new Blob([new Uint8Array(100)]),
      );
    const res = await call(app, 'PATCH', `/api/v1/posters/${posterId}`, owner, { status: 'ready' });
    expect(res.status).toBe(400);
    const display = await device('/display', { headers: { Authorization: `Bearer ${token}` } });
    expect(display.status).toBe(503);
  });

  test('reset requests reach the frame; re-setup rotates the token and clears reset', async () => {
    // Re-verify a valid binary so display returns 200 again.
    const upload = await call<{ path: string; token: string }>(
      app,
      'POST',
      `/api/v1/posters/${posterId}/device-binary-upload-url`,
      owner,
    );
    const db = createUserClient(env, owner.token);
    await db.storage
      .from(BUCKETS.deviceBinaries)
      .uploadToSignedUrl(
        upload.body.data.path,
        upload.body.data.token,
        new Blob([new Uint8Array(PANEL_IMAGE_BYTES).fill(0x22)]),
      );
    expect(
      (await call(app, 'PATCH', `/api/v1/posters/${posterId}`, owner, { status: 'ready' })).status,
    ).toBe(200);

    expect(
      (await call(app, 'POST', `/api/v1/devices/${deviceId}/request-reset`, owner)).status,
    ).toBe(200);
    const display = await device('/display', { headers: { Authorization: `Bearer ${token}` } });
    expect(((await display.json()) as { reset: boolean }).reset).toBe(true);

    const again = await device('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac, provision_secret: setupSecret }),
    });
    const newToken = ((await again.json()) as { device_token: string }).device_token;
    expect(
      (await device('/display', { headers: { Authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
    const fresh = await device('/display', { headers: { Authorization: `Bearer ${newToken}` } });
    expect(((await fresh.json()) as { reset: boolean }).reset).toBe(false);
    token = newToken;
  });

  test('logs are stored against the device, bounded and sanitised', async () => {
    const res = await device('/log', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        logs: [{ message: 'wifi connect failed', level: 'warn', ts: 1789700000 }],
      }),
    });
    expect(res.status).toBe(200);
    const rows =
      await sql`select level, message from private.device_logs where device_id = ${deviceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 'warn', message: 'wifi connect failed' });
  });

  test('rotating the setup secret invalidates the old one', async () => {
    const rotated = await call<{ setup_secret: string }>(
      app,
      'POST',
      `/api/v1/devices/${deviceId}/rotate-setup-secret`,
      owner,
      { revoke_token: true },
    );
    expect(rotated.status).toBe(200);
    const old = await device('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac, provision_secret: setupSecret }),
    });
    expect(old.status).toBe(401);
    expect(
      (await device('/display', { headers: { Authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
  });

  test('retention runs and reports per-table counts', async () => {
    const rows = await sql`select * from private.apply_retention()`;
    expect(rows.map((r: { table_name: string }) => r.table_name).sort()).toEqual([
      'device_logs',
      'enrichment_attempts',
      'overflight_points',
      'provider_poll_runs',
      'worker_errors',
    ]);
  });
});
