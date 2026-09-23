import { z } from 'zod';

/** Enumerations mirrored exactly by Postgres check constraints/enums. */
export const OVERFLIGHT_STATUSES = ['qualified', 'near_miss'] as const;
export type OverflightStatus = (typeof OVERFLIGHT_STATUSES)[number];

export const QUALIFICATION_REASONS = [
  'crossed_within_overhead_radius',
  'outside_overhead_radius',
  'above_max_altitude',
  'unknown_altitude',
] as const;
export type QualificationReason = (typeof QUALIFICATION_REASONS)[number];

export const ART_SCOPES = [
  'registration',
  'operator_livery',
  'operator_type',
  'type',
  'fallback',
] as const;
export type ArtScope = (typeof ART_SCOPES)[number];

export const ART_STATUSES = [
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'archived',
] as const;
export type ArtStatus = (typeof ART_STATUSES)[number];

export const POSTER_STATUSES = ['draft', 'rendering', 'ready', 'failed', 'archived'] as const;
export type PosterStatus = (typeof POSTER_STATUSES)[number];

export const PROVIDERS = ['adsb_lol', 'airplanes_live', 'mock'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const icao24Schema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^~?[0-9a-f]{6}$/, 'must be a 24-bit ICAO address in hex');

export const registrationSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{1,12}$/, 'invalid registration');

export const typeCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,4}$/, 'invalid ICAO type designator');

export const operatorIcaoSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'invalid ICAO operator code');

export interface ArtCandidate {
  id: string;
  scope: ArtScope;
  status: ArtStatus;
  registration: string | null;
  operator_icao: string | null;
  icao_type_code: string | null;
  livery_name: string | null;
  approved_at: string | null;
}

export interface ArtTarget {
  registration: string | null;
  operator_icao: string | null;
  icao_type_code: string | null;
  livery_name?: string | null;
}

/**
 * Artwork matching precedence (future renderer phase):
 *   1. exact registration
 *   2. operator + aircraft type + livery
 *   3. operator + aircraft type
 *   4. generic aircraft type
 *   5. generic fallback
 * Only approved assets participate. Ties break on most recent approval.
 */
export function matchArtAsset<T extends ArtCandidate>(target: ArtTarget, assets: T[]): T | null {
  const eq = (a: string | null | undefined, b: string | null | undefined) =>
    !!a && !!b && a.toUpperCase() === b.toUpperCase();
  const tiers: Array<(a: T) => boolean> = [
    (a) => a.scope === 'registration' && eq(a.registration, target.registration),
    (a) =>
      a.scope === 'operator_livery' &&
      eq(a.operator_icao, target.operator_icao) &&
      eq(a.icao_type_code, target.icao_type_code) &&
      eq(a.livery_name, target.livery_name),
    (a) =>
      a.scope === 'operator_type' &&
      eq(a.operator_icao, target.operator_icao) &&
      eq(a.icao_type_code, target.icao_type_code),
    (a) => a.scope === 'type' && eq(a.icao_type_code, target.icao_type_code),
    (a) => a.scope === 'fallback',
  ];
  const approved = assets
    .filter((a) => a.status === 'approved')
    .sort((x, y) => (y.approved_at ?? '').localeCompare(x.approved_at ?? ''));
  for (const tier of tiers) {
    const hit = approved.find(tier);
    if (hit) return hit;
  }
  return null;
}
