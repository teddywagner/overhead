import { destination, distanceM, nmToM, type LatLon } from '@overhead/core';
import type { AircraftPositionProvider, AircraftQuery, NormalizedAircraftPosition } from '../types';

/**
 * Deterministic synthetic traffic, generated relative to whatever point is
 * queried. No real coordinates appear in scenarios or fixtures.
 */
export interface MockTrack {
  icao24: string;
  callsign: string | null;
  registration: string | null;
  icaoTypeCode: string | null;
  typeDescription?: string | null;
  operatorName?: string | null;
  /** Seconds after the scenario epoch when the track starts. */
  startS: number;
  durationS: number;
  altitudeFt: number | null;
  climbFpm?: number;
  groundspeedKnots: number;
  onGround?: boolean;
  path:
    | { kind: 'line'; startBearingDeg: number; startDistanceM: number; headingDeg: number }
    | { kind: 'circle'; radiusM: number; startAngleDeg: number; clockwise?: boolean }
    | { kind: 'stationary'; bearingDeg: number; distanceM: number };
}

export interface MockScenario {
  name: string;
  tracks: MockTrack[];
}

const KT_TO_MPS = 1852 / 3600;

export function mockPositionAt(
  track: MockTrack,
  center: LatLon,
  epochMs: number,
  atMs: number,
): NormalizedAircraftPosition | null {
  const t = (atMs - epochMs) / 1000 - track.startS;
  if (t < 0 || t > track.durationS) return null;
  const travelled = track.groundspeedKnots * KT_TO_MPS * t;
  let point: LatLon;
  let heading: number;
  switch (track.path.kind) {
    case 'line': {
      const start = destination(center, track.path.startBearingDeg, track.path.startDistanceM);
      point = destination(start, track.path.headingDeg, travelled);
      heading = track.path.headingDeg;
      break;
    }
    case 'circle': {
      const dir = track.path.clockwise === false ? -1 : 1;
      const angle =
        track.path.startAngleDeg + (dir * ((travelled / track.path.radiusM) * 180)) / Math.PI;
      point = destination(center, angle, track.path.radiusM);
      heading = (((angle + dir * 90) % 360) + 360) % 360;
      break;
    }
    case 'stationary':
      point = destination(center, track.path.bearingDeg, track.path.distanceM);
      heading = 0;
      break;
  }
  const alt =
    track.altitudeFt === null
      ? null
      : Math.round(track.altitudeFt + ((track.climbFpm ?? 0) * t) / 60);
  return {
    icao24: track.icao24,
    callsign: track.callsign,
    registration: track.registration,
    icaoTypeCode: track.icaoTypeCode,
    typeDescription: track.typeDescription ?? null,
    operatorName: track.operatorName ?? null,
    latitude: point.latitude,
    longitude: point.longitude,
    altitudeFt: track.onGround ? 0 : alt,
    onGround: track.onGround ?? false,
    groundspeedKnots: track.groundspeedKnots,
    trackDegrees: heading,
    observedAt: new Date(atMs),
    source: 'mock',
  };
}

/** Straight-line track that passes `missM` from the centre at time `closestAtS`. */
export function crossingTrack(
  base: Omit<MockTrack, 'path' | 'startS' | 'durationS'> & {
    closestAtS: number;
    missM?: number;
    headingDeg?: number;
    legM?: number;
  },
): MockTrack {
  const heading = base.headingDeg ?? 90;
  const legM = base.legM ?? 12_000;
  const speed = base.groundspeedKnots * KT_TO_MPS;
  const leadS = legM / speed;
  // Start behind the closest point along the reverse heading, offset sideways by missM.
  const sideBearing = (heading + 90) % 360;
  const reverse = (heading + 180) % 360;
  const origin = { latitude: 0, longitude: 0 };
  const closest = destination(origin, sideBearing, base.missM ?? 0);
  const start = destination(closest, reverse, legM);
  const { closestAtS: _c, missM: _m, headingDeg: _h, legM: _l, ...rest } = base;
  return {
    ...rest,
    startS: base.closestAtS - leadS,
    durationS: leadS * 2,
    path: {
      kind: 'line',
      startBearingDeg: bearingFromOrigin(start),
      startDistanceM: distanceM(origin, start),
      headingDeg: heading,
    },
  };
}

