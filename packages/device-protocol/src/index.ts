import { randomBase64Url, randomHex, sha256Hex, timingSafeEqualString } from '@overhead/core';
import { z } from 'zod';

/**
 * FlightPortrait-compatible device protocol, supported subset.
 * Source: https://github.com/flightportrait/frame docs/PROTOCOL.md (CC-BY-4.0)
 * and examples/byos_server.py (Apache-2.0). See docs/device-protocol.md.
 *
 * Supported: POST /device/v1/setup (pairing-free BYOS form),
 *            GET /device/v1/display, POST /device/v1/log.
 * Not supported: account-pairing extension, OTA firmware offers.
 */

/** Panel image: 1200×1600 Spectra 6, 4 bpp, no header. */
export const PANEL_WIDTH = 1200;
export const PANEL_HEIGHT = 1600;
export const PANEL_IMAGE_BYTES = 960_000;

/** Firmware copies image_url into a 768-byte buffer (NUL-terminated). */
export const MAX_IMAGE_URL_LENGTH = 767;
export const MAX_SLEEP_S = 2 ** 32 - 1;

export const BOOT_REASONS = ['rtc', 'power-on', 'button', 'pairing'] as const;
export type BootReason = (typeof BOOT_REASONS)[number] | 'unknown';

const hex64 = /^[0-9a-f]{64}$/;

export function normalizeMac(mac: string): string | null {
  const hex = mac
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  if (!/^([0-9a-f]{2}[:-]?){5}[0-9a-f]{2}$/.test(mac.trim().toLowerCase())) return null;
  return hex.match(/.{2}/g)!.join(':');
}

/** Pairing fields are an optional first-party extension; validated when present. */
const pairingFields = {
  pairing_public_key: z
    .string()
    .regex(/^[A-Za-z0-9_-]{87}$/, 'pairing_public_key must be base64url-no-pad of 65 bytes')
    .optional(),
  pairing_counter: z.number().int().min(1).max(MAX_SLEEP_S).optional(),
  pairing_nonce_hash: z
    .string()
    .regex(hex64, 'pairing_nonce_hash must be 64 lowercase hex')
    .optional(),
};

/** Body shape; type errors map to 422 per the protocol. */
export const setupBodySchema = z.object({
  mac: z.string().min(1).max(32),
  hw_rev: z.string().max(60).optional(),
  provision_secret: z.string().min(1).max(512),
  pairing_public_key: z.unknown().optional(),
  pairing_counter: z.unknown().optional(),
  pairing_nonce_hash: z.unknown().optional(),
});

export type SetupBody = z.infer<typeof setupBodySchema>;

/** Returns an error message when present pairing fields are malformed (→ 400). */
export function validatePairingFields(body: SetupBody): string | null {
  const present = ['pairing_public_key', 'pairing_counter', 'pairing_nonce_hash'].filter(
    (k) => body[k as keyof SetupBody] !== undefined,
  );
  if (present.length === 0) return null;
  if (present.length !== 3) return 'pairing fields must be supplied together';
  const parsed = z.object(pairingFields).safeParse(body);
  return parsed.success ? null : 'invalid pairing registration fields';
}

export interface SetupResponse {
  device_token: string;
}

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const MAX_LOG_BATCH = 32;
export const MAX_LOG_MESSAGE_LENGTH = 512;

export const logBodySchema = z.object({
  logs: z
    .array(
      z.object({
        message: z.string().min(1).max(MAX_LOG_MESSAGE_LENGTH),
        level: z.enum(LOG_LEVELS).default('error'),
        ts: z.number().int().min(0).max(4_102_444_800).optional(),
      }),
    )
    .max(MAX_LOG_BATCH),
});

export type LogBody = z.infer<typeof logBodySchema>;

/**
 * Scrub anything that looks like a credential from device log messages
 * before storage. Firmware sends fixed strings, but never trust that.
 */
