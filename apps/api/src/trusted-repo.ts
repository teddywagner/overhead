import { BUCKETS } from '@overhead/core';
import type { Sql, TypedSupabaseClient } from '@overhead/database';

/**
 * Trusted (RLS-bypassing) operations. Every method takes the owner id and
 * scopes its SQL to it; callers must pass the authenticated user's id or a
 * device already authenticated by token hash. Nothing here is reachable
 * through the Data API.
 */
export interface DeviceAuthRecord {
  deviceId: string;
  ownerId: string;
  locationId: string | null;
  latestPosterId: string | null;
  pollIntervalSeconds: number;
  resetRequested: boolean;
  /** The location's time zone, for quiet hours; null without a location. */
  timeZone: string | null;
  quietStartHour: number | null;
  quietEndHour: number | null;
}

export interface SetupCandidate {
  deviceId: string;
  setupSecretHash: string;
}

export interface ServablePoster {
  posterId: string;
  devicePath: string;
  sha256: string;
}

export interface EnrollmentInfo {
  deviceId: string;
  enrollmentState: 'pending' | 'enrolled' | 'revoked';
  tokenCreatedAt: string | null;
  setupSecretCreatedAt: string;
}

export interface TrustedRepository {
  // --- device credentials -------------------------------------------------
  createDeviceCredential(
    ownerId: string,
    deviceId: string,
    setupSecretHash: string,
  ): Promise<boolean>;
  rotateSetupSecret(
    ownerId: string,
    deviceId: string,
    setupSecretHash: string,
    revokeToken: boolean,
  ): Promise<boolean>;
  getEnrollment(ownerId: string, deviceIds: string[]): Promise<EnrollmentInfo[]>;

  // --- device protocol ----------------------------------------------------
  findSetupCandidate(mac: string): Promise<SetupCandidate | null>;
  recordFailedSetup(deviceId: string): Promise<void>;
  completeSetup(
    deviceId: string,
    tokenHash: string,
    hardwareRevision: string | null,
  ): Promise<void>;
  authenticateDevice(tokenHash: string): Promise<DeviceAuthRecord | null>;
  recordTelemetry(
    deviceId: string,
    t: {
      batteryMv: number | null;
      rssi: number | null;
      firmwareVersion: string | null;
      bootReason: string | null;
    },
  ): Promise<void>;
  findServablePoster(device: DeviceAuthRecord): Promise<ServablePoster | null>;
  insertDeviceLogs(
    deviceId: string,
    firmwareVersion: string | null,
    logs: Array<{ level: string; message: string; ts: Date | null }>,
  ): Promise<void>;
  signDeviceBinaryUrl(path: string, ttlSeconds: number): Promise<string | null>;

  // --- posters ------------------------------------------------------------
  setPosterBinaryPath(ownerId: string, posterId: string, path: string): Promise<boolean>;
  markPosterBinaryVerified(
    ownerId: string,
    posterId: string,
    path: string,
    sha256: string,
  ): Promise<boolean>;
}

type Row = Record<string, unknown>;

export class SqlTrustedRepository implements TrustedRepository {
  constructor(
    private readonly sql: Sql,
    private readonly admin: TypedSupabaseClient,
  ) {}

  async createDeviceCredential(ownerId: string, deviceId: string, hash: string): Promise<boolean> {
    const rows = (await this.sql`
      insert into private.device_credentials (device_id, setup_secret_hash)
      select d.id, ${hash} from public.devices d where d.id = ${deviceId} and d.owner_id = ${ownerId}
      returning device_id`) as Row[];
    return rows.length === 1;
  }

  async rotateSetupSecret(
    ownerId: string,
    deviceId: string,
    hash: string,
    revokeToken: boolean,
  ): Promise<boolean> {
    const rows = (await this.sql`
      update private.device_credentials c
         set setup_secret_hash = ${hash},
             setup_secret_created_at = now(),
             failed_setup_attempts = 0,
             token_hash = case when ${revokeToken} then null else c.token_hash end,
             token_rotated_at = case when ${revokeToken} and c.token_hash is not null then now() else c.token_rotated_at end,
             enrollment_state = case when ${revokeToken} then 'pending' else c.enrollment_state end
        from public.devices d
       where c.device_id = d.id and d.id = ${deviceId} and d.owner_id = ${ownerId}
      returning c.device_id`) as Row[];
    return rows.length === 1;
  }

  async getEnrollment(ownerId: string, deviceIds: string[]): Promise<EnrollmentInfo[]> {
    if (deviceIds.length === 0) return [];
    const rows = (await this.sql`
      select c.device_id, c.enrollment_state, c.token_created_at, c.setup_secret_created_at
        from private.device_credentials c
        join public.devices d on d.id = c.device_id
       where d.owner_id = ${ownerId} and c.device_id in ${this.sql(deviceIds)}`) as Row[];
    return rows.map((r) => ({
      deviceId: String(r.device_id),
      enrollmentState: r.enrollment_state as EnrollmentInfo['enrollmentState'],
      tokenCreatedAt: r.token_created_at
        ? new Date(r.token_created_at as string).toISOString()
        : null,
      setupSecretCreatedAt: new Date(r.setup_secret_created_at as string).toISOString(),
    }));
  }

  async findSetupCandidate(mac: string): Promise<SetupCandidate | null> {
    const rows = (await this.sql`
      select d.id, c.setup_secret_hash
        from public.devices d
        join private.device_credentials c on c.device_id = d.id
       where d.mac_address = ${mac} and c.enrollment_state <> 'revoked'`) as Row[];
    const r = rows[0];
    return r ? { deviceId: String(r.id), setupSecretHash: String(r.setup_secret_hash) } : null;
  }

