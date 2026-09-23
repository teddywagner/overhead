import {
  matchArtAsset,
  type ArtCandidate,
  type ArtScope,
  type OverflightStatus,
} from '@overhead/core';
import type { Sql } from '@overhead/database';
import type { CommitReason, CurrentSelection } from './commit';
import type { DisplayItem } from './items';
import type { DisplayCandidate, DisplayLocationRules } from './select';
import { DEFAULT_DISPLAY_SETTINGS, type DisplaySettings } from './settings';

/**
 * Trusted (RLS-bypassing) reads and writes for display selection, shared by
 * the worker and the admin API so both see exactly the same inputs. Every
 * query is scoped to one device and its owner. Coordinates are never read.
 */

type Row = Record<string, unknown>;

const iso = (v: unknown) => new Date(v as string).toISOString();
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown) => (v === null || v === undefined ? null : String(v));

export interface DisplayDevice {
  deviceId: string;
  ownerId: string;
  locationId: string;
  timeZone: string;
  pollIntervalSeconds: number;
  rules: DisplayLocationRules;
  settings: DisplaySettings;
}

/** A settings row, or defaults when the device has none yet (all columns null). */
export function settingsFromRow(r: Row): DisplaySettings {
  if (r.max_planes === null || r.max_planes === undefined) return DEFAULT_DISPLAY_SETTINGS;
  return {
    max_planes: Number(r.max_planes),
    window_hours: Number(r.window_hours),
    min_dwell_minutes: Number(r.min_dwell_minutes),
    include_near_misses: Boolean(r.include_near_misses),
    include_helicopters: Boolean(r.include_helicopters),
    airline_only: Boolean(r.airline_only),
    one_per_operator_type: Boolean(r.one_per_operator_type),
    weights: {
      rarity: Number(r.weight_rarity),
      proximity: Number(r.weight_proximity),
      recency: Number(r.weight_recency),
      artwork: Number(r.weight_artwork),
      detail: Number(r.weight_detail),
    },
    quiet_start_hour: numOrNull(r.quiet_start_hour),
    quiet_end_hour: numOrNull(r.quiet_end_hour),
  };
}

export function settingsToRow(s: DisplaySettings) {
  return {
    max_planes: s.max_planes,
    window_hours: s.window_hours,
    min_dwell_minutes: s.min_dwell_minutes,
    include_near_misses: s.include_near_misses,
    include_helicopters: s.include_helicopters,
    airline_only: s.airline_only,
    one_per_operator_type: s.one_per_operator_type,
    weight_rarity: s.weights.rarity,
    weight_proximity: s.weights.proximity,
    weight_recency: s.weights.recency,
    weight_artwork: s.weights.artwork,
    weight_detail: s.weights.detail,
    quiet_start_hour: s.quiet_start_hour,
    quiet_end_hour: s.quiet_end_hour,
  };
}

function toDevice(r: Row): DisplayDevice {
  return {
    deviceId: String(r.device_id),
    ownerId: String(r.owner_id),
    locationId: String(r.location_id),
    timeZone: String(r.timezone),
    pollIntervalSeconds: Number(r.poll_interval_seconds),
    rules: {
      overhead_radius_m: Number(r.overhead_radius_m),
      max_altitude_ft: Number(r.max_altitude_ft),
    },
    settings: settingsFromRow(r),
  };
}

/** Frames with a location, i.e. frames that have something to show. */
export async function loadDisplayDevices(
  sql: Sql,
  filter: { deviceId?: string; activeLocationsOnly?: boolean } = {},
): Promise<DisplayDevice[]> {
  const deviceId = filter.deviceId ?? null;
  const activeOnly = filter.activeLocationsOnly ?? false;
  const rows = (await sql`
    select d.id as device_id, d.owner_id, d.location_id, d.poll_interval_seconds,
           l.timezone, l.overhead_radius_m, l.max_altitude_ft,
           s.max_planes, s.window_hours, s.min_dwell_minutes, s.include_near_misses,
           s.include_helicopters, s.airline_only, s.one_per_operator_type,
           s.weight_rarity, s.weight_proximity, s.weight_recency, s.weight_artwork, s.weight_detail,
           s.quiet_start_hour, s.quiet_end_hour
      from public.devices d
      join public.locations l on l.id = d.location_id and l.owner_id = d.owner_id
      left join public.device_display_settings s on s.device_id = d.id
     where (${deviceId}::uuid is null or d.id = ${deviceId}::uuid)
       and (not ${activeOnly} or l.is_active)
     order by d.created_at`) as Row[];
  return rows.map(toDevice);
}

