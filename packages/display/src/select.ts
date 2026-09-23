import type { ArtScope, OverflightStatus } from '@overhead/core';
import type { DisplaySettings, DisplayWeights } from './settings';

/** One recorded pass that a frame could show, with what we know about it. */
export interface DisplayCandidate {
  overflight_id: string;
  icao24: string;
  registration: string | null;
  callsign: string | null;
  flight_number: string | null;
  origin_code: string | null;
  destination_code: string | null;
  /** Airport names from the route lookup, when known. */
  origin_name: string | null;
  destination_name: string | null;
  closest_seen_at: string;
  status: OverflightStatus;
  minimum_distance_m: number;
  closest_altitude_ft: number | null;
  icao_type_code: string | null;
  manufacturer: string | null;
  model: string | null;
  operator_name: string | null;
  operator_icao: string | null;
  /** From aircraft_types, e.g. 'landplane' or 'helicopter'. */
  aircraft_class: string | null;
  art_asset_id: string | null;
  art_scope: ArtScope | null;
  /** Passes of this airframe recorded at the location so far (including this one). */
  airframe_sightings: number;
  /** Passes of this aircraft type at the location so far; null when the type is unknown. */
  type_sightings: number | null;
}

/** The location's detection rules, used to scale proximity. */
export interface DisplayLocationRules {
  overhead_radius_m: number;
  max_altitude_ft: number;
}

export type ScoreComponents = { [K in keyof DisplayWeights]: number };

export const EXCLUSION_REASONS = [
  'near_miss',
  'helicopter',
  'not_airline',
  'same_airframe',
  'same_operator_type',
  'over_limit',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface ScoredCandidate {
  candidate: DisplayCandidate;
  /** Weighted score, 0–100. */
  score: number;
  /** Each component before weighting, 0–1. */
  components: ScoreComponents;
  /** Why it was not picked; null when selected. */
  excluded: ExclusionReason | null;
}

export interface DisplayPick {
  selected: ScoredCandidate[];
  /** Every candidate, best first, including the excluded ones. */
  ranked: ScoredCandidate[];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Artwork specificity: an exact-airframe painting beats a generic type. */
export const ART_SCOPE_SCORE: Record<ArtScope, number> = {
  registration: 1,
  operator_livery: 0.9,
  operator_type: 0.75,
  type: 0.4,
  fallback: 0.1,
};

/** Unknown types are common (military, private) and should not look rare. */
const UNKNOWN_TYPE_RARITY = 0.2;

export function scoreComponents(
  c: DisplayCandidate,
  settings: DisplaySettings,
  rules: DisplayLocationRules,
  now: Date,
): ScoreComponents {
  const typeRarity =
    c.type_sightings === null ? UNKNOWN_TYPE_RARITY : 1 / Math.sqrt(Math.max(1, c.type_sightings));
  const airframeRarity = 1 / Math.max(1, c.airframe_sightings);

  // Distance falls off over three overhead radii (the near-miss band).
  const near = 1 - clamp01(c.minimum_distance_m / (3 * rules.overhead_radius_m));
  const low =
    c.closest_altitude_ft === null ? 0 : 1 - clamp01(c.closest_altitude_ft / rules.max_altitude_ft);

  const ageH = (now.getTime() - Date.parse(c.closest_seen_at)) / 3_600_000;
  const known = [
    c.model ?? c.icao_type_code,
    c.operator_name ?? c.operator_icao,
    c.origin_code && c.destination_code,
    c.registration,
  ];

  return {
    rarity: 0.7 * typeRarity + 0.3 * airframeRarity,
    proximity: 0.5 * near + 0.5 * low,
    recency: 1 - clamp01(ageH / settings.window_hours),
    artwork: c.art_scope ? ART_SCOPE_SCORE[c.art_scope] : 0,
    detail: known.filter(Boolean).length / known.length,
  };
}

export function weightedScore(components: ScoreComponents, weights: DisplayWeights): number {
  const keys = Object.keys(weights) as Array<keyof DisplayWeights>;
  const total = keys.reduce((sum, k) => sum + weights[k], 0);
  if (total <= 0) return 0;
  const raw = keys.reduce((sum, k) => sum + weights[k] * components[k], 0);
  return Math.round((raw / total) * 1000) / 10;
}

function filterReason(c: DisplayCandidate, s: DisplaySettings): ExclusionReason | null {
  if (c.status === 'near_miss' && !s.include_near_misses) return 'near_miss';
  if (c.aircraft_class === 'helicopter' && !s.include_helicopters) return 'helicopter';
  if (s.airline_only && !c.operator_icao) return 'not_airline';
  return null;
}

/**
 * Choose what a frame shows: score every candidate, then take the best ones
 * greedily, skipping filtered passes, repeat passes of one airframe and (when
 * enabled) a second plane of the same operator and type. Pure and
 * deterministic: ties break on the newer pass, then the overflight id.
 */
export function selectForDisplay(
  candidates: DisplayCandidate[],
  settings: DisplaySettings,
  rules: DisplayLocationRules,
  now: Date,
): DisplayPick {
  const scored = candidates
    .map((candidate) => {
      const components = scoreComponents(candidate, settings, rules, now);
      return { candidate, components, score: weightedScore(components, settings.weights) };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.candidate.closest_seen_at.localeCompare(a.candidate.closest_seen_at) ||
        a.candidate.overflight_id.localeCompare(b.candidate.overflight_id),
    );

  const airframes = new Set<string>();
  const operatorTypes = new Set<string>();
  const ranked: ScoredCandidate[] = [];
  const selected: ScoredCandidate[] = [];

  for (const s of scored) {
    const c = s.candidate;
    const operatorType =
      c.operator_icao && c.icao_type_code ? `${c.operator_icao}/${c.icao_type_code}` : null;
    let excluded = filterReason(c, settings);
    if (!excluded && airframes.has(c.icao24)) excluded = 'same_airframe';
    if (
      !excluded &&
      settings.one_per_operator_type &&
      operatorType &&
      operatorTypes.has(operatorType)
    )
      excluded = 'same_operator_type';
    if (!excluded && selected.length >= settings.max_planes) excluded = 'over_limit';

    const entry = { ...s, excluded };
    ranked.push(entry);
    if (excluded) continue;
    selected.push(entry);
    airframes.add(c.icao24);
    if (operatorType) operatorTypes.add(operatorType);
  }
  return { selected, ranked };
}
