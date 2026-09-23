import type { Sql } from '@overhead/database';
import type {
  CurrentSelection,
  DisplayCandidate,
  DisplayItem,
  DisplaySettings,
} from '@overhead/display';
import {
  loadCurrentSelection,
  loadDisplayCandidates,
  loadDisplayDevices,
  saveDisplaySettings,
  settingsFromRow,
  type DisplayDevice,
} from '@overhead/display/sql';

/**
 * Cross-tenant reads and writes for the admin board. Unlike the rest of the
 * API these queries are deliberately not scoped to the caller: routes that
 * use them are mounted behind `requireAdmin`. Coordinates are never
 * selected, so even admins cannot see where anyone lives.
 */
export interface AdminUser {
  id: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  is_admin: boolean;
  device_count: number;
  location_count: number;
  overflight_count: number;
  last_overflight_at: string | null;
}

export interface AdminSelection {
  id: string;
  selected_at: string;
  reason: string;
  items: DisplayItem[];
  settings: Record<string, unknown>;
}

export interface AdminDevice {
  id: string;
  owner_id: string;
  owner_email: string | null;
  name: string;
  location_id: string | null;
  location_name: string | null;
  timezone: string | null;
  poll_interval_seconds: number;
  battery_mv: number | null;
  rssi: number | null;
  firmware_version: string | null;
  last_boot_reason: string | null;
  last_seen_at: string | null;
  created_at: string;
  enrollment_state: string | null;
  settings: DisplaySettings;
  has_custom_settings: boolean;
  current_selection: Omit<AdminSelection, 'id' | 'settings'> | null;
  selections_24h: number;
}

export interface AdminLocation {
  id: string;
  owner_id: string;
  name: string;
  timezone: string;
  search_radius_nm: number;
  overhead_radius_m: number;
  max_altitude_ft: number;
  is_active: boolean;
}

export interface PreviewInputs {
  device: DisplayDevice;
  candidates: DisplayCandidate[];
  current: CurrentSelection | null;
}

export interface AdminRepository {
  isAdmin(userId: string): Promise<boolean>;
  /** False when the user does not exist. */
  setAdmin(userId: string, admin: boolean): Promise<boolean>;
  listUsers(): Promise<AdminUser[]>;
  listDevices(filter?: { ownerId?: string; deviceId?: string }): Promise<AdminDevice[]>;
  getLocation(id: string): Promise<AdminLocation | null>;
  /** A user's locations, without coordinates. */
  listLocations(ownerId: string): Promise<AdminLocation[]>;
  updateDevice(
    id: string,
    patch: { name?: string; poll_interval_seconds?: number; location_id?: string | null },
  ): Promise<boolean>;
  updateLocation(
    id: string,
    patch: Partial<
      Pick<
        AdminLocation,
        'search_radius_nm' | 'overhead_radius_m' | 'max_altitude_ft' | 'is_active'
      >
    >,
  ): Promise<boolean>;
  saveSettings(deviceId: string, settings: DisplaySettings): Promise<boolean>;
  listSelections(deviceId: string, limit: number): Promise<AdminSelection[]>;
  /** Null when the device does not exist or has no location. */
  previewInputs(deviceId: string, now: Date, windowHours: number): Promise<PreviewInputs | null>;
}

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown) => (v === null || v === undefined ? null : String(v));

const toLocation = (r: Row): AdminLocation => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  name: String(r.name),
  timezone: String(r.timezone),
  search_radius_nm: Number(r.search_radius_nm),
  overhead_radius_m: Number(r.overhead_radius_m),
  max_altitude_ft: Number(r.max_altitude_ft),
  is_active: Boolean(r.is_active),
});

export class SqlAdminRepository implements AdminRepository {
  constructor(private readonly sql: Sql) {}

  async isAdmin(userId: string): Promise<boolean> {
    const rows = (await this.sql`
      select 1 from private.admins where user_id = ${userId}`) as Row[];
    return rows.length === 1;
  }

