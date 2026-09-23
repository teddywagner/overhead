import { describe, expect, test } from 'bun:test';
import { silentLogger } from '@overhead/core';
import { ProviderError, type AircraftDetails, type FlightRoute } from '@overhead/flight-tracking';
import { Enricher } from '../src/enricher';
import type {
  AircraftToEnrich,
  EnrichmentStore,
  LookupStatus,
  OverflightToEnrich,
} from '../src/enrichment-store';

/** In-memory store with the same "looked up once" semantics as Postgres. */
class FakeStore implements EnrichmentStore {
  aircraft: AircraftToEnrich[] = [];
  overflights: OverflightToEnrich[] = [];
  aircraftLog: Array<{ id: string; status: LookupStatus; details: AircraftDetails | null }> = [];
  routeLog: Array<{ id: string; status: LookupStatus; route: FlightRoute | null }> = [];

  private done = (log: Array<{ id: string; status: LookupStatus }>, id: string) =>
    log.some((l) => l.id === id && l.status !== 'error');

  async aircraftNeedingDetails(limit: number) {
    return this.aircraft.filter((a) => !this.done(this.aircraftLog, a.id)).slice(0, limit);
  }
  async overflightsNeedingRoute(limit: number) {
    return this.overflights.filter((o) => !this.done(this.routeLog, o.id)).slice(0, limit);
  }
  async saveAircraftDetails(
    t: AircraftToEnrich,
    details: AircraftDetails | null,
    status: LookupStatus,
  ) {
    this.aircraftLog.push({ id: t.id, status, details });
  }
  async saveRoute(t: OverflightToEnrich, route: FlightRoute | null, status: LookupStatus) {
    this.routeLog.push({ id: t.id, status, route });
  }
}

const DETAILS: AircraftDetails = {
  manufacturer: 'Boeing',
  model: '737-8',
  registration: 'N349TV',
  icaoTypeCode: 'B38M',
  country: 'United States',
  registeredOwner: 'Boeing',
};

const ROUTE: FlightRoute = {
  airlineName: 'American Airlines',
  airlineIcao: 'AAL',
  airlineIata: 'AA',
  flightNumber: 'AA2995',
  originCode: 'JFK',
  destinationCode: 'MEX',
  originName: 'New York',
  destinationName: 'Mexico City',
};

function setup(client: {
  aircraft: (h: string) => Promise<AircraftDetails | null>;
  route: (c: string) => Promise<FlightRoute | null>;
}) {
  let now = Date.parse('2026-09-23T12:00:00Z');
  const store = new FakeStore();
  const enricher = new Enricher({
    client,
    store,
    logger: silentLogger,
    intervalS: 30,
    batchSize: 10,
    pauseMs: 600_000,
    clock: () => new Date(now),
  });
  return { store, enricher, advance: (ms: number) => (now += ms) };
}

describe('enricher', () => {
  test('looks up new aircraft and routes once each', async () => {
    let calls = 0;
    const { store, enricher } = setup({
      aircraft: async (hex) => (calls++, hex === 'a3e07a' ? DETAILS : null),
      route: async () => (calls++, ROUTE),
    });
    store.aircraft = [
      { id: 'a1', icao24: 'a3e07a' },
      { id: 'a2', icao24: 'abcdef' },
    ];
    store.overflights = [{ id: 'o1', aircraftId: 'a1', callsign: 'AAL2995' }];

    const round = await enricher.runOnce();
    expect(round).toMatchObject({ aircraft: 2, routes: 1, errors: 0, paused: false });
    expect(store.aircraftLog.map((l) => [l.id, l.status])).toEqual([
      ['a1', 'success'],
      ['a2', 'not_found'],
    ]);
    expect(store.routeLog[0]).toMatchObject({ id: 'o1', status: 'success', route: ROUTE });

    await enricher.runOnce();
    expect(calls).toBe(3); // nothing repeated
  });

  test('errors are logged and retried on a later round', async () => {
    let fail = true;
    const { store, enricher } = setup({
      aircraft: async () => {
        if (fail) throw new ProviderError('timeout', 'adsbdb timed out', true);
        return DETAILS;
      },
      route: async () => null,
    });
    store.aircraft = [{ id: 'a1', icao24: 'a3e07a' }];
    expect((await enricher.runOnce()).errors).toBe(1);
    expect(store.aircraftLog[0]!.status).toBe('error');
    fail = false;
    await enricher.runOnce();
    expect(store.aircraftLog.at(-1)!.status).toBe('success');
  });

  test('a rate limit pauses all lookups', async () => {
    let calls = 0;
    const { store, enricher, advance } = setup({
      aircraft: async () => {
        calls++;
        throw new ProviderError('rate_limited', 'adsbdb rate limit reached', true, null, 429);
      },
      route: async () => ROUTE,
    });
    store.aircraft = [
      { id: 'a1', icao24: 'a3e07a' },
      { id: 'a2', icao24: 'abcdef' },
    ];
    store.overflights = [{ id: 'o1', aircraftId: 'a1', callsign: 'AAL2995' }];
    expect((await enricher.runOnce()).paused).toBe(true);
    expect(calls).toBe(1);
    expect(store.routeLog).toHaveLength(0);
    advance(5 * 60_000);
    expect((await enricher.runOnce()).paused).toBe(true);
    expect(calls).toBe(1);
    advance(6 * 60_000);
    await enricher.runOnce();
    expect(calls).toBe(2);
  });
});
