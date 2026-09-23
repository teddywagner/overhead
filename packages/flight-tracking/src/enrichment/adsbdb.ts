import { z } from 'zod';
import { normalizeRegistration, normalizeText, normalizeTypeCode } from '../normalize';
import { ProviderError } from '../types';
import { parseRetryAfter } from '../providers/readsb-v2';

/**
 * adsbdb (https://www.adsbdb.com): free, open-source aircraft and
 * flight-route database. Used to fill in details ADS-B feeds don't carry.
 *
 * Only public identifiers are ever sent: the aircraft's Mode S address or
 * the flight's callsign. Never coordinates.
 */
export const ADSBDB_DEFAULT_BASE_URL = 'https://api.adsbdb.com';

/** Provider-neutral aircraft details. Unknown values are null. */
export interface AircraftDetails {
  manufacturer: string | null;
  /** Marketing model, e.g. "737-8". */
  model: string | null;
  registration: string | null;
  icaoTypeCode: string | null;
  /** Country of registration. */
  country: string | null;
  /** Registered owner (often a lessor or bank, not the operator). */
  registeredOwner: string | null;
}

/** Provider-neutral route details for one callsign. Unknown values are null. */
export interface FlightRoute {
  airlineName: string | null;
  airlineIcao: string | null;
  airlineIata: string | null;
  /** e.g. "AA2995". */
  flightNumber: string | null;
  /** IATA code when known, else ICAO (e.g. "JFK" or "KJFK"). */
  originCode: string | null;
  destinationCode: string | null;
  originName: string | null;
  destinationName: string | null;
}

const str = z.string().nullable().optional();

const aircraftSchema = z
  .object({
    type: str,
    icao_type: str,
    manufacturer: str,
    mode_s: str,
    registration: str,
    registered_owner_country_name: str,
    registered_owner: str,
  })
  .loose();

const airportSchema = z
  .object({ iata_code: str, icao_code: str, name: str, municipality: str })
  .loose()
  .nullable()
  .optional();

const routeSchema = z
  .object({
    callsign: str,
    callsign_iata: str,
    airline: z.object({ name: str, icao: str, iata: str }).loose().nullable().optional(),
    origin: airportSchema,
    destination: airportSchema,
  })
  .loose();

const envelopeSchema = z.object({ response: z.unknown() }).loose();

const code = (v: string | null | undefined, re: RegExp): string | null => {
  const s = v?.trim().toUpperCase();
  return s && re.test(s) ? s : null;
};

const airportCode = (a: z.infer<typeof airportSchema>): string | null =>
  code(a?.iata_code, /^[A-Z0-9]{3}$/) ?? code(a?.icao_code, /^[A-Z0-9]{4}$/);

export function parseAdsbdbAircraft(body: unknown): AircraftDetails | null {
  const env = envelopeSchema.safeParse(body);
  if (!env.success)
    throw new ProviderError('invalid_response', 'adsbdb response failed validation', true);
  const inner = z.object({ aircraft: aircraftSchema }).safeParse(env.data.response);
  if (!inner.success) return null;
  const a = inner.data.aircraft;
  return {
    manufacturer: normalizeText(a.manufacturer, 120),
    model: normalizeText(a.type, 120),
    registration: normalizeRegistration(a.registration),
    icaoTypeCode: normalizeTypeCode(a.icao_type),
    country: normalizeText(a.registered_owner_country_name, 80),
    registeredOwner: normalizeText(a.registered_owner, 160),
  };
}

export function parseAdsbdbRoute(body: unknown): FlightRoute | null {
  const env = envelopeSchema.safeParse(body);
  if (!env.success)
    throw new ProviderError('invalid_response', 'adsbdb response failed validation', true);
  const inner = z.object({ flightroute: routeSchema }).safeParse(env.data.response);
  if (!inner.success) return null;
  const r = inner.data.flightroute;
  const place = (a: z.infer<typeof airportSchema>) =>
    normalizeText(a?.municipality ?? a?.name ?? null, 120);
  return {
    airlineName: normalizeText(r.airline?.name, 160),
    airlineIcao: code(r.airline?.icao, /^[A-Z]{3}$/),
    airlineIata: code(r.airline?.iata, /^[A-Z0-9]{2}$/),
    flightNumber: code(r.callsign_iata, /^[A-Z0-9]{3,10}$/),
    originCode: airportCode(r.origin),
    destinationCode: airportCode(r.destination),
    originName: place(r.origin),
    destinationName: place(r.destination),
  };
}

/**
 * Callsigns worth looking up: airline style (3-letter ICAO prefix + flight
 * number). Private aircraft usually broadcast their registration instead,
 * which adsbdb has no route for.
 */
export function isAirlineCallsign(callsign: string | null | undefined): callsign is string {
  return !!callsign && /^[A-Z]{3}[0-9]{1,4}[A-Z]{0,2}$/.test(callsign);
}

export interface AdsbdbOptions {
  baseUrl: string;
  userAgent: string;
  timeoutMs?: number;
  /** adsbdb publishes no limits; keep requests well spaced. */
  minRequestIntervalMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class AdsbdbClient {
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: AdsbdbOptions) {
    if (!options.userAgent.trim()) throw new Error('adsbdb requires a descriptive User-Agent');
  }

  /** Details for a Mode S (ICAO 24-bit) address; null when unknown. */
  aircraft(icao24: string): Promise<AircraftDetails | null> {
    const hex = icao24.replace(/^~/, '').toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(hex) || icao24.startsWith('~')) return Promise.resolve(null);
    return this.enqueue(`/v0/aircraft/${hex}`, parseAdsbdbAircraft);
  }

  /** Route and airline for a callsign; null when unknown. */
  route(callsign: string): Promise<FlightRoute | null> {
    if (!isAirlineCallsign(callsign)) return Promise.resolve(null);
    return this.enqueue(`/v0/callsign/${callsign}`, parseAdsbdbRoute);
  }

  private enqueue<T>(path: string, parse: (body: unknown) => T | null): Promise<T | null> {
    const run = this.queue.then(() => this.request(path, parse));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async request<T>(path: string, parse: (body: unknown) => T | null): Promise<T | null> {
    const {
      baseUrl,
      userAgent,
      timeoutMs = 10_000,
      minRequestIntervalMs = 1500,
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
        throw new ProviderError('timeout', `adsbdb request timed out after ${timeoutMs} ms`, true);
      }
      throw new ProviderError('network_error', 'adsbdb request failed (network error)', true);
    }

    if (res.status === 404) return null; // {"response":"unknown aircraft|callsign"}
    if (res.status === 429) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), now());
      throw new ProviderError('rate_limited', 'adsbdb rate limit reached', true, retryAfter, 429);
    }
    if (!res.ok) {
      throw new ProviderError(
        'http_error',
        `adsbdb responded with HTTP ${res.status}`,
        res.status >= 500,
        null,
        res.status,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ProviderError('invalid_response', 'adsbdb returned invalid JSON', true);
    }
    return parse(body);
  }
}
