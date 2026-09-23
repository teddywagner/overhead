import { describe, expect, test } from 'bun:test';
import {
  EnvValidationError,
  REDACTED,
  apiEnvSchema,
  appName,
  appSlug,
  buildObjectPath,
  createLogger,
  destination,
  distanceM,
  isOwnedObjectPath,
  loadEnv,
  localDate,
  matchArtAsset,
  pointToSegment,
  providerUserAgent,
  withPlatformPort,
  redact,
  sanitizeFilename,
  workerEnvSchema,
  type ArtCandidate,
} from '../src';

const OWNER = '11111111-1111-4111-8111-111111111111';
const P = { latitude: 0.5, longitude: 0.5 };

describe('environment validation', () => {
  const valid = {
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
    SUPABASE_SECRET_KEY: 'sb_secret_supersecretvalue',
    DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  };

  test('applies documented defaults', () => {
    const env = loadEnv(apiEnvSchema, valid);
    expect(env.API_PORT).toBe(3001);
    expect(env.DEFAULT_OVERHEAD_RADIUS_M).toBe(1200);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual([]);
    expect(env.TRUST_PROXY).toBe(false);
  });

  test('names every missing variable and never echoes values', () => {
    try {
      loadEnv(apiEnvSchema, {
        SUPABASE_SECRET_KEY: 'sb_secret_supersecretvalue',
        DATABASE_URL: 'mysql://nope',
      });
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const msg = (err as Error).message;
      expect(msg).toContain('SUPABASE_URL is required');
      expect(msg).toContain('SUPABASE_PUBLISHABLE_KEY is required');
      expect(msg).toContain('DATABASE_URL');
      expect(msg).not.toContain('supersecretvalue');
      expect(msg).not.toContain('mysql://nope');
    }
  });

  test('empty strings are treated as unset', () => {
    expect(() => loadEnv(apiEnvSchema, { ...valid, SUPABASE_URL: '' })).toThrow(
      'SUPABASE_URL is required',
    );
  });

  test('worker defaults to adsb.lol and requires a User-Agent for real providers', () => {
    const base = { DATABASE_URL: valid.DATABASE_URL };
    expect(() => loadEnv(workerEnvSchema, base)).toThrow('AIRCRAFT_PROVIDER_USER_AGENT');
    expect(() =>
      loadEnv(workerEnvSchema, { ...base, AIRCRAFT_PROVIDER: 'airplanes_live' }),
    ).toThrow('AIRCRAFT_PROVIDER_USER_AGENT');
    const env = loadEnv(workerEnvSchema, { ...base, AIRCRAFT_PROVIDER_USER_AGENT: 'overhead/0.1' });
    expect(env.AIRCRAFT_PROVIDER).toBe('adsb_lol');
    expect(env.ADSB_LOL_BASE_URL).toBe('https://api.adsb.lol');
    expect(loadEnv(workerEnvSchema, { ...base, AIRCRAFT_PROVIDER: 'mock' }).AIRCRAFT_PROVIDER).toBe(
      'mock',
    );
  });

  test('the legacy AIRPLANES_LIVE_USER_AGENT still satisfies the User-Agent requirement', () => {
    const env = loadEnv(workerEnvSchema, {
      DATABASE_URL: valid.DATABASE_URL,
      AIRPLANES_LIVE_USER_AGENT: 'legacy/1.0',
    });
    expect(providerUserAgent(env)).toBe('legacy/1.0');
    expect(
      providerUserAgent({
        AIRCRAFT_PROVIDER_USER_AGENT: 'new/1.0',
        AIRPLANES_LIVE_USER_AGENT: 'legacy/1.0',
      }),
    ).toBe('new/1.0');
  });

  test('uses the platform PORT when API_PORT is not set', () => {
    expect(loadEnv(apiEnvSchema, withPlatformPort({ ...valid, PORT: '8080' })).API_PORT).toBe(8080);
    expect(
      loadEnv(apiEnvSchema, withPlatformPort({ ...valid, PORT: '8080', API_PORT: '3001' }))
        .API_PORT,
    ).toBe(3001);
  });

  test('rejects invalid time zones', () => {
    expect(() => loadEnv(apiEnvSchema, { ...valid, DEFAULT_TIMEZONE: 'Mars/Olympus' })).toThrow(
      'DEFAULT_TIMEZONE',
    );
  });
});

describe('app naming', () => {
  test('is centralised and renameable', () => {
    expect(appName({})).toBe('Overhead');
    expect(appName({ APP_NAME: 'Sky Log' })).toBe('Sky Log');
    expect(appSlug({ APP_NAME: 'Sky Log!' })).toBe('sky-log');
  });
});

