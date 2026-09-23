import { describe, expect, test } from 'bun:test';
import { destination } from '@overhead/core';
import {
  processTick,
  providerPassKey,
  type MockTrack,
  type NormalizedAircraftPosition,
} from '../src';
import { LOCATION, T0, crossingTrack, frameAt, recorded, simulate } from './helpers';

const jet = (overrides: Partial<Parameters<typeof crossingTrack>[0]> = {}) =>
  crossingTrack({
    icao24: 'f00001',
    callsign: 'EXA101',
    registration: 'N101OH',
    icaoTypeCode: 'B738',
    altitudeFt: 4000,
    groundspeedKnots: 250,
    closestAtS: 300,
    missM: 150,
    headingDeg: 88,
    ...overrides,
  });

describe('overflight state machine', () => {
  test('direct crossing produces exactly one qualifying overflight', () => {
    const r = simulate([jet()]);
    const rows = recorded(r);
    expect(rows).toHaveLength(1);
    const o = rows[0]!;
    expect(o.status).toBe('qualified');
    expect(o.qualificationReason).toBe('crossed_within_overhead_radius');
    expect(o.minimumDistanceM).toBeLessThan(200);
    expect(o.minimumDistanceM).toBeGreaterThan(100);
    expect(o.closestAltitudeFt).toBe(4000);
    expect(o.heading).toBeGreaterThan(80);
    expect(o.heading).toBeLessThan(96);
    expect(Date.parse(o.closestSeenAt)).toBeGreaterThanOrEqual(Date.parse(o.firstSeenAt));
    expect(Date.parse(o.closestSeenAt)).toBeLessThanOrEqual(Date.parse(o.lastSeenAt));
    expect(o.providerPassKey).toBe(providerPassKey('mock', 'f00001', new Date(o.firstSeenAt)));
    expect(r.finalized[0]!.reason).toBe('exited');
    expect(r.active).toHaveLength(0);
    // Sampled points are bounded and include the closest approach.
    expect(o.points.some((p) => p.source === 'closest_approach')).toBe(true);
    expect(o.points.length).toBeLessThan(r.finalized[0]!.pass.sampleCount + 2);
  });

  test('segment distance catches a crossing that no individual sample is near', () => {
    // 480 kt jet sampled every 60 s: consecutive samples are ~15 km apart,
    // so no sample falls within the overhead radius, but the track does.
    const fast = jet({ groundspeedKnots: 480, closestAtS: 330, missM: 300, legM: 9000 });
    const r = simulate([fast], { stepS: 60 });
    const [o] = recorded(r);
    expect(o?.status).toBe('qualified');
    expect(o?.minimumDistanceM).toBeLessThan(400);
  });

  test('near miss is recorded but does not qualify', () => {
    const r = simulate([jet({ missM: 2100, headingDeg: 270 })]);
    const rows = recorded(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('near_miss');
    expect(rows[0]!.qualificationReason).toBe('outside_overhead_radius');
    expect(rows[0]!.minimumDistanceM).toBeGreaterThan(2000);
  });

  test('distant passes are dropped entirely', () => {
    const r = simulate([jet({ missM: 7000 })]);
    expect(recorded(r)).toHaveLength(0);
    expect(r.finalized.every((f) => f.dropReason === 'too_far')).toBe(true);
  });

  test('crossing above the maximum altitude is a near miss', () => {
    const [o] = recorded(simulate([jet({ altitudeFt: 22000 })]));
    expect(o?.status).toBe('near_miss');
    expect(o?.qualificationReason).toBe('above_max_altitude');
  });

  test('aircraft circling the location yields a single pass', () => {
    const circle = (radiusM: number): MockTrack => ({
      icao24: 'f00007',
      callsign: 'CIRC1',
      registration: 'N707OH',
      icaoTypeCode: 'EC35',
      startS: 0,
      durationS: 1500,
      altitudeFt: 1500,
      groundspeedKnots: 90,
      path: { kind: 'circle', radiusM, startAngleDeg: 0 },
    });
    const inside = recorded(simulate([circle(800)], { endS: 2100 }));
    expect(inside).toHaveLength(1);
    expect(inside[0]!.status).toBe('qualified');

    const outside = recorded(simulate([circle(2500)], { endS: 2100 }));
    expect(outside).toHaveLength(1);
    expect(outside[0]!.status).toBe('near_miss');
  });

  test('missing samples around the closest approach are bridged', () => {
    const r = simulate([jet()], { dropWindows: [[255, 330]] });
    const rows = recorded(r);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('qualified');
    expect(rows[0]!.minimumDistanceM).toBeLessThan(250);
  });

  test('a gap longer than the timeout finalises and starts a new pass', () => {
    const slow: MockTrack = {
      icao24: 'f00008',
      callsign: null,
      registration: 'N808OH',
      icaoTypeCode: 'C172',
      startS: 0,
      durationS: 1500,
      altitudeFt: 2000,
      groundspeedKnots: 45,
      path: { kind: 'circle', radiusM: 600, startAngleDeg: 0 },
    };
    const r = simulate([slow], { dropWindows: [[300, 660]], endS: 2000 });
    const rows = recorded(r);
    expect(rows).toHaveLength(2);
    expect(r.finalized.map((f) => f.reason)).toContain('timeout');
    expect(new Set(rows.map((o) => o.providerPassKey)).size).toBe(2);
  });

  test('duplicate provider responses do not change the result', () => {
    const clean = recorded(simulate([jet()]));
    const dup = simulate([jet()], {
      stepS: 15,
      transformFrame: (frame) => [...frame, ...frame.map((p) => ({ ...p }))],
    });
    // Replaying the identical previous frame (provider cache) is also harmless.
    let last: NormalizedAircraftPosition[] = [];
    const replay = simulate([jet()], {
      stepS: 5,
      transformFrame: (frame, t) => {
        if (t % 15 !== 0) return last;
        last = frame;
        return frame;
      },
    });
    expect(recorded(dup)).toEqual(clean);
    expect(recorded(replay)).toHaveLength(1);
    expect(recorded(replay)[0]!.providerPassKey).toBe(clean[0]!.providerPassKey);
    expect(dup.ticks.some((t) => t.rejected.some((x) => x.reason === 'duplicate'))).toBe(true);
  });

  test('a worker restart mid-pass reproduces the uninterrupted result', () => {
    const uninterrupted = recorded(simulate([jet()]));
    const restarted = recorded(simulate([jet()], { restartAtS: [150, 300, 315] }));
    expect(restarted).toEqual(uninterrupted);
  });

  test('a restart after a long outage finalises the stale pass exactly once', () => {
    const before = simulate([jet()], { endS: 300 });
    expect(before.active).toHaveLength(1);
    const persisted = JSON.parse(JSON.stringify(before.active));
    // Worker comes back 20 minutes later; the aircraft is long gone.
    const after = simulate([], { active: persisted, startS: 1500, endS: 1530 });
    expect(recorded(after)).toHaveLength(1);
    expect(after.finalized[0]!.reason).toBe('timeout');
    expect(after.active).toHaveLength(0);
  });

  test('local date follows the location time zone across midnight', () => {
    // 03:59:00Z on 21 Sep is 23:59 on 20 Sep in New York (EDT, UTC-4).
    const epoch = Date.parse('2026-09-21T03:54:00Z');
    const before = recorded(simulate([jet({ closestAtS: 290 })], { epochMs: epoch }));
    expect(before[0]!.localDate).toBe('2026-09-20');
    const after = recorded(simulate([jet({ closestAtS: 390 })], { epochMs: epoch }));
    expect(after[0]!.localDate).toBe('2026-09-21');
    // Same instants in UTC would both be the 21st.
    const utc = recorded(
      simulate([jet({ closestAtS: 290 })], {
        epochMs: epoch,
        location: { ...LOCATION, timezone: 'UTC' },
      }),
    );
    expect(utc[0]!.localDate).toBe('2026-09-21');
  });

  test('two passes by the same aircraft are two overflights', () => {
    const first = jet({ closestAtS: 300 });
    const second = jet({ closestAtS: 1500, headingDeg: 268 });
    const rows = recorded(simulate([first, second], { endS: 2400 }));
    expect(rows).toHaveLength(2);
    expect(rows.every((o) => o.icao24 === 'f00001' && o.status === 'qualified')).toBe(true);
    expect(rows[0]!.providerPassKey).not.toBe(rows[1]!.providerPassKey);
  });

  test('unknown registration and unknown type are recorded as null', () => {
    const [o] = recorded(
      simulate([jet({ registration: null, icaoTypeCode: null, callsign: null })]),
    );
    expect(o?.status).toBe('qualified');
    expect(o?.registration).toBeNull();
    expect(o?.icaoTypeCode).toBeNull();
    expect(o?.callsign).toBeNull();
  });

  test('unknown altitude never qualifies', () => {
    const [o] = recorded(simulate([jet({ altitudeFt: null })]));
    expect(o?.status).toBe('near_miss');
    expect(o?.qualificationReason).toBe('unknown_altitude');
  });

  test('taxiing, parked and stationary aircraft are rejected', () => {
    const parked: MockTrack = {
      icao24: 'f00009',
      callsign: 'PARK1',
      registration: null,
      icaoTypeCode: 'B738',
      startS: 0,
      durationS: 1800,
      altitudeFt: 0,
      groundspeedKnots: 0,
      onGround: true,
      path: { kind: 'stationary', bearingDeg: 10, distanceM: 50 },
    };
    const taxiing: MockTrack = {
      icao24: 'f0000a',
      callsign: 'TAXI2',
      registration: null,
      icaoTypeCode: 'A320',
      startS: 0,
      durationS: 1800,
      altitudeFt: 50,
      groundspeedKnots: 15,
      path: { kind: 'line', startBearingDeg: 0, startDistanceM: 300, headingDeg: 180 },
    };
    const r = simulate([parked, taxiing]);
    expect(recorded(r)).toHaveLength(0);
    expect(r.finalized).toHaveLength(0);
    const reasons = new Set(r.ticks.flatMap((t) => t.rejected.map((x) => x.reason)));
    expect(reasons.has('on_ground')).toBe(true);
    expect(reasons.has('taxiing_or_stationary')).toBe(true);
  });

  test('out-of-order provider timestamps are ignored', () => {
    const clean = recorded(simulate([jet()]));
    const history: NormalizedAircraftPosition[][] = [];
    const shuffled = simulate([jet()], {
      transformFrame: (frame) => {
        // Re-deliver the frame from two polls ago (older than the pass's
        // current sample) in reverse order alongside the current one.
        const older = history.length >= 2 ? history[history.length - 2]! : [];
        history.push(frame);
        return [...frame, ...older.map((p) => ({ ...p }))].reverse();
      },
    });
    expect(recorded(shuffled)).toEqual(clean);
    expect(shuffled.ticks.some((t) => t.rejected.some((x) => x.reason === 'out_of_order'))).toBe(
      true,
    );
  });

  test('stale, future-dated and physically implausible samples are rejected', () => {
    const now = new Date(T0 + 300_000);
    const base = frameAt([jet()], LOCATION, T0, 300)[0]!;
    const start = processTick({
      location: LOCATION,
      provider: 'mock',
      now,
      positions: [base],
      active: [],
    });
    expect(start.upserts).toHaveLength(1);

    const far = destination(LOCATION, 0, 8000);
    const teleport: NormalizedAircraftPosition = {
      ...base,
      ...far,
      observedAt: new Date(now.getTime() + 5000),
    };
    const stale: NormalizedAircraftPosition = {
      ...base,
      icao24: 'f0000b',
      observedAt: new Date(T0),
    };
    const future: NormalizedAircraftPosition = {
      ...base,
      icao24: 'f0000c',
      observedAt: new Date(now.getTime() + 120_000),
    };
    const next = processTick({
      location: LOCATION,
      provider: 'mock',
      now: new Date(now.getTime() + 5000),
      positions: [teleport, stale, future],
      active: start.upserts,
    });
    const reasons = next.rejected.map((r) => r.reason).sort();
    expect(reasons).toEqual(['future_timestamp', 'implausible_jump', 'stale']);
    expect(next.upserts[0]!.state.rejectedSamples).toBe(1);
    expect(next.upserts[0]!.sampleCount).toBe(1);
  });

  test('processTick does not mutate its inputs', () => {
    const first = simulate([jet()], { endS: 240 });
    const snapshot = JSON.stringify(first.active);
    processTick({
      location: LOCATION,
      provider: 'mock',
      now: new Date(T0 + 255_000),
      positions: frameAt([jet()], LOCATION, T0, 255),
      active: first.active,
    });
    expect(JSON.stringify(first.active)).toBe(snapshot);
  });
});