/** Recorded passes at the device's location in the window ending at `now`. */
export async function loadDisplayCandidates(
  sql: Sql,
  device: Pick<DisplayDevice, 'ownerId' | 'locationId'>,
  now: Date,
  windowHours: number,
): Promise<DisplayCandidate[]> {
  const until = now.toISOString();
  const since = new Date(now.getTime() - windowHours * 3_600_000).toISOString();
  const rows = (await sql`
    select o.id, o.icao24, coalesce(o.registration, a.registration) as registration, o.callsign,
           o.flight_number, o.origin_code, o.destination_code, o.closest_seen_at, o.status,
           o.raw_summary->'route'->>'originName' as origin_name,
           o.raw_summary->'route'->>'destinationName' as destination_name,
           o.minimum_distance_m, o.closest_altitude_ft,
           a.icao_type_code, a.manufacturer, a.model, a.operator_name, a.operator_icao,
           t.aircraft_class,
           (select count(*)::int from public.overflights x
             where x.owner_id = o.owner_id and x.location_id = o.location_id
               and x.icao24 = o.icao24 and x.closest_seen_at <= ${until}::timestamptz
           ) as airframe_sightings,
           case when a.icao_type_code is null then null else
             (select count(*)::int from public.overflights x
                join public.aircraft xa on xa.id = x.aircraft_id
               where x.owner_id = o.owner_id and x.location_id = o.location_id
                 and xa.icao_type_code = a.icao_type_code
                 and x.closest_seen_at <= ${until}::timestamptz)
           end as type_sightings
      from public.overflights o
      left join public.aircraft a on a.id = o.aircraft_id
      left join public.aircraft_types t on t.icao_type_code = a.icao_type_code
     where o.owner_id = ${device.ownerId} and o.location_id = ${device.locationId}
       and o.closest_seen_at > ${since}::timestamptz
       and o.closest_seen_at <= ${until}::timestamptz
     order by o.closest_seen_at desc
     limit 500`) as Row[];
  if (rows.length === 0) return [];

  const art = (await sql`
    select id, scope, status, registration, operator_icao, icao_type_code, livery_name, approved_at
      from public.art_assets
     where owner_id = ${device.ownerId} and status = 'approved'`) as Row[];
  const assets: ArtCandidate[] = art.map((a) => ({
    id: String(a.id),
    scope: a.scope as ArtScope,
    status: 'approved',
    registration: strOrNull(a.registration),
    operator_icao: strOrNull(a.operator_icao),
    icao_type_code: strOrNull(a.icao_type_code),
    livery_name: strOrNull(a.livery_name),
    approved_at: a.approved_at ? iso(a.approved_at) : null,
  }));

  return rows.map((r) => {
    const registration = strOrNull(r.registration);
    const operatorIcao = strOrNull(r.operator_icao);
    const typeCode = strOrNull(r.icao_type_code);
    const match = matchArtAsset(
      { registration, operator_icao: operatorIcao, icao_type_code: typeCode },
      assets,
    );
    return {
      overflight_id: String(r.id),
      icao24: String(r.icao24),
      registration,
      callsign: strOrNull(r.callsign),
      flight_number: strOrNull(r.flight_number),
      origin_code: strOrNull(r.origin_code),
      destination_code: strOrNull(r.destination_code),
      origin_name: strOrNull(r.origin_name),
      destination_name: strOrNull(r.destination_name),
      closest_seen_at: iso(r.closest_seen_at),
      status: r.status as OverflightStatus,
      minimum_distance_m: Number(r.minimum_distance_m),
      closest_altitude_ft: numOrNull(r.closest_altitude_ft),
      icao_type_code: typeCode,
      manufacturer: strOrNull(r.manufacturer),
      model: strOrNull(r.model),
      operator_name: strOrNull(r.operator_name),
      operator_icao: operatorIcao,
      aircraft_class: strOrNull(r.aircraft_class),
      art_asset_id: match?.id ?? null,
      art_scope: match?.scope ?? null,
      airframe_sightings: Number(r.airframe_sightings),
      type_sightings: numOrNull(r.type_sightings),
    };
  });
}

