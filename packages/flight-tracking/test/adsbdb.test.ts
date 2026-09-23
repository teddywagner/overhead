import { describe, expect, test } from 'bun:test';
import {
  AdsbdbClient,
  ProviderError,
  isAirlineCallsign,
  parseAdsbdbAircraft,
  parseAdsbdbRoute,
} from '../src';
import aircraftFixture from './fixtures/adsbdb-aircraft.json';
import callsignFixture from './fixtures/adsbdb-callsign.json';

describe('adsbdb parsing', () => {
  test('aircraft details', () => {
    expect(parseAdsbdbAircraft(aircraftFixture)).toEqual({
      manufacturer: 'Boeing',
      model: '737-8',
      registration: 'N349TV',
      icaoTypeCode: 'B38M',
      country: 'United States',
      registeredOwner: 'Boeing',
    });
  });

  test('flight route and airline', () => {
    expect(parseAdsbdbRoute(callsignFixture)).toEqual({
      airlineName: 'American Airlines',
      airlineIcao: 'AAL',
      airlineIata: 'AA',
      flightNumber: 'AA2995',
      originCode: 'JFK',
      destinationCode: 'MEX',
      originName: 'New York',
      destinationName: 'Mexico City',
    });
  });

  test('"unknown" string responses and odd values become null', () => {
    expect(parseAdsbdbAircraft({ response: 'unknown aircraft' })).toBeNull();
    expect(parseAdsbdbRoute({ response: 'unknown callsign' })).toBeNull();
    const route = parseAdsbdbRoute({
      response: {
        flightroute: {
          callsign_iata: '',
          airline: { name: ' ', icao: 'toolong', iata: '' },
          origin: { iata_code: '', icao_code: 'EGLL', name: 'Heathrow' },
          destination: null,
        },
      },
    });
    expect(route).toMatchObject({
      airlineName: null,
      airlineIcao: null,
      flightNumber: null,
      originCode: 'EGLL',
      destinationCode: null,
    });
  });

  test('rejects non-envelope bodies', () => {
    expect(() => parseAdsbdbAircraft('nope')).toThrow(ProviderError);
  });

  test('only airline-style callsigns are looked up', () => {
    expect(isAirlineCallsign('AAL2995')).toBe(true);
    expect(isAirlineCallsign('SKW5123A')).toBe(true);
    expect(isAirlineCallsign('N12345')).toBe(false); // registration as callsign
    expect(isAirlineCallsign(null)).toBe(false);
  });
});

describe('adsbdb client', () => {
  const make = (fetchImpl: typeof fetch) =>
    new AdsbdbClient({
      baseUrl: 'https://api.adsbdb.test',
      userAgent: 'overhead-tests/0.1',
      fetch: fetchImpl,
      sleep: async () => {},
      minRequestIntervalMs: 0,
    });

  test('requests by Mode S hex and callsign with the User-Agent', async () => {
    const seen: Array<{ url: string; ua: string | null }> = [];
    const client = make((async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), ua: new Headers(init.headers).get('user-agent') });
      return Response.json(String(url).includes('/aircraft/') ? aircraftFixture : callsignFixture);
    }) as unknown as typeof fetch);
    expect((await client.aircraft('a3e07a'))?.model).toBe('737-8');
    expect((await client.route('AAL2995'))?.airlineName).toBe('American Airlines');
    expect(seen.map((s) => s.url)).toEqual([
      'https://api.adsbdb.test/v0/aircraft/A3E07A',
      'https://api.adsbdb.test/v0/callsign/AAL2995',
    ]);
    expect(seen.every((s) => s.ua === 'overhead-tests/0.1')).toBe(true);
  });

  test('404 is "not found", not an error', async () => {
    const client = make((async () =>
      Response.json({ response: 'unknown aircraft' }, { status: 404 })) as unknown as typeof fetch);
    expect(await client.aircraft('000000')).toBeNull();
  });

  test('never sends non-ICAO addresses or non-airline callsigns', async () => {
    let calls = 0;
    const client = make((async () => {
      calls++;
      return Response.json(aircraftFixture);
    }) as unknown as typeof fetch);
    expect(await client.aircraft('~2afe91')).toBeNull();
    expect(await client.route('N12345')).toBeNull();
    expect(calls).toBe(0);
  });

  test('429 is a retryable rate limit; 5xx retryable', async () => {
    const limited = (await make(
      (async () =>
        new Response('', {
          status: 429,
          headers: { 'Retry-After': '60' },
        })) as unknown as typeof fetch,
    )
      .aircraft('a3e07a')
      .catch((e) => e)) as ProviderError;
    expect(limited.code).toBe('rate_limited');
    expect(limited.retryAfterMs).toBe(60_000);
    const down = (await make(
      (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
    )
      .route('AAL2995')
      .catch((e) => e)) as ProviderError;
    expect(down.code).toBe('http_error');
    expect(down.retryable).toBe(true);
  });
});
