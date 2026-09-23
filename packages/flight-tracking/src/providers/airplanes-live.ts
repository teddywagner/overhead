import { z } from 'zod';
import {
  finiteOrNull,
  normalizeCallsign,
  normalizeIcao24,
  normalizeRegistration,
  normalizeText,
  normalizeTrack,
  normalizeTypeCode,
} from '../normalize';
import {
  ProviderError,
  type AircraftPositionProvider,
  type AircraftQuery,
  type NormalizedAircraftPosition,
} from '../types';

/**
 * Airplanes.live REST API (readsb/ADSBExchange v2 style JSON).
 * GET {base}/v2/point/{lat}/{lon}/{radius_nm}. The public API is rate
 * limited (about one request per second) and intended for non-commercial use.
 *
 * Wire types stay in this file; callers only see NormalizedAircraftPosition.
 */
const numberish = z.number().finite();

export const airplanesLiveAircraftSchema = z
  .object({
    hex: z.string(),
    type: z.string().optional(),
    flight: z.string().optional(),
    r: z.string().optional(),
    t: z.string().optional(),
    desc: z.string().optional(),
    ownOp: z.string().optional(),
    alt_baro: z.union([numberish, z.literal('ground')]).optional(),
    alt_geom: numberish.optional(),
    gs: numberish.optional(),
    track: numberish.optional(),
    lat: numberish.optional(),
    lon: numberish.optional(),
    seen_pos: numberish.optional(),
    seen: numberish.optional(),
  })
  .loose();

export const airplanesLiveResponseSchema = z
  .object({
    ac: z.array(z.unknown()).nullable().optional(),
    msg: z.string().optional(),
    now: numberish,
    total: numberish.optional(),
  })
  .loose();

export type AirplanesLiveAircraft = z.infer<typeof airplanesLiveAircraftSchema>;

/** Parse and normalise a raw response body. Invalid aircraft entries are skipped. */
export function parseAirplanesLiveResponse(body: unknown): {
  positions: NormalizedAircraftPosition[];
  skipped: number;
} {
  const parsed = airplanesLiveResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ProviderError('invalid_response', 'Airplanes.live response failed validation', true);
  }
  const nowMs = parsed.data.now;
  const positions: NormalizedAircraftPosition[] = [];
  let skipped = 0;
  for (const raw of parsed.data.ac ?? []) {
    const ac = airplanesLiveAircraftSchema.safeParse(raw);
    if (!ac.success) {
      skipped++;
      continue;
    }
    const p = normalizeAirplanesLiveAircraft(ac.data, nowMs);
    if (p) positions.push(p);
    else skipped++;
  }
  return { positions, skipped };
}

export function normalizeAirplanesLiveAircraft(
  ac: AirplanesLiveAircraft,
  nowMs: number,
): NormalizedAircraftPosition | null {
  const icao24 = normalizeIcao24(ac.hex);
  const lat = finiteOrNull(ac.lat);
  const lon = finiteOrNull(ac.lon);
  if (!icao24 || lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const onGround = ac.alt_baro === 'ground';
  const altitudeFt =
    typeof ac.alt_baro === 'number' ? Math.round(ac.alt_baro) : onGround ? 0 : null;
  const seenPos = finiteOrNull(ac.seen_pos) ?? finiteOrNull(ac.seen) ?? 0;
  return {
    icao24,
    callsign: normalizeCallsign(ac.flight),
    registration: normalizeRegistration(ac.r),
    icaoTypeCode: normalizeTypeCode(ac.t),
    typeDescription: normalizeText(ac.desc, 120),
    operatorName: normalizeText(ac.ownOp, 160),
    latitude: lat,
    longitude: lon,
    altitudeFt,
    onGround,
    groundspeedKnots: finiteOrNull(ac.gs),
    trackDegrees: normalizeTrack(ac.track),
    observedAt: new Date(Math.round(nowMs - Math.max(0, seenPos) * 1000)),
    source: normalizeText(ac.type, 40),
  };
}

export interface AirplanesLiveOptions {
  baseUrl: string;
  userAgent: string;
  timeoutMs?: number;
  /** Minimum spacing between requests from this client. */
  minRequestIntervalMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class AirplanesLiveProvider implements AircraftPositionProvider {
  readonly name = 'airplanes_live' as const;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: AirplanesLiveOptions) {
    if (!options.userAgent.trim())
      throw new Error('Airplanes.live requires a descriptive User-Agent');
  }

  getAircraftNear(input: AircraftQuery): Promise<NormalizedAircraftPosition[]> {
    // Serialise requests so the per-client spacing holds across locations.
    const run = this.queue.then(() => this.request(input));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request(input: AircraftQuery): Promise<NormalizedAircraftPosition[]> {
    const {
      baseUrl,
      userAgent,
      timeoutMs = 10_000,
      minRequestIntervalMs = 1100,
      fetch: doFetch = fetch,
      sleep = (ms) => Bun.sleep(ms),
      now = Date.now,
    } = this.options;

    const wait = this.lastRequestAt + minRequestIntervalMs - now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = now();

    const radius = Math.min(250, Math.max(1, Math.ceil(input.radiusNm)));
    // Coordinates are sensitive: this URL is never logged or put in errors.
    const url = new URL(
      `/v2/point/${input.latitude.toFixed(5)}/${input.longitude.toFixed(5)}/${radius}`,
      baseUrl,
    );

    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { 'User-Agent': userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ProviderError(
          'timeout',
          `Airplanes.live request timed out after ${timeoutMs} ms`,
          true,
        );
      }
      throw new ProviderError(
        'network_error',
        'Airplanes.live request failed (network error)',
        true,
      );
    }

    if (res.status === 429) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), now());
      throw new ProviderError(
        'rate_limited',
        'Airplanes.live rate limit reached',
        true,
        retryAfter,
        429,
      );
    }
    if (!res.ok) {
      throw new ProviderError(
        'http_error',
        `Airplanes.live responded with HTTP ${res.status}`,
        res.status >= 500,
        null,
        res.status,
      );
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError('invalid_response', 'Airplanes.live returned invalid JSON', true);
    }
    return parseAirplanesLiveResponse(body).positions;
  }
}

export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 3_600_000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - nowMs), 3_600_000);
  return null;
}