function bearingFromOrigin(p: LatLon): number {
  return ((Math.atan2(p.longitude, p.latitude) * 180) / Math.PI + 360) % 360;
}

export const MOCK_SCENARIOS: Record<string, MockScenario> = {
  'direct-crossing': {
    name: 'direct-crossing',
    tracks: [
      crossingTrack({
        icao24: 'f00001',
        callsign: 'EXA101',
        registration: 'N101OH',
        icaoTypeCode: 'B738',
        typeDescription: 'BOEING 737-800',
        operatorName: 'Example Air',
        altitudeFt: 4000,
        groundspeedKnots: 250,
        closestAtS: 180,
        missM: 150,
        headingDeg: 88,
      }),
    ],
  },
  'near-miss': {
    name: 'near-miss',
    tracks: [
      crossingTrack({
        icao24: 'f00002',
        callsign: 'SMP202',
        registration: 'N202OH',
        icaoTypeCode: 'A320',
        altitudeFt: 6000,
        groundspeedKnots: 240,
        closestAtS: 180,
        missM: 2100,
        headingDeg: 270,
      }),
    ],
  },
  busy: {
    name: 'busy',
    tracks: [
      crossingTrack({
        icao24: 'f00001',
        callsign: 'EXA101',
        registration: 'N101OH',
        icaoTypeCode: 'B738',
        altitudeFt: 4000,
        groundspeedKnots: 250,
        closestAtS: 180,
        missM: 150,
        headingDeg: 88,
      }),
      crossingTrack({
        icao24: 'f00002',
        callsign: 'SMP202',
        registration: 'N202OH',
        icaoTypeCode: 'A320',
        altitudeFt: 6000,
        groundspeedKnots: 240,
        closestAtS: 300,
        missM: 2100,
        headingDeg: 270,
      }),
      crossingTrack({
        icao24: 'f00005',
        callsign: null,
        registration: null,
        icaoTypeCode: null,
        altitudeFt: 2500,
        groundspeedKnots: 110,
        closestAtS: 420,
        missM: 400,
        headingDeg: 10,
      }),
      {
        icao24: 'f00006',
        callsign: 'TAXI1',
        registration: 'N606OH',
        icaoTypeCode: 'B738',
        startS: 0,
        durationS: 900,
        altitudeFt: 0,
        groundspeedKnots: 12,
        onGround: true,
        path: { kind: 'stationary', bearingDeg: 45, distanceM: 600 },
      },
    ],
  },
};

export interface MockProviderOptions {
  scenario: MockScenario;
  /** Scenario time zero. */
  epoch: Date;
  clock?: () => Date;
  /** Replay the scenario every `loopS` seconds (worker demo mode). */
  loopS?: number;
}

export class MockAircraftProvider implements AircraftPositionProvider {
  readonly name = 'mock' as const;
  constructor(private readonly options: MockProviderOptions) {}

  async getAircraftNear(input: AircraftQuery): Promise<NormalizedAircraftPosition[]> {
    const nowMs = (this.options.clock ?? (() => new Date()))().getTime();
    let epochMs = this.options.epoch.getTime();
    if (this.options.loopS && nowMs > epochMs) {
      const loopMs = this.options.loopS * 1000;
      epochMs += Math.floor((nowMs - epochMs) / loopMs) * loopMs;
    }
    const center = { latitude: input.latitude, longitude: input.longitude };
    const radiusM = nmToM(input.radiusNm);
    const out: NormalizedAircraftPosition[] = [];
    for (const track of this.options.scenario.tracks) {
      const p = mockPositionAt(track, center, epochMs, nowMs);
      if (p && distanceM(center, p) <= radiusM) out.push(p);
    }
    return out;
  }
}

/** Replays pre-built frames in order; used to script edge cases in tests. */
export class ScriptedProvider implements AircraftPositionProvider {
  readonly name = 'mock' as const;
  private index = 0;
  constructor(private readonly frames: NormalizedAircraftPosition[][]) {}
  async getAircraftNear(): Promise<NormalizedAircraftPosition[]> {
    const frame = this.frames[this.index] ?? [];
    this.index++;
    return frame.map((p) => ({ ...p, observedAt: new Date(p.observedAt) }));
  }
}
