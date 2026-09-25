import { z } from 'zod';
import { ProviderError } from '../types';
import { parseRetryAfter } from '../providers/readsb-v2';

/**
 * Wikimedia Commons file search (MediaWiki API), used to offer extra,
 * openly licensed photos of an airframe by its registration. Commons asks
 * for a User-Agent with contact details and modest request rates.
 *
 * Only the registration (a public identifier) is sent.
 */
export const WIKIMEDIA_COMMONS_DEFAULT_BASE_URL = 'https://commons.wikimedia.org';

/** A photo someone can pick for an airframe, with what is needed to credit it. */
export interface PhotoCandidate {
  provider: 'planespotters' | 'wikimedia_commons' | 'adsbdb';
  thumbnailUrl: string;
  imageUrl: string;
  pageUrl: string;
  creator: string | null;
  licenseName: string | null;
  licenseUrl: string | null;
}

const https = z.string().regex(/^https:\/\//);
const meta = z.object({ value: z.string() }).loose().optional();

const responseSchema = z
  .object({
    query: z
      .object({
        pages: z.array(
          z
            .object({
              title: z.string(),
              index: z.number().optional(),
              imageinfo: z
                .array(
                  z
                    .object({
                      url: https,
                      thumburl: https.optional(),
                      descriptionurl: https,
                      mime: z.string().optional(),
                      extmetadata: z
                        .object({ Artist: meta, LicenseShortName: meta, LicenseUrl: meta })
                        .loose()
                        .optional(),
                    })
                    .loose(),
                )
                .optional(),
            })
            .loose(),
        ),
      })
      .loose()
      .optional(),
  })
  .loose();

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  nbsp: ' ',
};

/** Commons "Artist" is HTML (often a link); keep just the text. */
export function plainText(html: string | undefined, max = 200): string | null {
  if (!html) return null;
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
}

/** Photos whose file name contains the registration, most relevant first. */
export function parseCommonsPhotos(body: unknown, registration: string): PhotoCandidate[] {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ProviderError('invalid_response', 'commons response failed validation', true);
  }
  const reg = registration.toUpperCase();
  return (parsed.data.query?.pages ?? [])
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .flatMap((p) => {
      const info = p.imageinfo?.[0];
      // Search is fuzzy: only keep files named after this airframe.
      if (!info || !p.title.toUpperCase().includes(reg)) return [];
      if (info.mime && !/^image\/(jpeg|png|webp)$/.test(info.mime)) return [];
      const m = info.extmetadata;
      const licenseUrl = m?.LicenseUrl?.value;
      return [
        {
          provider: 'wikimedia_commons' as const,
          thumbnailUrl: info.thumburl ?? info.url,
          imageUrl: info.url,
          pageUrl: info.descriptionurl,
          creator: plainText(m?.Artist?.value),
          licenseName: plainText(m?.LicenseShortName?.value, 120),
          licenseUrl: licenseUrl && /^https?:\/\//.test(licenseUrl) ? licenseUrl : null,
        },
      ];
    });
}

export interface CommonsOptions {
  baseUrl: string;
  userAgent: string;
  timeoutMs?: number;
  /** Most photos to return. */
  limit?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export class WikimediaCommonsClient {
  constructor(private readonly options: CommonsOptions) {
    if (!options.userAgent.trim()) throw new Error('commons requires a descriptive User-Agent');
  }

  async photos(registration: string | null | undefined): Promise<PhotoCandidate[]> {
    const reg = registration?.trim().toUpperCase();
    if (!reg || !/^[A-Z0-9-]{2,12}$/.test(reg)) return [];
    const {
      baseUrl,
      userAgent,
      timeoutMs = 8000,
      limit = 8,
      fetch: doFetch = fetch,
    } = this.options;
    const now = this.options.now ?? Date.now;

    const url = new URL('/w/api.php', baseUrl);
    url.search = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      generator: 'search',
      gsrsearch: `"${reg}"`,
      gsrnamespace: '6',
      gsrlimit: String(limit * 2),
      prop: 'imageinfo',
      iiprop: 'url|extmetadata|mime',
      iiurlwidth: '420',
      iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl',
    }).toString();

    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { 'User-Agent': userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ProviderError('timeout', `commons timed out after ${timeoutMs} ms`, true);
      }
      throw new ProviderError('network_error', 'commons request failed (network error)', true);
    }
    if (res.status === 429) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), now());
      throw new ProviderError('rate_limited', 'commons rate limit reached', true, retryAfter, 429);
    }
    if (!res.ok) {
      throw new ProviderError(
        'http_error',
        `commons responded with HTTP ${res.status}`,
        res.status >= 500,
        null,
        res.status,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError('invalid_response', 'commons returned invalid JSON', true);
    }
    return parseCommonsPhotos(body, reg).slice(0, limit);
  }
}
