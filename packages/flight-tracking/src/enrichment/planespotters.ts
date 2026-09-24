import { z } from 'zod';
import { ProviderError } from '../types';
import { parseRetryAfter } from '../providers/readsb-v2';

/**
 * Planespotters.net public photo API (https://www.planespotters.net/photo/api).
 * Server-side only: it rejects User-Agents without contact details, which
 * browsers cannot set. Its terms: hotlink the thumbnails (never re-host
 * them), credit the photographer and link to the photo page.
 *
 * Only public identifiers are sent: a Mode S address or a registration.
 */
export const PLANESPOTTERS_DEFAULT_BASE_URL = 'https://api.planespotters.net';

/** Provider-neutral photo reference. */
export interface AircraftPhoto {
  /** ~200 px wide thumbnail. */
  thumbnailUrl: string;
  /** ~420 px wide thumbnail. */
  largeUrl: string;
  /** Photo page to link to (required by the terms). */
  pageUrl: string;
  photographer: string;
}

const https = z.string().regex(/^https:\/\//);
const image = z.object({ src: https }).loose();

const photosSchema = z
  .object({
    photos: z.array(
      z
        .object({
          thumbnail: image.nullable().optional(),
          thumbnail_large: image.nullable().optional(),
          link: https,
          photographer: z.string().nullable().optional(),
        })
        .loose(),
    ),
  })
  .loose();

/** First usable photo, or null when there is none. */
export function parsePlanespottersPhotos(body: unknown): AircraftPhoto | null {
  const parsed = photosSchema.safeParse(body);
  if (!parsed.success) {
    throw new ProviderError('invalid_response', 'planespotters response failed validation', true);
  }
  for (const p of parsed.data.photos) {
    const small = p.thumbnail?.src ?? p.thumbnail_large?.src;
    if (!small) continue;
    return {
      thumbnailUrl: small,
      largeUrl: p.thumbnail_large?.src ?? small,
      pageUrl: p.link,
      photographer: p.photographer?.trim().slice(0, 200) || 'Unknown photographer',
    };
  }
  return null;
}

export interface PlanespottersOptions {
  baseUrl: string;
  /** Must include contact details, e.g. "overhead/0.1 (+https://example.com)". */
  userAgent: string;
  timeoutMs?: number;
  minRequestIntervalMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class PlanespottersClient {
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PlanespottersOptions) {
    if (!options.userAgent.trim())
      throw new Error('planespotters requires a descriptive User-Agent');
  }

  /** Best photo by Mode S address, then by registration; null when none. */
  async photo(icao24: string, registration?: string | null): Promise<AircraftPhoto | null> {
    // "~" addresses are anonymised (non-ICAO): no airframe to look up.
    if (/^[0-9a-f]{6}$/i.test(icao24)) {
      const byHex = await this.enqueue(`/pub/photos/hex/${icao24.toUpperCase()}`);
      if (byHex) return byHex;
    }
    const reg = registration?.trim().toUpperCase();
    if (!reg || !/^[A-Z0-9-]{1,12}$/.test(reg)) return null;
    return this.enqueue(`/pub/photos/reg/${reg}`);
  }

  private enqueue(path: string): Promise<AircraftPhoto | null> {
    const run = this.queue.then(() => this.request(path));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request(path: string): Promise<AircraftPhoto | null> {
    const {
      baseUrl,
      userAgent,
      timeoutMs = 8000,
      minRequestIntervalMs = 250,
      fetch: doFetch = fetch,
      sleep = (ms) => Bun.sleep(ms),
      now = Date.now,
    } = this.options;

    const wait = this.lastRequestAt + minRequestIntervalMs - now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = now();

    let res: Response;
    try {
      res = await doFetch(new URL(path, baseUrl), {
        headers: { 'User-Agent': userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ProviderError('timeout', `planespotters timed out after ${timeoutMs} ms`, true);
      }
      throw new ProviderError(
        'network_error',
        'planespotters request failed (network error)',
        true,
      );
    }

    if (res.status === 404) return null;
    if (res.status === 429) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), now());
      throw new ProviderError(
        'rate_limited',
        'planespotters rate limit reached',
        true,
        retryAfter,
        429,
      );
    }
    if (!res.ok) {
      throw new ProviderError(
        'http_error',
        `planespotters responded with HTTP ${res.status}`,
        res.status >= 500,
        null,
        res.status,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError('invalid_response', 'planespotters returned invalid JSON', true);
    }
    return parsePlanespottersPhotos(body);
  }
}
