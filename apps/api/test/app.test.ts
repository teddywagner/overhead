import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { VALID_TOKEN, makeDeps } from './fakes';

const auth = { Authorization: `Bearer ${VALID_TOKEN}` };

describe('system endpoints', () => {
  test('GET /health returns an envelope, request id and security headers', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { status: string; name: string };
      error: null;
      request_id: string;
    };
    expect(body.data.status).toBe('ok');
    expect(body.data.name).toBe('Overhead');
    expect(body.error).toBeNull();
    expect(body.request_id).toBe(res.headers.get('x-request-id')!);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('a well-formed inbound X-Request-Id is propagated', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/health', { headers: { 'X-Request-Id': 'abc12345-trace' } });
    expect(res.headers.get('x-request-id')).toBe('abc12345-trace');
    const bad = await app.request('/health', { headers: { 'X-Request-Id': 'bad id!<script>' } });
    expect(bad.headers.get('x-request-id')).not.toBe('bad id!<script>');
  });

  test('GET /ready reports database failures without leaking details', async () => {
    const app = createApp(makeDeps({ checkDatabase: async () => false }));
    const res = await app.request('/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_ready');
    expect(JSON.stringify(body)).not.toContain('postgres');
  });

  test('GET /ready succeeds when the database responds', async () => {
    const res = await createApp(makeDeps()).request('/ready');
    expect(res.status).toBe(200);
  });

  test('GET /openapi.json documents every endpoint', async () => {
    const res = await createApp(makeDeps()).request('/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    const expected: Array<[string, string]> = [
      ['/health', 'get'],
      ['/ready', 'get'],
      ['/api/v1/locations', 'get'],
      ['/api/v1/locations', 'post'],
      ['/api/v1/locations/{id}', 'get'],
      ['/api/v1/locations/{id}', 'patch'],
      ['/api/v1/locations/{id}', 'delete'],
      ['/api/v1/aircraft', 'get'],
      ['/api/v1/aircraft/{id}', 'get'],
      ['/api/v1/aircraft/{id}', 'patch'],
      ['/api/v1/overflights', 'get'],
      ['/api/v1/overflights/{id}', 'get'],
      ['/api/v1/overflights/{id}/points', 'get'],
      ['/api/v1/hangar', 'get'],
      ['/api/v1/hangar/{aircraft_id}', 'get'],
      ['/api/v1/source-images', 'get'],
      ['/api/v1/source-images', 'post'],
      ['/api/v1/source-images/{id}', 'get'],
      ['/api/v1/source-images/{id}', 'patch'],
      ['/api/v1/source-images/{id}', 'delete'],
      ['/api/v1/source-images/upload-url', 'post'],
      ['/api/v1/art-assets', 'get'],
      ['/api/v1/art-assets', 'post'],
      ['/api/v1/art-assets/{id}', 'get'],
      ['/api/v1/art-assets/{id}', 'patch'],
      ['/api/v1/art-assets/{id}', 'delete'],
      ['/api/v1/art-assets/upload-url', 'post'],
      ['/api/v1/art-assets/{id}/approve', 'post'],
      ['/api/v1/art-assets/{id}/reject', 'post'],
      ['/api/v1/posters', 'get'],
      ['/api/v1/posters', 'post'],
      ['/api/v1/posters/{id}', 'get'],
      ['/api/v1/posters/{id}', 'patch'],
      ['/api/v1/posters/{id}', 'delete'],
      ['/api/v1/posters/{id}/items', 'post'],
      ['/api/v1/posters/{id}/device-binary-upload-url', 'post'],
      ['/api/v1/devices', 'get'],
      ['/api/v1/devices', 'post'],
      ['/api/v1/devices/{id}', 'get'],
      ['/api/v1/devices/{id}', 'patch'],
      ['/api/v1/devices/{id}', 'delete'],
      ['/api/v1/devices/{id}/rotate-setup-secret', 'post'],
      ['/api/v1/devices/{id}/request-reset', 'post'],
      ['/device/v1/setup', 'post'],
      ['/device/v1/display', 'get'],
      ['/device/v1/log', 'post'],
    ];
    for (const [path, method] of expected) {
      expect(doc.paths[path]?.[method], `${method.toUpperCase()} ${path}`).toBeDefined();
    }
    expect(doc.components.securitySchemes.bearerAuth).toBeDefined();
    expect(doc.components.securitySchemes.deviceBearer).toBeDefined();
  });

  test('unknown routes return a 404 envelope', async () => {
    const res = await createApp(makeDeps()).request('/nope');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });
});

describe('/api/v1 authentication and validation', () => {
  test('missing token → 401 envelope', async () => {
    const res = await createApp(makeDeps()).request('/api/v1/locations');
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      data: null;
      error: { code: string; message: string };
      request_id: string;
    };
    expect(body.data).toBeNull();
    expect(body.error.code).toBe('unauthorized');
    expect(body.request_id).toBeTruthy();
  });

  test('invalid token → 401', async () => {
    const res = await createApp(makeDeps()).request('/api/v1/overflights', {
      headers: { Authorization: 'Bearer not-a-real-token-but-long-enough' },
    });
    expect(res.status).toBe(401);
  });

  test('request validation errors use the envelope with field details', async () => {
    const res = await createApp(makeDeps()).request('/api/v1/locations', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', latitude: 123, longitude: 0 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: Array<{ path: string }> };
    };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.some((d) => d.path === 'latitude')).toBe(true);
  });

  test('unknown fields are rejected (strict bodies)', async () => {
    const res = await createApp(makeDeps()).request('/api/v1/locations', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', latitude: 1, longitude: 1, owner_id: 'someone-else' }),
    });
    expect(res.status).toBe(400);
  });

  test('malformed ids and cursors are rejected before reaching the database', async () => {
    const app = createApp(makeDeps());
    expect((await app.request('/api/v1/locations/not-a-uuid', { headers: auth })).status).toBe(400);
    expect((await app.request('/api/v1/locations?cursor=%%%', { headers: auth })).status).toBe(400);
  });

  test('oversized bodies are rejected with 413', async () => {
    const deps = makeDeps();
    deps.env.API_BODY_LIMIT_BYTES = 128;
    const res = await createApp(deps).request('/api/v1/locations', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(500), latitude: 1, longitude: 1 }),
    });
    expect(res.status).toBe(413);
  });

  test('tokens never appear in logs', async () => {
    const deps = makeDeps();
    await createApp(deps).request('/api/v1/locations/not-a-uuid', { headers: auth });
    expect(deps.logLines.length).toBeGreaterThan(0);
    expect(deps.logLines.join('\n')).not.toContain(VALID_TOKEN);
  });
});

describe('CORS', () => {
  test('allowlisted origins receive CORS headers; others do not', async () => {
    const app = createApp(makeDeps());
    const allowed = await app.request('/api/v1/locations', {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.example.test', 'Access-Control-Request-Method': 'GET' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    const denied = await app.request('/api/v1/locations', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('rate limiting', () => {
  test('system endpoints are rate limited', async () => {
    const app = createApp(makeDeps());
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await app.request('/health')).status;
    expect(last).toBe(429);
  });
});