export function sanitizeDeviceLogMessage(message: string): string {
  return (
    message
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\b[0-9a-f]{64}\b/gi, '[redacted-hex]')
      .replace(/(secret|token|password|authorization)\s*[=:]\s*\S+/gi, '$1=[redacted]')
      .slice(0, MAX_LOG_MESSAGE_LENGTH)
  );
}

export interface Telemetry {
  batteryMv: number | null;
  rssi: number | null;
  firmwareVersion: string | null;
  bootReason: BootReason | null;
}

function intHeader(v: string | null | undefined, min: number, max: number): number | null {
  if (!v || !/^-?\d{1,6}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n >= min && n <= max ? n : null;
}

export function parseTelemetry(get: (name: string) => string | null | undefined): Telemetry {
  const fw = get('x-fw-version')?.trim();
  const boot = get('x-boot-reason')?.trim().toLowerCase();
  return {
    batteryMv: intHeader(get('x-battery-mv'), 0, 10_000),
    rssi: intHeader(get('x-rssi'), -150, 20),
    firmwareVersion: fw && /^[A-Za-z0-9._+-]{1,40}$/.test(fw) ? fw : null,
    bootReason: boot
      ? (BOOT_REASONS as readonly string[]).includes(boot)
        ? (boot as BootReason)
        : 'unknown'
      : null,
  };
}

export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer ([0-9a-f]{64})$/.exec(header.trim());
  return m ? m[1]! : null;
}

/** 256-bit bearer token, 64 lowercase hex, as the firmware requires. */
export const generateDeviceToken = (): string => randomHex(32);

/** Setup secret entered in BLE provisioning (1–159 bytes allowed by firmware). */
export const generateSetupSecret = (): string => `ovh_${randomBase64Url(24)}`;

export const hashCredential = (plaintext: string): string => sha256Hex(plaintext);

export const credentialMatches = (plaintext: string, storedHash: string): boolean =>
  timingSafeEqualString(sha256Hex(plaintext), storedHash);

export interface DisplayResponse {
  image_url: string;
  image_hash: string;
  sleep_s: number;
  firmware: null;
  reset: boolean;
}

export class DisplayContractError extends Error {}

/** Build a /display body that satisfies every firmware-side validation rule. */
export function buildDisplayResponse(input: {
  imageUrl: string;
  sha256: string;
  sleepS: number;
  reset: boolean;
}): DisplayResponse {
  if (!/^https?:\/\/\S+$/.test(input.imageUrl))
    throw new DisplayContractError('image_url must be http(s)');
  if (input.imageUrl.length > MAX_IMAGE_URL_LENGTH) {
    throw new DisplayContractError(`image_url exceeds ${MAX_IMAGE_URL_LENGTH} bytes`);
  }
  if (!hex64.test(input.sha256)) throw new DisplayContractError('sha256 must be 64 lowercase hex');
  const sleepS = Math.round(input.sleepS);
  if (!Number.isInteger(sleepS) || sleepS < 1 || sleepS > MAX_SLEEP_S) {
    throw new DisplayContractError('sleep_s out of range');
  }
  return {
    image_url: input.imageUrl,
    image_hash: `sha256:${input.sha256}`,
    sleep_s: sleepS,
    firmware: null,
    reset: input.reset,
  };
}

/** Validate an uploaded panel binary and return its sha256. */
export function verifyPanelBinary(
  bytes: Uint8Array,
): { ok: true; sha256: string } | { ok: false; error: string } {
  if (bytes.byteLength !== PANEL_IMAGE_BYTES) {
    return {
      ok: false,
      error: `binary must be exactly ${PANEL_IMAGE_BYTES} bytes (got ${bytes.byteLength})`,
    };
  }
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    const hi = b >> 4;
    const lo = b & 0x0f;
    // Valid pixel codes: 0 black, 1 white, 2 yellow, 3 red, 5 blue, 6 green.
    if (hi === 4 || hi > 6 || lo === 4 || lo > 6) {
      return { ok: false, error: `invalid pixel code at byte ${i}` };
    }
  }
  return { ok: true, sha256: sha256Hex(bytes) };
}
