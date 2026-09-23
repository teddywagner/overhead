import {
  crossingTrack,
  mockPositionAt,
  processTick,
  type ActivePass,
  type DetectionLocation,
  type FinalizedPass,
  type MockTrack,
  type NormalizedAircraftPosition,
  type TickResult,
} from '../src';

/** Obviously fake test site next to Null Island. */
export const LOCATION: DetectionLocation = {
  id: '22222222-2222-4222-8222-222222222222',
  ownerId: '11111111-1111-4111-8111-111111111111',
  latitude: 0.5,
  longitude: 0.5,
  searchRadiusNm: 5,
  overheadRadiusM: 1200,
  maxAltitudeFt: 15000,
  timezone: 'America/New_York',
};

export const T0 = Date.parse('2026-09-20T14:00:00Z');

export { crossingTrack };

export interface SimOptions {
  location?: DetectionLocation;
  epochMs?: number;
  startS?: number;
  endS?: number;
  stepS?: number;
  /** Seconds (relative to epoch) during which the provider returns nothing. */
  dropWindows?: Array<[number, number]>;
  /** Mutate each frame before it is processed (duplicates, shuffles...). */
  transformFrame?: (
    frame: NormalizedAircraftPosition[],
    tS: number,
  ) => NormalizedAircraftPosition[];
  /** Simulate a worker restart (JSON round-trip of state) at these seconds. */
  restartAtS?: number[];
  active?: ActivePass[];
}

export interface SimResult {
  finalized: FinalizedPass[];
  active: ActivePass[];
  ticks: TickResult[];
}

export function frameAt(
  tracks: MockTrack[],
  location: DetectionLocation,
  epochMs: number,
  tS: number,
): NormalizedAircraftPosition[] {
  const out: NormalizedAircraftPosition[] = [];
  for (const t of tracks) {
    const p = mockPositionAt(t, location, epochMs, epochMs + tS * 1000);
    if (p) out.push(p);
  }
  return out;
}

/** Drive the state machine the way the worker does, one poll per step. */
export function simulate(tracks: MockTrack[], opts: SimOptions = {}): SimResult {
  const location = opts.location ?? LOCATION;
  const epochMs = opts.epochMs ?? T0;
  const step = opts.stepS ?? 15;
  const end = opts.endS ?? 1800;
  let active: ActivePass[] = opts.active ?? [];
  const finalized: FinalizedPass[] = [];
  const ticks: TickResult[] = [];

  for (let t = opts.startS ?? 0; t <= end; t += step) {
    if (opts.restartAtS?.includes(t)) {
      // Everything the worker knows after a restart is what was persisted.
      active = JSON.parse(JSON.stringify(active)) as ActivePass[];
    }
    const dropped = opts.dropWindows?.some(([a, b]) => t >= a && t <= b) ?? false;
    let frame = dropped ? [] : frameAt(tracks, location, epochMs, t);
    if (opts.transformFrame) frame = opts.transformFrame(frame, t);
    const result = processTick({
      location,
      provider: 'mock',
      now: new Date(epochMs + t * 1000),
      positions: frame,
      active,
    });
    ticks.push(result);
    const byIcao = new Map(active.map((a) => [a.icao24, a]));
    for (const f of result.finalized) byIcao.delete(f.pass.icao24);
    for (const u of result.upserts) byIcao.set(u.icao24, u);
    active = [...byIcao.values()];
    finalized.push(...result.finalized);
  }
  return { finalized, active, ticks };
}

export const recorded = (r: SimResult) =>
  r.finalized.map((f) => f.overflight).filter((o) => o !== null);
