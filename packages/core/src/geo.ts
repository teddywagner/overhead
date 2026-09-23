/**
 * Geodesy on a spherical Earth (IUGG mean radius). Over the few-kilometre
 * distances used for overflight detection the error versus the WGS-84
 * ellipsoid is well under 0.5%, far below ADS-B position noise.
 */
export const EARTH_RADIUS_M = 6_371_008.8;
export const METERS_PER_NM = 1852;
export const FEET_PER_METER = 3.280_839_895;

export interface LatLon {
  latitude: number;
  longitude: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Central angle between two points (radians), haversine formulation. */
function angularDistance(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.latitude);
  const φ2 = toRad(b.latitude);
  const dφ = φ2 - φ1;
  const dλ = toRad(b.longitude - a.longitude);
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

/** Great-circle distance in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  return angularDistance(a, b) * EARTH_RADIUS_M;
}

/** Initial great-circle bearing from a to b, radians. */
function bearingRad(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.latitude);
  const φ2 = toRad(b.latitude);
  const dλ = toRad(b.longitude - a.longitude);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return Math.atan2(y, x);
}

/** Initial bearing in degrees, 0–360. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  return (toDeg(bearingRad(a, b)) + 360) % 360;
}

/** Destination point given a start, bearing (degrees) and distance (metres). */
export function destination(start: LatLon, bearingDegrees: number, distM: number): LatLon {
  const δ = distM / EARTH_RADIUS_M;
  const θ = toRad(bearingDegrees);
  const φ1 = toRad(start.latitude);
  const λ1 = toRad(start.longitude);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { latitude: toDeg(φ2), longitude: ((toDeg(λ2) + 540) % 360) - 180 };
}

export interface SegmentProjection {
  /** Shortest distance from the point to the segment, metres. */
  distanceM: number;
  /** Fraction along the segment (0 = start, 1 = end) of the closest point. */
  fraction: number;
  /** The closest point on the segment. */
  closest: LatLon;
}

/**
 * Shortest geodesic distance from point p to the great-circle segment a→b,
 * using cross-track / along-track distances and clamping to the endpoints.
 */
export function pointToSegment(p: LatLon, a: LatLon, b: LatLon): SegmentProjection {
  const δ12 = angularDistance(a, b);
  if (δ12 < 1e-12) {
    return { distanceM: distanceM(p, a), fraction: 0, closest: { ...a } };
  }
  const δ13 = angularDistance(a, p);
  const θ12 = bearingRad(a, b);
  const θ13 = bearingRad(a, p);
  const δxt = Math.asin(clamp(Math.sin(δ13) * Math.sin(θ13 - θ12), -1, 1));
  const cosXt = Math.cos(δxt);
  let δat = Math.acos(clamp(cosXt === 0 ? 1 : Math.cos(δ13) / cosXt, -1, 1));
  if (Math.cos(θ13 - θ12) < 0) δat = -δat;

  if (δat <= 0) return { distanceM: δ13 * EARTH_RADIUS_M, fraction: 0, closest: { ...a } };
  if (δat >= δ12) return { distanceM: distanceM(p, b), fraction: 1, closest: { ...b } };

  const fraction = δat / δ12;
  return {
    distanceM: Math.abs(δxt) * EARTH_RADIUS_M,
    fraction,
    closest: destination(a, toDeg(θ12), δat * EARTH_RADIUS_M),
  };
}

export const nmToM = (nm: number) => nm * METERS_PER_NM;
export const mToFt = (m: number) => m * FEET_PER_METER;

export function isValidCoordinate(p: Partial<LatLon>): p is LatLon {
  return (
    typeof p.latitude === 'number' &&
    typeof p.longitude === 'number' &&
    Number.isFinite(p.latitude) &&
    Number.isFinite(p.longitude) &&
    Math.abs(p.latitude) <= 90 &&
    Math.abs(p.longitude) <= 180
  );
}
