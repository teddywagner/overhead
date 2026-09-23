import { describe, expect, test } from 'bun:test';
import {
  DisplayContractError,
  PANEL_IMAGE_BYTES,
  buildDisplayResponse,
  credentialMatches,
  generateDeviceToken,
  generateSetupSecret,
  hashCredential,
  normalizeMac,
  parseBearer,
  parseTelemetry,
  sanitizeDeviceLogMessage,
  verifyPanelBinary,
} from '../src';

describe('device protocol helpers', () => {
  test('normalises MAC addresses', () => {
    expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aabbccddeeff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aa:bb:cc:dd:ee')).toBeNull();
    expect(normalizeMac('gg:bb:cc:dd:ee:ff')).toBeNull();
  });

  test('tokens are 64 lowercase hex and secrets fit the firmware limit', () => {
    const token = generateDeviceToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(generateDeviceToken()).not.toBe(token);
    const secret = generateSetupSecret();
    expect(Buffer.byteLength(secret)).toBeLessThanOrEqual(159);
    expect(credentialMatches(secret, hashCredential(secret))).toBe(true);
    expect(credentialMatches(`${secret}x`, hashCredential(secret))).toBe(false);
  });

  test('parses only well-formed bearer tokens', () => {
    const token = 'a'.repeat(64);
    expect(parseBearer(`Bearer ${token}`)).toBe(token);
    expect(parseBearer(`bearer ${token}`)).toBeNull();
    expect(parseBearer(`Bearer ${token.toUpperCase()}`)).toBeNull();
    expect(parseBearer('Bearer short')).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });

  test('parses telemetry defensively', () => {
    const headers: Record<string, string> = {
      'x-battery-mv': '3941',
      'x-rssi': '-61',
      'x-fw-version': '0.1.0',
      'x-boot-reason': 'weird',
    };
    expect(parseTelemetry((n) => headers[n])).toEqual({
      batteryMv: 3941,
      rssi: -61,
      firmwareVersion: '0.1.0',
      bootReason: 'unknown',
    });
    const bad: Record<string, string> = {
      'x-battery-mv': '99999999',
      'x-rssi': 'abc',
      'x-fw-version': '<script>',
    };
    expect(parseTelemetry((n) => bad[n])).toEqual({
      batteryMv: null,
      rssi: null,
      firmwareVersion: null,
      bootReason: null,
    });
  });

  test('display responses satisfy every firmware validation rule', () => {
    const sha = 'c'.repeat(64);
    expect(
      buildDisplayResponse({
        imageUrl: 'https://x.test/a.bin',
        sha256: sha,
        sleepS: 3600,
        reset: false,
      }),
    ).toEqual({
      image_url: 'https://x.test/a.bin',
      image_hash: `sha256:${sha}`,
      sleep_s: 3600,
      firmware: null,
      reset: false,
    });
    const bad = [
      { imageUrl: 'ftp://x', sha256: sha, sleepS: 1, reset: false },
      { imageUrl: `https://x/${'a'.repeat(800)}`, sha256: sha, sleepS: 1, reset: false },
      { imageUrl: 'https://x', sha256: 'C'.repeat(64), sleepS: 1, reset: false },
      { imageUrl: 'https://x', sha256: sha, sleepS: 0, reset: false },
      { imageUrl: 'https://x', sha256: sha, sleepS: 2 ** 32, reset: false },
    ];
    for (const b of bad) expect(() => buildDisplayResponse(b)).toThrow(DisplayContractError);
  });

  test('verifies panel binaries (size and pixel codes)', () => {
    const white = new Uint8Array(PANEL_IMAGE_BYTES).fill(0x11);
    const ok = verifyPanelBinary(white);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPanelBinary(new Uint8Array(10)).ok).toBe(false);
    const invalid = white.slice();
    invalid[500] = 0x14; // 0x4 is not a valid pixel code
    expect(verifyPanelBinary(invalid).ok).toBe(false);
  });

  test('log sanitisation strips credentials and control characters', () => {
    const msg = sanitizeDeviceLogMessage(
      `auth failed Bearer ${'f'.repeat(64)} secret=hunter2\u0000`,
    );
    expect(msg).not.toContain('hunter2');
    expect(msg).not.toContain('f'.repeat(64));
    expect(msg).not.toContain('\u0000');
  });
});