  async setAdmin(userId: string, admin: boolean): Promise<boolean> {
    const exists = (await this.sql`select 1 from auth.users where id = ${userId}`) as Row[];
    if (exists.length === 0) return false;
    if (admin) {
      await this
        .sql`insert into private.admins (user_id) values (${userId}) on conflict do nothing`;
    } else {
      await this.sql`delete from private.admins where user_id = ${userId}`;
    }
    return true;
  }

  async listUsers(): Promise<AdminUser[]> {
    const rows = (await this.sql`
      select u.id, u.email, u.created_at, u.last_sign_in_at, p.display_name,
             exists (select 1 from private.admins a where a.user_id = u.id) as is_admin,
             (select count(*)::int from public.devices d where d.owner_id = u.id) as device_count,
             (select count(*)::int from public.locations l where l.owner_id = u.id) as location_count,
             (select count(*)::int from public.overflights o where o.owner_id = u.id) as overflight_count,
             (select max(o.closest_seen_at) from public.overflights o where o.owner_id = u.id)
               as last_overflight_at
        from auth.users u
        left join public.profiles p on p.id = u.id
       order by u.created_at
       limit 500`) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      email: strOrNull(r.email),
      display_name: strOrNull(r.display_name),
      created_at: iso(r.created_at)!,
      last_sign_in_at: iso(r.last_sign_in_at),
      is_admin: Boolean(r.is_admin),
      device_count: Number(r.device_count),
      location_count: Number(r.location_count),
      overflight_count: Number(r.overflight_count),
      last_overflight_at: iso(r.last_overflight_at),
    }));
  }

  async listDevices(filter: { ownerId?: string; deviceId?: string } = {}): Promise<AdminDevice[]> {
    const ownerId = filter.ownerId ?? null;
    const deviceId = filter.deviceId ?? null;
    const rows = (await this.sql`
      select d.id, d.owner_id, u.email as owner_email, d.name, d.location_id,
             l.name as location_name, l.timezone, d.poll_interval_seconds, d.battery_mv, d.rssi,
             d.firmware_version, d.last_boot_reason, d.last_seen_at, d.created_at,
             c.enrollment_state,
             s.device_id is not null as has_custom_settings,
             s.max_planes, s.window_hours, s.min_dwell_minutes, s.include_near_misses,
             s.include_helicopters, s.airline_only, s.one_per_operator_type,
             s.weight_rarity, s.weight_proximity, s.weight_recency, s.weight_artwork,
             s.weight_detail, s.quiet_start_hour, s.quiet_end_hour,
             cur.selected_at as current_selected_at, cur.reason as current_reason,
             cur.items as current_items,
             (select count(*)::int from public.display_selections x
               where x.device_id = d.id and x.selected_at > now() - interval '24 hours')
               as selections_24h
        from public.devices d
        left join auth.users u on u.id = d.owner_id
        left join public.locations l on l.id = d.location_id and l.owner_id = d.owner_id
        left join private.device_credentials c on c.device_id = d.id
        left join public.device_display_settings s on s.device_id = d.id
        left join lateral (
          select x.selected_at, x.reason, x.items from public.display_selections x
           where x.device_id = d.id order by x.selected_at desc, x.id desc limit 1
        ) cur on true
       where (${ownerId}::uuid is null or d.owner_id = ${ownerId}::uuid)
         and (${deviceId}::uuid is null or d.id = ${deviceId}::uuid)
       order by d.created_at`) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      owner_id: String(r.owner_id),
      owner_email: strOrNull(r.owner_email),
      name: String(r.name),
      location_id: strOrNull(r.location_id),
      location_name: strOrNull(r.location_name),
      timezone: strOrNull(r.timezone),
      poll_interval_seconds: Number(r.poll_interval_seconds),
      battery_mv: numOrNull(r.battery_mv),
      rssi: numOrNull(r.rssi),
      firmware_version: strOrNull(r.firmware_version),
      last_boot_reason: strOrNull(r.last_boot_reason),
      last_seen_at: iso(r.last_seen_at),
      created_at: iso(r.created_at)!,
      enrollment_state: strOrNull(r.enrollment_state),
      settings: settingsFromRow(r),
      has_custom_settings: Boolean(r.has_custom_settings),
      current_selection: r.current_selected_at
        ? {
            selected_at: iso(r.current_selected_at)!,
            reason: String(r.current_reason),
            items: r.current_items as DisplayItem[],
          }
        : null,
      selections_24h: Number(r.selections_24h),
    }));
  }

  async getLocation(id: string): Promise<AdminLocation | null> {
    const rows = (await this.sql`
      select id, owner_id, name, timezone, search_radius_nm, overhead_radius_m, max_altitude_ft,
             is_active
        from public.locations where id = ${id}`) as Row[];
    return rows[0] ? toLocation(rows[0]) : null;
  }

  async listLocations(ownerId: string): Promise<AdminLocation[]> {
    const rows = (await this.sql`
      select id, owner_id, name, timezone, search_radius_nm, overhead_radius_m, max_altitude_ft,
             is_active
        from public.locations where owner_id = ${ownerId} order by created_at`) as Row[];
    return rows.map(toLocation);
  }

  async updateDevice(
    id: string,
    patch: { name?: string; poll_interval_seconds?: number; location_id?: string | null },
  ): Promise<boolean> {
    const rows = (await this.sql`
      update public.devices
         set name = coalesce(${patch.name ?? null}, name),
             poll_interval_seconds = coalesce(${patch.poll_interval_seconds ?? null}::int,
                                              poll_interval_seconds),
             location_id = case when ${'location_id' in patch} then ${patch.location_id ?? null}::uuid
                                else location_id end
       where id = ${id}
      returning id`) as Row[];
    return rows.length === 1;
  }

  async updateLocation(
    id: string,
    patch: Partial<
      Pick<
        AdminLocation,
        'search_radius_nm' | 'overhead_radius_m' | 'max_altitude_ft' | 'is_active'
      >
    >,
  ): Promise<boolean> {
    const rows = (await this.sql`
      update public.locations
         set search_radius_nm = coalesce(${patch.search_radius_nm ?? null}::float8, search_radius_nm),
             overhead_radius_m = coalesce(${patch.overhead_radius_m ?? null}::int, overhead_radius_m),
             max_altitude_ft = coalesce(${patch.max_altitude_ft ?? null}::int, max_altitude_ft),
             is_active = coalesce(${patch.is_active ?? null}::boolean, is_active)
       where id = ${id}
      returning id`) as Row[];
    return rows.length === 1;
  }

  saveSettings(deviceId: string, settings: DisplaySettings): Promise<boolean> {
    return saveDisplaySettings(this.sql, deviceId, settings);
  }

  async listSelections(deviceId: string, limit: number): Promise<AdminSelection[]> {
    const rows = (await this.sql`
      select id, selected_at, reason, items, settings
        from public.display_selections
       where device_id = ${deviceId}
       order by selected_at desc, id desc
       limit ${limit}`) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      selected_at: iso(r.selected_at)!,
      reason: String(r.reason),
      items: r.items as DisplayItem[],
      settings: r.settings as Record<string, unknown>,
    }));
  }

  async previewInputs(
    deviceId: string,
    now: Date,
    windowHours: number,
  ): Promise<PreviewInputs | null> {
    const [device] = await loadDisplayDevices(this.sql, { deviceId });
    if (!device) return null;
    const [candidates, current] = await Promise.all([
      loadDisplayCandidates(this.sql, device, now, windowHours),
      loadCurrentSelection(this.sql, device),
    ]);
    return { device, candidates, current };
  }
}