describe('geodesy', () => {
  test('distance and destination are consistent', () => {
    const q = destination(P, 90, 1000);
    expect(distanceM(P, q)).toBeCloseTo(1000, 3);
  });

  test('point-to-segment finds interior closest points', () => {
    const a = destination(P, 270, 5000);
    const b = destination(P, 90, 5000);
    const offset = destination(P, 0, 300);
    const r = pointToSegment(offset, a, b);
    expect(r.distanceM).toBeCloseTo(300, 0);
    expect(r.fraction).toBeCloseTo(0.5, 2);
  });

  test('point-to-segment clamps to endpoints', () => {
    const a = destination(P, 90, 1000);
    const b = destination(P, 90, 3000);
    const r = pointToSegment(P, a, b);
    expect(r.fraction).toBe(0);
    expect(r.distanceM).toBeCloseTo(1000, 0);
  });

  test('degenerate segments fall back to point distance', () => {
    const a = destination(P, 45, 700);
    expect(pointToSegment(P, a, a).distanceM).toBeCloseTo(700, 0);
  });
});

describe('local dates', () => {
  test('respect the IANA time zone', () => {
    const instant = new Date('2026-09-21T03:30:00Z');
    expect(localDate(instant, 'America/New_York')).toBe('2026-09-20');
    expect(localDate(instant, 'UTC')).toBe('2026-09-21');
    expect(localDate(instant, 'Asia/Tokyo')).toBe('2026-09-21');
  });
});

describe('logging redaction', () => {
  test('removes credentials and coordinates at any depth', () => {
    const out = redact({
      authorization: 'Bearer abc',
      nested: { latitude: 1.23, provision_secret: 's', ok: 'fine' },
      message: 'call failed with Bearer eyJhbGciOi.abc.def and sb_secret_abcdef',
    }) as Record<string, unknown>;
    expect(out.authorization).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).latitude).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).provision_secret).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).ok).toBe('fine');
    expect(out.message).not.toContain('eyJhbGciOi');
    expect(out.message).not.toContain('sb_secret_abcdef');
  });

  test('logger emits JSON lines and honours the level', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
    log.info('hidden');
    log.warn('shown', { token: 't' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', msg: 'shown', token: REDACTED });
  });
});

describe('storage paths', () => {
  test('sanitises filenames', () => {
    expect(sanitizeFilename('../../etc/Pässwd .PNG')).toBe('etc-passwd');
    expect(sanitizeFilename('....')).toBe('file');
  });

  test('builds owner-prefixed paths and validates ownership', () => {
    const path = buildObjectPath(OWNER, 'art', 'My Jet.png', 'png');
    expect(path.startsWith(`${OWNER}/art/`)).toBe(true);
    expect(isOwnedObjectPath(path, OWNER)).toBe(true);
    expect(isOwnedObjectPath(path, '22222222-2222-4222-8222-222222222222')).toBe(false);
    expect(isOwnedObjectPath(`${OWNER}/../other/x.png`, OWNER)).toBe(false);
    expect(isOwnedObjectPath(`${OWNER}/art/x y.png`, OWNER)).toBe(false);
  });
});

describe('artwork matching precedence', () => {
  const base = {
    status: 'approved' as const,
    approved_at: '2026-09-01T00:00:00Z',
    livery_name: null,
  };
  const assets: ArtCandidate[] = [
    {
      ...base,
      id: 'fallback',
      scope: 'fallback',
      registration: null,
      operator_icao: null,
      icao_type_code: null,
    },
    {
      ...base,
      id: 'type',
      scope: 'type',
      registration: null,
      operator_icao: null,
      icao_type_code: 'B738',
    },
    {
      ...base,
      id: 'op',
      scope: 'operator_type',
      registration: null,
      operator_icao: 'EXA',
      icao_type_code: 'B738',
    },
    {
      ...base,
      id: 'livery',
      scope: 'operator_livery',
      registration: null,
      operator_icao: 'EXA',
      icao_type_code: 'B738',
      livery_name: 'Retro',
    },
    {
      ...base,
      id: 'reg',
      scope: 'registration',
      registration: 'N101OH',
      operator_icao: null,
      icao_type_code: null,
    },
    {
      ...base,
      id: 'draft-reg',
      status: 'draft',
      scope: 'registration',
      registration: 'N202OH',
      operator_icao: null,
      icao_type_code: null,
    },
  ];
  const pick = (t: Parameters<typeof matchArtAsset>[0]) => matchArtAsset(t, assets)?.id;

  test('follows registration > livery > operator+type > type > fallback', () => {
    expect(
      pick({
        registration: 'N101OH',
        operator_icao: 'EXA',
        icao_type_code: 'B738',
        livery_name: 'Retro',
      }),
    ).toBe('reg');
    expect(
      pick({
        registration: 'N999',
        operator_icao: 'EXA',
        icao_type_code: 'B738',
        livery_name: 'Retro',
      }),
    ).toBe('livery');
    expect(pick({ registration: 'N999', operator_icao: 'EXA', icao_type_code: 'B738' })).toBe('op');
    expect(pick({ registration: null, operator_icao: 'ZZZ', icao_type_code: 'B738' })).toBe('type');
    expect(pick({ registration: null, operator_icao: null, icao_type_code: null })).toBe(
      'fallback',
    );
  });

  test('ignores unapproved assets', () => {
    expect(pick({ registration: 'N202OH', operator_icao: null, icao_type_code: 'A320' })).toBe(
      'fallback',
    );
  });
});
