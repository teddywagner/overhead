import type { OverflightStatus, ProviderName, QualificationReason } from '@overhead/core';

export interface DetectionLocation {
  id: string;
  ownerId: string;
  latitude: number;
  longitude: number;
  searchRadiusNm: number;
  overheadRadiusM: number;
  maxAltitudeFt: number;
  timezone: string;
}

export interface DetectionParams {
  /** Finalise a pass after this long without an accepted observation. */
  gapTimeoutS: number;
  /** Reject samples whose measurement time is older than this at poll time. */
  staleSampleS: number;
  /** Reject samples timestamped further than this into the future. */
  futureToleranceS: number;
  /** Implied speed between consecutive samples above this is implausible. */
  maxPlausibleSpeedKnots: number;
  /** Below this ground speed and altitude an aircraft counts as taxiing/parked. */
  minAirborneSpeedKnots: number;
  lowAltitudeFt: number;
  /** Altitudes outside this band are implausible. */
  minPlausibleAltitudeFt: number;
  maxPlausibleAltitudeFt: number;
  /** Near misses within this distance are recorded; farther passes are dropped. */
  nearMissRadiusM: number | null;
  /** Passes with fewer accepted samples are dropped. */
  minSamplesToRecord: number;
  /** Keep at most one sampled point per this many seconds. */
  pointSampleS: number;
  maxPointsPerPass: number;
}

export const DEFAULT_DETECTION_PARAMS: DetectionParams = {
  gapTimeoutS: 300,
  staleSampleS: 60,
  futureToleranceS: 10,
  maxPlausibleSpeedKnots: 1000,
  minAirborneSpeedKnots: 40,
  lowAltitudeFt: 1000,
  minPlausibleAltitudeFt: -1500,
  maxPlausibleAltitudeFt: 70_000,
  nearMissRadiusM: null,
  minSamplesToRecord: 2,
  pointSampleS: 30,
  maxPointsPerPass: 200,
};

/** One observation retained inside the pass state (ISO timestamps: JSON-safe). */
export interface PassSample {
  observedAt: string;
  latitude: number;
  longitude: number;
  altitudeFt: number | null;
  groundspeedKnots: number | null;
  trackDegrees: number | null;
}

export interface ClosestApproach {
  distanceM: number;
  observedAt: string;
  latitude: number;
  longitude: number;
  altitudeFt: number | null;
  headingDeg: number | null;
}

/** Everything the state machine needs beyond the indexed columns. */
export interface PassDetail {
  version: 1;
  registration: string | null;
  icaoTypeCode: string | null;
  typeDescription: string | null;
  operatorName: string | null;
  closest: ClosestApproach;
  /** Best approach that satisfies both radius and altitude, if any. */
  crossing: ClosestApproach | null;
  points: PassSample[];
  rejectedSamples: number;
}

/**
 * Persisted active pass. Field-for-field this is private.active_passes, so a
 * worker restart reconstructs the exact state from the database.
 */
export interface ActivePass {
  ownerId: string;
  locationId: string;
  provider: ProviderName;
  icao24: string;
  providerPassKey: string;
  aircraftId: string | null;
  callsign: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  closestSeenAt: string;
  minimumDistanceM: number;
  minimumAltitudeFt: number | null;
  prev: PassSample | null;
  current: PassSample;
  sampleCount: number;
  state: PassDetail;
}

export type FinalizeReason = 'exited' | 'timeout' | 'gap';

export interface OverflightDraft {
  ownerId: string;
  locationId: string;
  provider: ProviderName;
  providerPassKey: string;
  icao24: string;
  registration: string | null;
  callsign: string | null;
  icaoTypeCode: string | null;
  typeDescription: string | null;
  operatorName: string | null;
  firstSeenAt: string;
  closestSeenAt: string;
  lastSeenAt: string;
  localDate: string;
  minimumDistanceM: number;
  minimumAltitudeFt: number | null;
  closestAltitudeFt: number | null;
  closestLatitude: number;
  closestLongitude: number;
  heading: number | null;
  status: OverflightStatus;
  qualificationReason: QualificationReason;
  rawSummary: Record<string, unknown>;
  points: Array<PassSample & { source: 'provider' | 'closest_approach' }>;
}

export interface FinalizedPass {
  pass: ActivePass;
  reason: FinalizeReason;
  /** null when the pass was too far or too short to record. */
  overflight: OverflightDraft | null;
  dropReason: 'too_few_samples' | 'too_far' | null;
}

export type RejectReason =
  | 'invalid_position'
  | 'on_ground'
  | 'taxiing_or_stationary'
  | 'stale'
  | 'future_timestamp'
  | 'implausible_altitude'
  | 'implausible_jump'
  | 'out_of_order'
  | 'duplicate';

export interface TickResult {
  /** Passes to insert or update in the active store. */
  upserts: ActivePass[];
  /** Passes that ended this tick (remove from the active store). */
  finalized: FinalizedPass[];
  started: number;
  rejected: Array<{ icao24: string; reason: RejectReason }>;
}
