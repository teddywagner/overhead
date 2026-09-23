import {
  bearingDeg,
  distanceM,
  isValidCoordinate,
  localDate,
  nmToM,
  pointToSegment,
  type LatLon,
  type ProviderName,
} from '@overhead/core';
import type { NormalizedAircraftPosition } from '../types';
import {
  DEFAULT_DETECTION_PARAMS,
  type ActivePass,
  type ClosestApproach,
  type DetectionLocation,
  type DetectionParams,
  type FinalizeReason,
  type FinalizedPass,
  type OverflightDraft,
  type PassSample,
  type RejectReason,
  type TickResult,
} from './types';

const MPS_PER_KNOT = 1852 / 3600;

/**
 * Longest gap between consecutive samples over which the track is assumed
 * straight when searching for the closest approach. Longer gaps only
 * contribute their endpoints.
 */
const MAX_INTERPOLATION_GAP_S = 120;

export interface TickInput {
  location: DetectionLocation;
  provider: ProviderName;
  now: Date;
  positions: NormalizedAircraftPosition[];
  active: ActivePass[];
  params?: Partial<DetectionParams>;
}

/**
 * Pure overflight state machine. Given the persisted active passes for one
 * location and the latest provider observations, returns the passes to
 * upsert and the passes that ended. Idempotent with respect to duplicate
 * and out-of-order observations, and restart-safe because all state lives
 * in the returned ActivePass records.
 */
export function processTick(input: TickInput): TickResult {
  const params: DetectionParams = { ...DEFAULT_DETECTION_PARAMS, ...input.params };
  const { location, now } = input;
  const center: LatLon = { latitude: location.latitude, longitude: location.longitude };
  const searchRadiusM = nmToM(location.searchRadiusNm);

  const passes = new Map<string, ActivePass>(
    input.active.map((a) => [a.icao24, structuredClone(a)] as const),
  );
  const touched = new Set<string>();
  const finalized: FinalizedPass[] = [];
  const rejected: TickResult['rejected'] = [];
  let started = 0;

  const end = (pass: ActivePass, reason: FinalizeReason) => {
    finalized.push(finalizePass(pass, reason, location, params));
    passes.delete(pass.icao24);
    touched.delete(pass.icao24);
  };

  const ordered = [...input.positions].sort(
    (a, b) => a.observedAt.getTime() - b.observedAt.getTime() || a.icao24.localeCompare(b.icao24),
  );
  const seen = new Set<string>();

  for (const pos of ordered) {
    const obsMs = pos.observedAt.getTime();
    const dedupeKey = `${pos.icao24}@${obsMs}`;
    if (seen.has(dedupeKey)) {
      rejected.push({ icao24: pos.icao24, reason: 'duplicate' });
      continue;
    }
    seen.add(dedupeKey);

    let pass = passes.get(pos.icao24);
    const invalid = validateSample(pos, now, params);
    if (invalid) {
      rejected.push({ icao24: pos.icao24, reason: invalid });
      if (pass) {
        pass.state.rejectedSamples++;
        touched.add(pass.icao24);
      }
      continue;
    }

    const sample = toSample(pos);
    const inside = distanceM(center, sample) <= searchRadiusM;

    if (pass) {
      const currentMs = Date.parse(pass.current.observedAt);
      if (obsMs <= currentMs) {
        rejected.push({
          icao24: pos.icao24,
          reason: obsMs === currentMs ? 'duplicate' : 'out_of_order',
        });
        continue;
      }
      if ((obsMs - Date.parse(pass.lastSeenAt)) / 1000 > params.gapTimeoutS) {
        // Same aircraft, new pass: close the old one first.
        end(pass, 'gap');
        pass = undefined;
      } else {
        const dtS = (obsMs - currentMs) / 1000;
        const impliedKnots = distanceM(pass.current, sample) / dtS / MPS_PER_KNOT;
        if (impliedKnots > params.maxPlausibleSpeedKnots) {
          rejected.push({ icao24: pos.icao24, reason: 'implausible_jump' });
          pass.state.rejectedSamples++;
          touched.add(pass.icao24);
          continue;
        }
      }
    }

    if (!pass) {
      if (!inside) continue;
      pass = startPass(pos, sample, input, center, params);
      passes.set(pass.icao24, pass);
      touched.add(pass.icao24);
      started++;
      continue;
    }

    advancePass(pass, pos, sample, center, location, params);
    touched.add(pass.icao24);
    if (!inside) end(pass, 'exited');
  }

  for (const pass of [...passes.values()]) {
    if ((now.getTime() - Date.parse(pass.lastSeenAt)) / 1000 > params.gapTimeoutS) {
      end(pass, 'timeout');
    }
  }

  const upserts = [...touched]
    .map((icao) => passes.get(icao))
    .filter((p): p is ActivePass => p !== undefined);

  return { upserts, finalized, started, rejected };
}

