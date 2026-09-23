import { OpenAPIHono, z } from '@hono/zod-openapi';
import { sha256Hex } from '@overhead/core';
import {
  DisplayContractError,
  MAX_LOG_BATCH,
  buildDisplayResponse,
  credentialMatches,
  generateDeviceToken,
  hashCredential,
  logBodySchema,
  normalizeMac,
  parseBearer,
  parseTelemetry,
  sanitizeDeviceLogMessage,
  setupBodySchema,
  validatePairingFields,
} from '@overhead/device-protocol';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../lib/context';
import { LIMITS } from '../lib/rate-limit';
import { clientIp } from '../middleware';
import type { DeviceAuthRecord } from '../trusted-repo';

/**
 * FlightPortrait-compatible device endpoints. Wire format follows
 * docs/PROTOCOL.md exactly: bare JSON bodies (no envelope), errors as
 * {"detail": "..."}, and the status codes the firmware expects.
 */

/** Button press opens a short "live window" of faster polls. */
export const LIVE_WINDOW_SLEEP_S = 300;
/** Below this battery voltage the frame is asked to wake once a day. */
export const LOW_BATTERY_MV = 3500;
export const LOW_BATTERY_SLEEP_S = 86_400;

const detail = (
  c: Context<AppEnv>,
  status: 400 | 401 | 404 | 413 | 422 | 429 | 500 | 503,
  message: string,
) => c.json({ detail: message }, status);

// A fixed dummy hash keeps unknown-MAC rejections as slow as wrong-secret ones.
const DUMMY_HASH = sha256Hex('overhead-dummy-setup-secret');