  async recordFailedSetup(deviceId: string): Promise<void> {
    await this.sql`
      update private.device_credentials
         set failed_setup_attempts = failed_setup_attempts + 1, last_setup_attempt_at = now()
       where device_id = ${deviceId}`;
  }

  async completeSetup(
    deviceId: string,
    tokenHash: string,
    hardwareRevision: string | null,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      // Rotation is atomic: the previous token stops working immediately.
      await tx`
        update private.device_credentials
           set token_rotated_at = case when token_hash is not null then now() else token_rotated_at end,
               token_hash = ${tokenHash},
               token_created_at = now(),
               enrollment_state = 'enrolled',
               failed_setup_attempts = 0,
               last_setup_attempt_at = now()
         where device_id = ${deviceId}`;
      await tx`
        update public.devices
           set hardware_revision = coalesce(${hardwareRevision}, hardware_revision),
               reset_requested = false,
               last_seen_at = now()
         where id = ${deviceId}`;
    });
  }

  async authenticateDevice(tokenHash: string): Promise<DeviceAuthRecord | null> {
    const rows = (await this.sql`
      select d.id, d.owner_id, d.location_id, d.latest_poster_id, d.poll_interval_seconds, d.reset_requested,
             l.timezone, s.quiet_start_hour, s.quiet_end_hour
        from private.device_credentials c
        join public.devices d on d.id = c.device_id
        left join public.locations l on l.id = d.location_id and l.owner_id = d.owner_id
        left join public.device_display_settings s on s.device_id = d.id
       where c.token_hash = ${tokenHash} and c.enrollment_state = 'enrolled'`) as Row[];
    const r = rows[0];
    if (!r) return null;
    return {
      deviceId: String(r.id),
      ownerId: String(r.owner_id),
      locationId: (r.location_id as string | null) ?? null,
      latestPosterId: (r.latest_poster_id as string | null) ?? null,
      pollIntervalSeconds: Number(r.poll_interval_seconds),
      resetRequested: Boolean(r.reset_requested),
      timeZone: (r.timezone as string | null) ?? null,
      quietStartHour: r.quiet_start_hour === null ? null : Number(r.quiet_start_hour),
      quietEndHour: r.quiet_end_hour === null ? null : Number(r.quiet_end_hour),
    };
  }

  async recordTelemetry(
    deviceId: string,
    t: {
      batteryMv: number | null;
      rssi: number | null;
      firmwareVersion: string | null;
      bootReason: string | null;
    },
  ): Promise<void> {
    await this.sql`
      update public.devices
         set battery_mv = coalesce(${t.batteryMv}, battery_mv),
             rssi = coalesce(${t.rssi}, rssi),
             firmware_version = coalesce(${t.firmwareVersion}, firmware_version),
             last_boot_reason = coalesce(${t.bootReason}, last_boot_reason),
             last_seen_at = now()
       where id = ${deviceId}`;
  }

  async findServablePoster(device: DeviceAuthRecord): Promise<ServablePoster | null> {
    // Prefer the explicitly assigned poster, else the newest ready poster for
    // the frame's location. Always constrained to the device owner.
    const rows = (await this.sql`
      select p.id, p.device_binary_path, p.binary_sha256
        from public.posters p
       where p.owner_id = ${device.ownerId}
         and p.status = 'ready'
         and p.device_binary_path is not null
         and p.binary_sha256 is not null
         and (p.id = ${device.latestPosterId}
              or (${device.latestPosterId}::uuid is null and p.location_id = ${device.locationId}))
       order by (p.id = ${device.latestPosterId}) desc nulls last, p.local_date desc, p.updated_at desc
       limit 1`) as Row[];
    const r = rows[0];
    return r
      ? {
          posterId: String(r.id),
          devicePath: String(r.device_binary_path),
          sha256: String(r.binary_sha256),
        }
      : null;
  }

  async insertDeviceLogs(
    deviceId: string,
    firmwareVersion: string | null,
    logs: Array<{ level: string; message: string; ts: Date | null }>,
  ): Promise<void> {
    if (logs.length === 0) return;
    const rows = logs.map((l) => ({
      device_id: deviceId,
      level: l.level,
      message: l.message,
      // ISO strings: Bun SQL would otherwise send Date in a locale format.
      device_ts: l.ts ? l.ts.toISOString() : null,
      firmware_version: firmwareVersion,
    }));
    await this.sql`insert into private.device_logs ${this.sql(rows)}`;
  }

  async signDeviceBinaryUrl(path: string, ttlSeconds: number): Promise<string | null> {
    const { data, error } = await this.admin.storage
      .from(BUCKETS.deviceBinaries)
      .createSignedUrl(path, ttlSeconds, { download: false });
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  }

  async setPosterBinaryPath(ownerId: string, posterId: string, path: string): Promise<boolean> {
    const rows = (await this.sql`
      update public.posters
         set device_binary_path = ${path},
             binary_sha256 = null,
             status = case when status = 'ready' then 'draft' else status end
       where id = ${posterId} and owner_id = ${ownerId}
      returning id`) as Row[];
    return rows.length === 1;
  }

  async markPosterBinaryVerified(
    ownerId: string,
    posterId: string,
    path: string,
    sha256: string,
  ): Promise<boolean> {
    const rows = (await this.sql`
      update public.posters
         set binary_sha256 = ${sha256},
             status = 'ready',
             error = null,
             generated_at = coalesce(generated_at, now())
       where id = ${posterId} and owner_id = ${ownerId} and device_binary_path = ${path}
      returning id`) as Row[];
    return rows.length === 1;
  }
}
