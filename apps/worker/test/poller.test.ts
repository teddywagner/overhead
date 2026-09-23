import { describe, expect, test } from 'bun:test';
import { silentLogger } from '@overhead/core';
import {
  MOCK_SCENARIOS,
  MockAircraftProvider,
  ProviderError,
  type AircraftPositionProvider,
  type DetectionLocation,
} from '@overhead/flight-tracking';
import { InMemoryWorkerStore } from '../src/memory-store';
import { Poller, queryRadiusNm } from '../src/poller';

const LOCATION: DetectionLocation = {
  id: '22222222-2222-4222-8222-222222222222',
  ownerId: '11111111-1111-4111-8111-111111111111',
  latitude: 0.5,
  longitude: 0.5,
  searchRadiusNm: 5,
  overheadRadiusM: 1200,
  maxAltitudeFt: 15000,
  timezone: 'America/New_York',
};

const EPOCH = Date.parse('2026-09-20T14:00:00Z');

function harness(
  opts: {
    scenario?: string;
    store?: InMemoryWorkerStore;
    provider?: AircraftPositionProvider;
  } = {},
) {
  let nowMs = EPOCH;
  const clock = () => new Date(nowMs);
  const store = opts.store ?? new InMemoryWorkerStore();
  if (store.locations.length === 0) store.locations = [LOCATION];
  const provider =
    opts.provider ??
    new MockAircraftProvider({
      scenario: MOCK_SCENARIOS[opts.scenario ?? 'direct-crossing']!,
      epoch: new Date(EPOCH),
      clock,
    });
  const poller = new Poller({
    provider,
    store,
    logger: silentLogger,
    pollIntervalS: 15,
    clock,
    random: () => 0,
  });
  const advance = async (seconds: number, step = 15) => {
    for (let t = 0; t < seconds; t += step) {
      await poller.runCycle();
      nowMs += step * 1000;
    }
  };
  return { store, poller, advance, setNow: (ms: number) => (nowMs = ms), clock };
}

describe('worker poller (mock provider, in-memory store)', () => {
  test('full mocked overflight: active pass → finalised qualifying overflight', async () => {
    const h = harness();
    await h.advance(150);
    expect(h.store.active.size).toBe(1);
    expect(h.store.overflights.size).toBe(0);
    await h.advance(600);
    expect(h.store.active.size).toBe(0);
    const rows = [...h.store.overflights.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('qualified');
    expect(rows[0]!.registration).toBe('N101OH');
    expect(h.store.pollRuns.every((r) => r.status === 'ok')).toBe(true);
  });

  test('queries beyond the search radius so exits finalise promptly (not by timeout)', async () => {
    expect(queryRadiusNm(5)).toBe(6);
    expect(queryRadiusNm(20)).toBe(24);
    const h = harness();
    // The aircraft leaves the 5 NM search radius at ~t=250 s; a timeout
    // finalisation could not happen before ~t=550 s.
    await h.advance(300);
    expect(h.store.active.size).toBe(0);
    expect(h.store.overflights.size).toBe(1);
  });

  test('a second run over the same traffic does not duplicate the overflight', async () => {
    const store = new InMemoryWorkerStore();
    await harness({ store }).advance(900);
    expect(store.overflights.size).toBe(1);
    // Fresh worker process, same provider data from the same epoch.
    await harness({ store }).advance(900);
    expect(store.overflights.size).toBe(1);
  });

  test('worker restart mid-pass resumes from persisted state', async () => {
    const store = new InMemoryWorkerStore();
    const first = harness({ store });
    await first.advance(180);
    expect(store.active.size).toBe(1);
    const key = JSON.parse([...store.active.values()][0]!).providerPassKey;

    const second = harness({ store });
    second.setNow(EPOCH + 180_000);
    await second.advance(600);
    const rows = [...store.overflights.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerPassKey).toBe(key);
    expect(rows[0]!.status).toBe('qualified');
  });

  test('a crash while persisting is retried without duplicates', async () => {
    const h = harness();
    await h.advance(180);
    h.store.failNextApply = new Error('connection reset');
    await h.advance(15);
    expect(h.store.errors).toHaveLength(1);
    await h.advance(600);
    expect(h.store.overflights.size).toBe(1);
  });

  test('provider rate limits back off and are recorded', async () => {
    let calls = 0;
    const provider: AircraftPositionProvider = {
      name: 'mock',
      async getAircraftNear() {
        calls++;
        throw new ProviderError('rate_limited', 'rate limited', true, 60_000, 429);
      },
    };
    const h = harness({ provider });
    await h.advance(45);
    expect(calls).toBe(1);
    expect(h.store.pollRuns.map((r) => r.status)).toEqual(['rate_limited']);
    await h.advance(60);
    expect(calls).toBe(2);
  });

  test('refused access pauses the provider for the maximum backoff', async () => {
    let calls = 0;
    const provider: AircraftPositionProvider = {
      name: 'adsb_lol',
      async getAircraftNear() {
        calls++;
        throw new ProviderError(
          'access_denied',
          'adsb.lol refused access (HTTP 403)',
          false,
          null,
          403,
        );
      },
    };
    const h = harness({ provider });
    await h.advance(14 * 60); // 14 minutes of 15-second polls
    expect(calls).toBe(1);
    expect(h.store.errors[0]!.errorCode).toBe('access_denied');
    await h.advance(2 * 60);
    expect(calls).toBe(2);
  });

  test('errors recorded by the worker contain no coordinates or URLs', async () => {
    const provider: AircraftPositionProvider = {
      name: 'mock',
      async getAircraftNear() {
        throw new Error('fetch https://api.example/v2/point/0.50000/0.50000/5 failed');
      },
    };
    const h = harness({ provider });
    await h.advance(15);
    const message = h.store.errors[0]!.message;
    expect(message).not.toContain('http');
    expect(message).not.toContain('0.50000');
  });
});