export async function loadCurrentSelection(
  sql: Sql,
  device: Pick<DisplayDevice, 'ownerId' | 'deviceId'>,
): Promise<CurrentSelection | null> {
  const rows = (await sql`
    select to_jsonb(overflight_ids) as overflight_ids, selected_at
      from public.display_selections
     where owner_id = ${device.ownerId} and device_id = ${device.deviceId}
     order by selected_at desc, id desc
     limit 1`) as Row[];
  const r = rows[0];
  if (!r) return null;
  return {
    overflight_ids: (r.overflight_ids as string[]).map(String),
    selected_at: iso(r.selected_at),
  };
}

export async function insertDisplaySelection(
  sql: Sql,
  device: Pick<DisplayDevice, 'ownerId' | 'deviceId'>,
  selection: {
    reason: CommitReason;
    selectedAt: Date;
    items: DisplayItem[];
    settings: DisplaySettings;
  },
): Promise<void> {
  const ids = selection.items.map((i) => i.overflight_id);
  await sql`
    insert into public.display_selections
      (owner_id, device_id, selected_at, reason, overflight_ids, items, settings)
    values (${device.ownerId}, ${device.deviceId}, ${selection.selectedAt.toISOString()}::timestamptz,
            ${selection.reason}, ${`{${ids.join(',')}}`}::uuid[],
            ${JSON.stringify(selection.items)}::jsonb, ${JSON.stringify(selection.settings)}::jsonb)`;
}

/** Create or replace a device's settings (owner taken from the device row). */
export async function saveDisplaySettings(
  sql: Sql,
  deviceId: string,
  settings: DisplaySettings,
): Promise<boolean> {
  const r = settingsToRow(settings);
  const rows = (await sql`
    insert into public.device_display_settings
      (device_id, owner_id, max_planes, window_hours, min_dwell_minutes, include_near_misses,
       include_helicopters, airline_only, one_per_operator_type, weight_rarity, weight_proximity,
       weight_recency, weight_artwork, weight_detail, quiet_start_hour, quiet_end_hour)
    select d.id, d.owner_id, ${r.max_planes}, ${r.window_hours}, ${r.min_dwell_minutes},
           ${r.include_near_misses}, ${r.include_helicopters}, ${r.airline_only},
           ${r.one_per_operator_type}, ${r.weight_rarity}, ${r.weight_proximity},
           ${r.weight_recency}, ${r.weight_artwork}, ${r.weight_detail},
           ${r.quiet_start_hour}, ${r.quiet_end_hour}
      from public.devices d where d.id = ${deviceId}
    on conflict (device_id) do update set
      max_planes = excluded.max_planes,
      window_hours = excluded.window_hours,
      min_dwell_minutes = excluded.min_dwell_minutes,
      include_near_misses = excluded.include_near_misses,
      include_helicopters = excluded.include_helicopters,
      airline_only = excluded.airline_only,
      one_per_operator_type = excluded.one_per_operator_type,
      weight_rarity = excluded.weight_rarity,
      weight_proximity = excluded.weight_proximity,
      weight_recency = excluded.weight_recency,
      weight_artwork = excluded.weight_artwork,
      weight_detail = excluded.weight_detail,
      quiet_start_hour = excluded.quiet_start_hour,
      quiet_end_hour = excluded.quiet_end_hour
    returning device_id`) as Row[];
  return rows.length === 1;
}
