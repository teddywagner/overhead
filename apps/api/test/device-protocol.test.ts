import { describe, expect, test } from 'bun:test';
import { sha256Hex } from '@overhead/core';
import { hashCredential } from '@overhead/device-protocol';
import { createApp } from '../src/app';
import { makeDeps } from './fakes';

const SECRET = 'ovh_test-setup-secret';
const MAC = 'aa:bb:cc:00:00:01';
const DEVICE_ID = '77777777-0000-4000-8000-000000000001';
const SHA = 'ab'.repeat(32);

function setupApp() {
  const deps = makeDeps();
  deps.trusted.addDevice({ id: DEVICE_ID, mac: MAC, setupSecretHash: hashCredential(SECRET) });
  return { deps, app: createApp(deps) };
}

const post = (
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function enroll(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await post(app, '/device/v1/setup', {
    mac: MAC,
    hw_rev: 'proto-e1004',
    provision_secret: SECRET,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { device_token: string }).device_token;
}

describe('POST /device/v1/setup', () => {
  test('issues a 64-hex bearer token and stores only its hash', async () => {
    const { app, deps } = setupApp();
    const res = await post(app, '/device/v1/setup', {
      mac: 'AA-BB-CC-00-00-01',
      provision_secret: SECRET,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Pairing-free BYOS response: exactly one field.
    expect(Object.keys(body)).toEqual(['device_token']);
    const token = body.device_token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const device = deps.trusted.devices.get(DEVICE_ID)!;
    expect(device.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify([...deps.trusted.devices.values()])).not.toContain(token);
  });

  test('wrong secret and unknown MAC are both 401', async () => {
    const { app, deps } = setupApp();
    const wrong = await post(app, '/device/v1/setup', { mac: MAC, provision_secret: 'nope' });
    expect(wrong.status).toBe(401);
    expect(deps.trusted.devices.get(DEVICE_ID)!.failedSetups).toBe(1);
    const unknown = await post(app, '/device/v1/setup', {
      mac: 'aa:bb:cc:99:99:99',
      provision_secret: SECRET,
    });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ detail: 'bad secret' });
  });

  test('missing, ill-typed or unparsable bodies are 422', async () => {
    const { app } = setupApp();
    expect((await post(app, '/device/v1/setup', { mac: MAC })).status).toBe(422);
    expect(
      (await post(app, '/device/v1/setup', { mac: 42, provision_secret: SECRET })).status,
    ).toBe(422);
    expect((await post(app, '/device/v1/setup', '{not json')).status).toBe(422);
    expect(
      (await post(app, '/device/v1/setup', { mac: 'zz', provision_secret: SECRET })).status,
    ).toBe(422);
  });

  test('malformed pairing fields are 400; valid pairing fields are accepted without pairing ack', async () => {
    const { app } = setupApp();
    const bad = await post(app, '/device/v1/setup', {
      mac: MAC,
      provision_secret: SECRET,
      pairing_public_key: 'x',
      pairing_counter: 1.5,
      pairing_nonce_hash: 'nothex',
    });
    expect(bad.status).toBe(400);
    const good = await post(app, '/device/v1/setup', {
      mac: MAC,
      provision_secret: SECRET,
      pairing_public_key: 'B'.repeat(87),
      pairing_counter: 1,
      pairing_nonce_hash: 'a'.repeat(64),
    });
    expect(good.status).toBe(200);
    expect(Object.keys((await good.json()) as object)).toEqual(['device_token']);
  });

  test('re-setup rotates the token: the old one stops working immediately', async () => {
    const { app } = setupApp();
    const first = await enroll(app);
    const second = await enroll(app);
    expect(second).not.toBe(first);
    const old = await app.request('/device/v1/display', {
      headers: { Authorization: `Bearer ${first}` },
    });
    expect(old.status).toBe(401);
    const current = await app.request('/device/v1/display', {
      headers: { Authorization: `Bearer ${second}` },
    });
    expect(current.status).toBe(503); // authenticated, but no poster yet
  });

  test('setup attempts are rate limited per MAC', async () => {
    const { app } = setupApp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(
        (await post(app, '/device/v1/setup', { mac: MAC, provision_secret: 'wrong' })).status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  test('setup secrets and tokens never reach logs', async () => {
    const { app, deps } = setupApp();
    const token = await enroll(app);
    await post(app, '/device/v1/setup', { mac: MAC, provision_secret: 'wrong-secret-value' });
    const logs = deps.logLines.join('\n');
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain('wrong-secret-value');
    expect(logs).not.toContain(token);
  });
});

describe('GET /device/v1/display', () => {
  test('401 without or with an unknown bearer token', async () => {
    const { app } = setupApp();
    expect((await app.request('/device/v1/display')).status).toBe(401);
    const res = await app.request('/device/v1/display', {
      headers: { Authorization: `Bearer ${'0'.repeat(64)}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'unknown token' });
  });

  test('503 (protocol "render unavailable") when no verified binary exists', async () => {
    const { app } = setupApp();
    const token = await enroll(app);
    const res = await app.request('/device/v1/display', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ detail: 'no poster available' });
  });

  test('serves a short-lived signed URL, exact sha256, sleep and reset; records telemetry', async () => {
    const { app, deps } = setupApp();
    const token = await enroll(app);
    deps.trusted.posters.push({
      posterId: '66666666-0000-4000-8000-000000000001',
      devicePath: `${deps.trusted.devices.get(DEVICE_ID)!.ownerId}/bin/poster.bin`,
      sha256: SHA,
      ownerId: '11111111-1111-4111-8111-111111111111',
      locationId: '22222222-2222-4222-8222-222222222222',
    });
    deps.trusted.devices.get(DEVICE_ID)!.resetRequested = true;
    const res = await app.request('/device/v1/display', {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Battery-Mv': '3941',
        'X-Rssi': '-61',
        'X-Fw-Version': '0.1.0',
        'X-Boot-Reason': 'rtc',
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'firmware',
      'image_hash',
      'image_url',
      'reset',
      'sleep_s',
    ]);
    expect(body.image_hash).toBe(`sha256:${SHA}`);
    expect(body.image_url).toMatch(/^https?:\/\//);
    expect(body.sleep_s).toBe(3600);
    expect(body.firmware).toBeNull();
    expect(body.reset).toBe(true);
    expect(deps.trusted.signedTtl).toBe(300);
    expect(deps.trusted.devices.get(DEVICE_ID)!.telemetry).toEqual({
      batteryMv: 3941,
      rssi: -61,
      firmwareVersion: '0.1.0',
      bootReason: 'rtc',
    });
  });

  test('button wakes get a short live-window sleep; low battery sleeps a day', async () => {
    const { app, deps } = setupApp();
    const token = await enroll(app);
    deps.trusted.posters.push({
      posterId: 'p',
      devicePath: 'x/bin/p.bin',
      sha256: SHA,
      ownerId: '11111111-1111-4111-8111-111111111111',
      locationId: '22222222-2222-4222-8222-222222222222',
    });
    const button = await app.request('/device/v1/display', {
      headers: { Authorization: `Bearer ${token}`, 'X-Boot-Reason': 'button' },
    });
    expect(((await button.json()) as { sleep_s: number }).sleep_s).toBe(300);
    const low = await app.request('/device/v1/display', {
      headers: { Authorization: `Bearer ${token}`, 'X-Battery-Mv': '3300' },
    });
    expect(((await low.json()) as { sleep_s: number }).sleep_s).toBe(86_400);
  });

  test('a signed URL too long for the firmware buffer yields 503, never a truncated URL', async () => {
    const { app, deps } = setupApp();
    const token = await enroll(app);
    deps.trusted.posters.push({
      posterId: 'p',
      devicePath: 'x/bin/p.bin',
      sha256: SHA,
      ownerId: '11111111-1111-4111-8111-111111111111',
      locationId: '22222222-2222-4222-8222-222222222222',
    });
    deps.trusted.signedUrlOverride = `https://example.test/${'a'.repeat(800)}`;
    const res = await app.request('/device/v1/display', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(503);
  });
});

describe('POST /device/v1/log', () => {
  test('accepts a bounded batch, sanitises and associates logs with the device', async () => {
    const { app, deps } = setupApp();
    const token = await enroll(app);
    const res = await post(
      app,
      '/device/v1/log',
      {
        logs: [
          { message: 'wifi connect failed', level: 'warn', ts: 1789700000 },
          { message: `token=${token} leaked` },
        ],
      },
      { Authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deps.trusted.logs).toHaveLength(2);
    expect(deps.trusted.logs[0]).toMatchObject({
      deviceId: DEVICE_ID,
      level: 'warn',
      message: 'wifi connect failed',
    });
    expect(deps.trusted.logs[0]!.ts?.toISOString()).toBe(new Date(1789700000 * 1000).toISOString());
    expect(deps.trusted.logs[1]!.level).toBe('error');
    expect(deps.trusted.logs[1]!.message).not.toContain(token);
  });

  test('rejects invalid levels, oversized messages and oversized batches', async () => {
    const { app } = setupApp();
    const token = await enroll(app);
    const h = { Authorization: `Bearer ${token}` };
    expect(
      (await post(app, '/device/v1/log', { logs: [{ message: 'x', level: 'fatal' }] }, h)).status,
    ).toBe(422);
    expect(
      (await post(app, '/device/v1/log', { logs: [{ message: 'x'.repeat(513) }] }, h)).status,
    ).toBe(422);
    const many = Array.from({ length: 33 }, () => ({ message: 'x' }));
    expect((await post(app, '/device/v1/log', { logs: many }, h)).status).toBe(422);
  });

  test('requires a valid device token', async () => {
    const { app } = setupApp();
    expect((await post(app, '/device/v1/log', { logs: [] })).status).toBe(401);
  });

  test('is rate limited per device', async () => {
    const { app } = setupApp();
    const token = await enroll(app);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await post(app, '/device/v1/log', { logs: [] }, { Authorization: `Bearer ${token}` }))
        .status;
    }
    expect(last).toBe(429);
  });
});