export function validateSample(
  pos: NormalizedAircraftPosition,
  now: Date,
  params: DetectionParams,
): RejectReason | null {
  if (!isValidCoordinate(pos) || Number.isNaN(pos.observedAt.getTime())) return 'invalid_position';
  if (pos.onGround) return 'on_ground';
  const ageS = (now.getTime() - pos.observedAt.getTime()) / 1000;
  if (ageS > params.staleSampleS) return 'stale';
  if (ageS < -params.futureToleranceS) return 'future_timestamp';
  if (
    pos.altitudeFt !== null &&
    (pos.altitudeFt < params.minPlausibleAltitudeFt ||
      pos.altitudeFt > params.maxPlausibleAltitudeFt)
  ) {
    return 'implausible_altitude';
  }
  if (
    pos.groundspeedKnots !== null &&
    pos.groundspeedKnots < params.minAirborneSpeedKnots &&
    (pos.altitudeFt === null || pos.altitudeFt < params.lowAltitudeFt)
  ) {
    return 'taxiing_or_stationary';
  }
  if (pos.groundspeedKnots !== null && pos.groundspeedKnots > params.maxPlausibleSpeedKnots) {
    return 'implausible_jump';
  }
  return null;
}

/** Deterministic key: provider, ICAO address and first accepted observation second. */
export function providerPassKey(provider: ProviderName, icao24: string, firstSeen: Date): string {
  return `${provider}:${icao24}:${Math.floor(firstSeen.getTime() / 1000)}`;
}

function toSample(pos: NormalizedAircraftPosition): PassSample {
  return {
    observedAt: pos.observedAt.toISOString(),
    latitude: pos.latitude,
    longitude: pos.longitude,
    altitudeFt: pos.altitudeFt,
    groundspeedKnots: pos.groundspeedKnots,
    trackDegrees: pos.trackDegrees,
  };
}

function qualifies(c: ClosestApproach, location: DetectionLocation): boolean {
  return (
    c.distanceM <= location.overheadRadiusM &&
    c.altitudeFt !== null &&
    c.altitudeFt <= location.maxAltitudeFt
  );
}

function startPass(
  pos: NormalizedAircraftPosition,
  sample: PassSample,
  input: TickInput,
  center: LatLon,
  _params: DetectionParams,
): ActivePass {
  const closest: ClosestApproach = {
    distanceM: distanceM(center, sample),
    observedAt: sample.observedAt,
    latitude: sample.latitude,
    longitude: sample.longitude,
    altitudeFt: sample.altitudeFt,
    headingDeg: sample.trackDegrees,
  };
  return {
    ownerId: input.location.ownerId,
    locationId: input.location.id,
    provider: input.provider,
    icao24: pos.icao24,
    providerPassKey: providerPassKey(input.provider, pos.icao24, pos.observedAt),
    aircraftId: null,
    callsign: pos.callsign,
    firstSeenAt: sample.observedAt,
    lastSeenAt: sample.observedAt,
    closestSeenAt: sample.observedAt,
    minimumDistanceM: closest.distanceM,
    minimumAltitudeFt: sample.altitudeFt,
    prev: null,
    current: sample,
    sampleCount: 1,
    state: {
      version: 1,
      registration: pos.registration,
      icaoTypeCode: pos.icaoTypeCode,
      typeDescription: pos.typeDescription,
      operatorName: pos.operatorName,
      closest,
      crossing: qualifies(closest, input.location) ? closest : null,
      points: [sample],
      rejectedSamples: 0,
    },
  };
}

function interpolate(a: number | null, b: number | null, f: number): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + (b - a) * f;
}

