import type { ArtScope } from '@overhead/core';
import type { ScoredCandidate } from './select';

/**
 * One plane in a committed selection: everything the portrait renderer
 * needs to draw it, snapshotted when the selection is made so the render
 * matches what was chosen even if enrichment later changes the rows.
 * Never contains coordinates.
 */
export interface DisplayItem {
  display_order: number;
  overflight_id: string;
  registration: string | null;
  callsign: string | null;
  flight_number: string | null;
  origin_code: string | null;
  destination_code: string | null;
  origin_name: string | null;
  destination_name: string | null;
  icao_type_code: string | null;
  manufacturer: string | null;
  model: string | null;
  operator_name: string | null;
  operator_icao: string | null;
  closest_seen_at: string;
  closest_altitude_ft: number | null;
  minimum_distance_m: number;
  art_asset_id: string | null;
  art_scope: ArtScope | null;
  score: number;
}

export function toDisplayItems(selected: ScoredCandidate[]): DisplayItem[] {
  return selected.map(({ candidate: c, score }, i) => ({
    display_order: i,
    overflight_id: c.overflight_id,
    registration: c.registration,
    callsign: c.callsign,
    flight_number: c.flight_number,
    origin_code: c.origin_code,
    destination_code: c.destination_code,
    origin_name: c.origin_name,
    destination_name: c.destination_name,
    icao_type_code: c.icao_type_code,
    manufacturer: c.manufacturer,
    model: c.model,
    operator_name: c.operator_name,
    operator_icao: c.operator_icao,
    closest_seen_at: c.closest_seen_at,
    closest_altitude_ft: c.closest_altitude_ft,
    minimum_distance_m: Math.round(c.minimum_distance_m),
    art_asset_id: c.art_asset_id,
    art_scope: c.art_scope,
    score,
  }));
}
