import { describe, expect, test } from 'bun:test';
import {
  AirplanesLiveProvider,
  ProviderError,
  parseAirplanesLiveResponse,
  parseRetryAfter,
} from '../src';
import fixture from './fixtures/airplanes-live-point.json';

describe('Airplanes.live response parsing', () => {
  const { positions, skipped } = parseAirplanesLiveResponse(fixture);
  const byHex = new Map(positions.map((p) => [p.icao24, p]));

  test('normalises a complete ADS-B record', () => {
    const p = byHex.get('f00001')!;
    expect(p).toMatchObject({
      callsign: 'EXA101',
      registration: 'N101OH',
      icaoTypeCode: 'B738',
      typeDescription: 'BOEING 737-800',
      operatorName: 'Example Air',
      altitudeFt: 4000,
      onGround: false,
      groundspeedKnots: 251.3,
      trackDegrees: 88.2,
      source: 'adsb_icao',
    });
    // observedAt = now - seen_pos
    expect(p.observedAt.getTime()).toBe(1789700000000 - 1200);
  });

  test('marks ground traffic and keeps non-ICAO (~) addresses', () => {
    expect(byHex.get('f00006')!.onGround).toBe(true);
    expect(byHex.get('~f0000d')).toBeDefined();
  });

  test('missing fields become null, never empty strings', () => {
    const p = byHex.get('f00008')!;
    expect(p.callsign).toBeNull();
    expect(p.registration).toBeNull();
    expect(p.icaoTypeCode).toBeNull();
    expect(p.altitudeFt).toBeNull();
    expect(p.groundspeedKnots).toBeNull();
    expect(p.trackDegrees).toBe(10);
    const unknown = byHex.get('~f0000d')!;
    expect(unknown.registration).toBeNull();
    expect(unknown.icaoTypeCode).toBeNull();
  });

  test('skips entries without a position or with invalid addresses', () => {
    expect(byHex.has('f00007')).toBe(false);
    expect(positions.some((p) => p.icao24 === 'not-hex')).toBe(false);
    expect(skipped).toBe(2);
  });

  test('rejects structurally invalid responses', () => {
    expect(() => parseAirplanesLiveResponse({ ac: 'nope' })).toThrow(ProviderError);
    expect(() => parseAirplanesLiveResponse(null)).toThrow(ProviderError);
  });

  test('accepts an empty/null aircraft list', () => {
    expect(parseAirplanesLiveResponse({ ac: null, now: 1 }).positions).toEqual([]);
    expect(parseAirplanesLiveResponse({ now: 1 }).positions).toEqual([]);
  });
});

describe('Airplanes.live client', () => {
  const query = { latitude: 0.5, longitude: 0.5, radiusNm: 5 };
  const make = (
    fetchImpl: typeof fetch,
    extra: Partial<ConstructorParameters<typeof AirplanesLiveProvider>[0]> = {},
  ) =>
    new AirplanesLiveProvider({
      baseUrl: 'https://api.example.test',
      userAgent: 'overhead-tests/0.1 (test@example.test)',
      fetch: fetchImpl,
      sleep: async () => {},
      minRequestIntervalMs: 0,
      ...extra,
    });

  test('sends a descriptive User-Agent and the point query', async () => {
    let seen: { url: string; ua: string | null } | null = null;
    const provider = make((async (url: URL, init: RequestInit) => {
      seen = { url: String(url), ua: new Headers(init.headers).get('user-agent') };
      return Response.json(fixture);
    }) as unknown as typeof fetch);
    const positions = await provider.getAircraftNear(query);
    expect(positions.length).toBe(4);
    expect(seen!.ua).toBe('overhead-tests/0.1 (test@example.test)');
    expect(seen!.url).toBe('https://api.example.test/v2/point/0.50000/0.50000/5');
  });

  test('maps 429 to a retryable rate-limit error honouring Retry-After', async () => {
    const provider = make(
      (async () =>
        new Response('slow down', {
          status: 429,
          headers: { 'Retry-After': '30' },
        })) as unknown as typeof fetch,
    );
    const err = (await provider.getAircraftNear(query).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(30_000);
  });

  test('maps 5xx to retryable and 4xx to non-retryable errors', async () => {
    const e500 = (await make(
      (async () => new Response('', { status: 502 })) as unknown as typeof fetch,
    )
      .getAircraftNear(query)
      .catch((e) => e)) as ProviderError;
    expect(e500.retryable).toBe(true);
    const e404 = (await make(
      (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    )
      .getAircraftNear(query)
      .catch((e) => e)) as ProviderError;
    expect(e404.retryable).toBe(false);
  });

  test('times out and never includes coordinates or URLs in errors', async () => {
    const provider = make(
      ((_url: URL, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        })) as unknown as typeof fetch,
      { timeoutMs: 20 },
    );
    const err = (await provider.getAircraftNear(query).catch((e) => e)) as ProviderError;
    expect(err.code).toBe('timeout');
    expect(err.message).not.toContain('0.5');
    expect(err.message).not.toContain('http');
  });

  test('invalid JSON is an invalid_response error', async () => {
    const provider = make(
      (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch,
    );
    const err = (await provider.getAircraftNear(query).catch((e) => e)) as ProviderError;
    expect(err.code).toBe('invalid_response');
  });

  test('spaces consecutive requests', async () => {
    let now = 0;
    const waits: number[] = [];
    const provider = make(
      (async () => Response.json({ ac: [], now: 1 })) as unknown as typeof fetch,
      {
        minRequestIntervalMs: 1100,
        now: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
      },
    );
    await Promise.all([provider.getAircraftNear(query), provider.getAircraftNear(query)]);
    expect(waits).toEqual([1100]);
  });

  test('requires a User-Agent', () => {
    expect(() => make(fetch, { userAgent: ' ' })).toThrow();
  });

  test('parses Retry-After dates and seconds', () => {
    expect(parseRetryAfter('5', 0)).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(parseRetryAfter('garbage', 0)).toBeNull();
  });
});