function advancePass(
  pass: ActivePass,
  pos: NormalizedAircraftPosition,
  sample: PassSample,
  center: LatLon,
  location: DetectionLocation,
  params: DetectionParams,
): void {
  const from = pass.current;
  const fromMs = Date.parse(from.observedAt);
  const toMs = Date.parse(sample.observedAt);
  const gapS = (toMs - fromMs) / 1000;

  const candidates: ClosestApproach[] = [];
  const segmentHeading =
    distanceM(from, sample) > 1 ? bearingDeg(from, sample) : sample.trackDegrees;
  if (gapS <= MAX_INTERPOLATION_GAP_S) {
    const proj = pointToSegment(center, from, sample);
    const alt = interpolate(from.altitudeFt, sample.altitudeFt, proj.fraction);
    candidates.push({
      distanceM: proj.distanceM,
      observedAt: new Date(Math.round(fromMs + (toMs - fromMs) * proj.fraction)).toISOString(),
      latitude: proj.closest.latitude,
      longitude: proj.closest.longitude,
      altitudeFt: alt === null ? null : Math.round(alt),
      headingDeg: segmentHeading === null ? null : Math.round(segmentHeading * 10) / 10,
    });
  } else {
    candidates.push({
      distanceM: distanceM(center, sample),
      observedAt: sample.observedAt,
      latitude: sample.latitude,
      longitude: sample.longitude,
      altitudeFt: sample.altitudeFt,
      headingDeg: sample.trackDegrees,
    });
  }

  for (const c of candidates) {
    if (c.distanceM < pass.state.closest.distanceM) {
      pass.state.closest = c;
      pass.closestSeenAt = c.observedAt;
      pass.minimumDistanceM = c.distanceM;
    }
    if (
      qualifies(c, location) &&
      (!pass.state.crossing || c.distanceM < pass.state.crossing.distanceM)
    ) {
      pass.state.crossing = c;
    }
  }

  pass.prev = from;
  pass.current = sample;
  pass.lastSeenAt = sample.observedAt;
  pass.sampleCount++;
  if (sample.altitudeFt !== null) {
    pass.minimumAltitudeFt =
      pass.minimumAltitudeFt === null
        ? sample.altitudeFt
        : Math.min(pass.minimumAltitudeFt, sample.altitudeFt);
  }
  pass.callsign = pos.callsign ?? pass.callsign;
  pass.state.registration = pos.registration ?? pass.state.registration;
  pass.state.icaoTypeCode = pos.icaoTypeCode ?? pass.state.icaoTypeCode;
  pass.state.typeDescription = pos.typeDescription ?? pass.state.typeDescription;
  pass.state.operatorName = pos.operatorName ?? pass.state.operatorName;

  const lastPoint = pass.state.points[pass.state.points.length - 1];
  if (
    pass.state.points.length < params.maxPointsPerPass &&
    (!lastPoint || (toMs - Date.parse(lastPoint.observedAt)) / 1000 >= params.pointSampleS)
  ) {
    pass.state.points.push(sample);
  }
}

export function finalizePass(
  pass: ActivePass,
  reason: FinalizeReason,
  location: DetectionLocation,
  params: DetectionParams = DEFAULT_DETECTION_PARAMS,
): FinalizedPass {
  if (pass.sampleCount < params.minSamplesToRecord) {
    return { pass, reason, overflight: null, dropReason: 'too_few_samples' };
  }
  const nearMissRadiusM = params.nearMissRadiusM ?? Math.max(location.overheadRadiusM * 3, 3000);
  const { closest, crossing } = pass.state;

  let status: OverflightDraft['status'];
  let qualificationReason: OverflightDraft['qualificationReason'];
  if (crossing) {
    status = 'qualified';
    qualificationReason = 'crossed_within_overhead_radius';
  } else if (closest.distanceM <= location.overheadRadiusM) {
    status = 'near_miss';
    qualificationReason = closest.altitudeFt === null ? 'unknown_altitude' : 'above_max_altitude';
  } else if (closest.distanceM <= nearMissRadiusM) {
    status = 'near_miss';
    qualificationReason = 'outside_overhead_radius';
  } else {
    return { pass, reason, overflight: null, dropReason: 'too_far' };
  }

  const chosen = crossing ?? closest;
  const points: OverflightDraft['points'] = pass.state.points.map((p) => ({
    ...p,
    source: 'provider',
  }));
  const lastPoint = pass.state.points[pass.state.points.length - 1];
  if (!lastPoint || lastPoint.observedAt !== pass.current.observedAt) {
    points.push({ ...pass.current, source: 'provider' });
  }
  points.push({
    observedAt: chosen.observedAt,
    latitude: chosen.latitude,
    longitude: chosen.longitude,
    altitudeFt: chosen.altitudeFt,
    groundspeedKnots: null,
    trackDegrees: chosen.headingDeg,
    source: 'closest_approach',
  });

  return {
    pass,
    reason,
    dropReason: null,
    overflight: {
      ownerId: pass.ownerId,
      locationId: pass.locationId,
      provider: pass.provider,
      providerPassKey: pass.providerPassKey,
      icao24: pass.icao24,
      registration: pass.state.registration,
      callsign: pass.callsign,
      icaoTypeCode: pass.state.icaoTypeCode,
      typeDescription: pass.state.typeDescription,
      operatorName: pass.state.operatorName,
      firstSeenAt: pass.firstSeenAt,
      closestSeenAt: chosen.observedAt,
      lastSeenAt: pass.lastSeenAt,
      localDate: localDate(new Date(chosen.observedAt), location.timezone),
      minimumDistanceM: Math.round(chosen.distanceM * 10) / 10,
      minimumAltitudeFt: pass.minimumAltitudeFt,
      closestAltitudeFt: chosen.altitudeFt,
      closestLatitude: chosen.latitude,
      closestLongitude: chosen.longitude,
      heading: chosen.headingDeg === null ? null : ((chosen.headingDeg % 360) + 360) % 360,
      status,
      qualificationReason,
      rawSummary: {
        detection_version: 1,
        finalize_reason: reason,
        sample_count: pass.sampleCount,
        rejected_samples: pass.state.rejectedSamples,
        absolute_closest_m: Math.round(closest.distanceM * 10) / 10,
        type_description: pass.state.typeDescription,
        operator_name: pass.state.operatorName,
      },
      points,
    },
  };
}