function limited(c: Context<AppEnv>, key: string, limit: number, windowS: number): Response | null {
  const r = c.get('deps').rateLimiter.hit(key, limit, windowS);
  if (r.allowed) return null;
  c.header('Retry-After', String(r.retryAfterS));
  return detail(c, 429, 'rate limited');
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

async function authenticate(c: Context<AppEnv>): Promise<DeviceAuthRecord | Response> {
  const token = parseBearer(c.req.header('authorization'));
  if (!token) return detail(c, 401, 'unknown token');
  const tokenHash = sha256Hex(token);
  const deps = c.get('deps');
  const perToken = limited(
    c,
    `display:${tokenHash}`,
    LIMITS.deviceDisplay.limit,
    LIMITS.deviceDisplay.windowS,
  );
  if (perToken) return perToken;
  const device = await deps.trusted.authenticateDevice(tokenHash);
  if (!device) return detail(c, 401, 'unknown token');
  c.set('deviceId', device.deviceId);
  return device;
}

export const deviceProtocolRouter = new OpenAPIHono<AppEnv>();

const tooLarge = (c: Context<AppEnv>) => detail(c, 413, 'body too large');
deviceProtocolRouter.use('/setup', bodyLimit({ maxSize: 4 * 1024, onError: tooLarge }));
deviceProtocolRouter.use('/log', bodyLimit({ maxSize: 32 * 1024, onError: tooLarge }));
deviceProtocolRouter.use('*', async (c, next) => {
  const ip = clientIp(c);
  const r = limited(
    c,
    `device-ip:${ip}`,
    LIMITS.deviceDisplayIp.limit,
    LIMITS.deviceDisplayIp.windowS,
  );
  if (r) return r;
  await next();
});

// ---------------------------------------------------------------------------
// POST /device/v1/setup
// ---------------------------------------------------------------------------
deviceProtocolRouter.post('/setup', async (c) => {
  const deps = c.get('deps');
  const ipLimited = limited(
    c,
    `setup-ip:${clientIp(c)}`,
    LIMITS.deviceSetupIp.limit,
    LIMITS.deviceSetupIp.windowS,
  );
  if (ipLimited) return ipLimited;

  const parsed = setupBodySchema.safeParse(await readJson(c));
  if (!parsed.success) return detail(c, 422, 'bad body');
  const body = parsed.data;
  const pairingProblem = validatePairingFields(body);
  if (pairingProblem) return detail(c, 400, pairingProblem);
  const mac = normalizeMac(body.mac);
  if (!mac) return detail(c, 422, 'bad body');

  const macLimited = limited(
    c,
    `setup-mac:${mac}`,
    LIMITS.deviceSetupMac.limit,
    LIMITS.deviceSetupMac.windowS,
  );
  if (macLimited) return macLimited;

  const candidate = await deps.trusted.findSetupCandidate(mac);
  const matches = credentialMatches(
    body.provision_secret,
    candidate?.setupSecretHash ?? DUMMY_HASH,
  );
  if (!candidate || !matches) {
    if (candidate) await deps.trusted.recordFailedSetup(candidate.deviceId);
    deps.logger.warn('device setup rejected', {
      request_id: c.get('requestId'),
      known_device: Boolean(candidate),
    });
    return detail(c, 401, 'bad secret');
  }

  // Fresh 256-bit bearer; only its SHA-256 is stored. Any previous token is
  // replaced atomically and stops working immediately.
  const token = generateDeviceToken();
  await deps.trusted.completeSetup(
    candidate.deviceId,
    hashCredential(token),
    body.hw_rev?.trim() || null,
  );
  c.set('deviceId', candidate.deviceId);
  deps.logger.info('device setup complete', {
    request_id: c.get('requestId'),
    device_id: candidate.deviceId,
  });
  // Pairing is a first-party extension: a BYOS server returns only the token.
  return c.json({ device_token: token }, 200);
});

// ---------------------------------------------------------------------------
// GET /device/v1/display
// ---------------------------------------------------------------------------
deviceProtocolRouter.get('/display', async (c) => {
  const deps = c.get('deps');
  const auth = await authenticate(c);
  if (auth instanceof Response) return auth;
  const device = auth;

  const telemetry = parseTelemetry((name) => c.req.header(name));
  await deps.trusted.recordTelemetry(device.deviceId, telemetry);

  const poster = await deps.trusted.findServablePoster(device);
  if (!poster) {
    // Protocol: 503 = render temporarily unavailable; firmware backs off and retries.
    return detail(c, 503, 'no poster available');
  }
  const url = await deps.trusted.signDeviceBinaryUrl(
    poster.devicePath,
    deps.env.DEVICE_SIGNED_URL_TTL_SECONDS,
  );
  if (!url) {
    deps.logger.error('could not sign device binary url', {
      request_id: c.get('requestId'),
      device_id: device.deviceId,
    });
    return detail(c, 503, 'image temporarily unavailable');
  }

  let sleepS = device.pollIntervalSeconds;
  if (telemetry.bootReason === 'button') sleepS = Math.min(sleepS, LIVE_WINDOW_SLEEP_S);
  if (telemetry.batteryMv !== null && telemetry.batteryMv < LOW_BATTERY_MV)
    sleepS = Math.max(sleepS, LOW_BATTERY_SLEEP_S);

  try {
    return c.json(
      buildDisplayResponse({
        imageUrl: url,
        sha256: poster.sha256,
        sleepS,
        reset: device.resetRequested,
      }),
      200,
    );
  } catch (err) {
    if (err instanceof DisplayContractError) {
      deps.logger.error('display response violates firmware contract', {
        request_id: c.get('requestId'),
        device_id: device.deviceId,
        reason: err.message,
      });
      return detail(c, 503, 'image temporarily unavailable');
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// POST /device/v1/log
// ---------------------------------------------------------------------------
deviceProtocolRouter.post('/log', async (c) => {
  const deps = c.get('deps');
  const token = parseBearer(c.req.header('authorization'));
  if (!token) return detail(c, 401, 'unknown token');
  const tokenHash = sha256Hex(token);
  const perToken = limited(c, `log:${tokenHash}`, LIMITS.deviceLog.limit, LIMITS.deviceLog.windowS);
  if (perToken) return perToken;
  const device = await deps.trusted.authenticateDevice(tokenHash);
  if (!device) return detail(c, 401, 'unknown token');
  c.set('deviceId', device.deviceId);

  const parsed = logBodySchema.safeParse(await readJson(c));
  if (!parsed.success) return detail(c, 422, 'bad body');
  const telemetry = parseTelemetry((name) => c.req.header(name));
  await deps.trusted.recordTelemetry(device.deviceId, telemetry);
  await deps.trusted.insertDeviceLogs(
    device.deviceId,
    telemetry.firmwareVersion,
    parsed.data.logs.map((l) => ({
      level: l.level,
      message: sanitizeDeviceLogMessage(l.message),
      ts: l.ts === undefined ? null : new Date(l.ts * 1000),
    })),
  );
  return c.json({ ok: true }, 200);
});

// ---------------------------------------------------------------------------
// OpenAPI documentation for the device protocol
// ---------------------------------------------------------------------------
const detailSchema = z.object({ detail: z.string() }).openapi('DeviceError');
const deviceErr = (description: string) => ({
  description,
  content: { 'application/json': { schema: detailSchema } },
});
const telemetryHeaders = z.object({
  'X-Battery-Mv': z.string().optional().openapi({ example: '3941' }),
  'X-Rssi': z.string().optional().openapi({ example: '-61' }),
  'X-Fw-Version': z.string().optional().openapi({ example: '0.1.0' }),
  'X-Boot-Reason': z.enum(['rtc', 'power-on', 'button', 'pairing']).optional(),
});

deviceProtocolRouter.openAPIRegistry.registerPath({
  method: 'post',
  path: '/setup',
  tags: ['Device protocol'],
  summary: 'First connected setup (FlightPortrait-compatible, pairing-free BYOS form)',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            mac: z.string().openapi({ example: 'aa:bb:cc:dd:ee:ff' }),
            hw_rev: z.string().optional(),
            provision_secret: z.string(),
            pairing_public_key: z.string().optional(),
            pairing_counter: z.number().int().optional(),
            pairing_nonce_hash: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Fresh bearer token (64 lowercase hex). Only its hash is stored.',
      content: { 'application/json': { schema: z.object({ device_token: z.string() }) } },
    },
    400: deviceErr('Malformed pairing registration fields'),
    401: deviceErr('Unknown MAC or wrong setup secret'),
    422: deviceErr('Missing or ill-typed body fields'),
    429: deviceErr('Rate limited'),
  },
});

deviceProtocolRouter.openAPIRegistry.registerPath({
  method: 'get',
  path: '/display',
  tags: ['Device protocol'],
  summary: 'Every wake: current poster binary via short-lived signed URL',
  security: [{ deviceBearer: [] }],
  request: { headers: telemetryHeaders },
  responses: {
    200: {
      description: 'Display instructions',
      content: {
        'application/json': {
          schema: z.object({
            image_url: z.string(),
            image_hash: z.string().openapi({ example: `sha256:${'0'.repeat(64)}` }),
            sleep_s: z.number().int(),
            firmware: z.null(),
            reset: z.boolean(),
          }),
        },
      },
    },
    401: deviceErr('Unknown or rotated token'),
    429: deviceErr('Rate limited'),
    503: deviceErr('No verified poster binary is available yet; the frame backs off and retries'),
  },
});

deviceProtocolRouter.openAPIRegistry.registerPath({
  method: 'post',
  path: '/log',
  tags: ['Device protocol'],
  summary: `Batched device logs (max ${MAX_LOG_BATCH} entries)`,
  security: [{ deviceBearer: [] }],
  request: {
    headers: telemetryHeaders,
    body: { content: { 'application/json': { schema: logBodySchema } } },
  },
  responses: {
    200: {
      description: 'Accepted',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: deviceErr('Unknown token'),
    422: deviceErr('Invalid body'),
    429: deviceErr('Rate limited'),
  },
});
