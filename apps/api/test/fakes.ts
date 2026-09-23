import { createLogger, type Logger } from '@overhead/core';
import type { TypedSupabaseClient } from '@overhead/database';
import type {
  AdminArtAsset,
  AdminAssetsRepository,
  AdminPoster,
  AdminSourceImage,
  ArtFields,
  ArtFilter,
  CoverageRow,
  SignedUpload,
} from '../src/admin-assets-repo';
import type {
  AdminDevice,
  AdminLocation,
  AdminRepository,
  AdminSelection,
  AdminUser,
  PreviewInputs,
} from '../src/admin-repo';
import type { AppDeps } from '../src/deps';
import { MemoryRateLimiter } from '../src/lib/rate-limit';
import type {
  DeviceAuthRecord,
  EnrollmentInfo,
  ServablePoster,
  SetupCandidate,
  TrustedRepository,
} from '../src/trusted-repo';

interface FakeDevice {
  id: string;
  ownerId: string;
  mac: string;
  locationId: string | null;
  latestPosterId: string | null;
  pollIntervalSeconds: number;
  resetRequested: boolean;
  timeZone: string | null;
  quietStartHour: number | null;
  quietEndHour: number | null;
  setupSecretHash: string;
  tokenHash: string | null;
  enrollmentState: 'pending' | 'enrolled' | 'revoked';
  failedSetups: number;
  telemetry: Record<string, unknown>;
  hardwareRevision: string | null;
}

export class FakeTrustedRepository implements TrustedRepository {
  devices = new Map<string, FakeDevice>();
  posters: Array<ServablePoster & { ownerId: string; locationId: string }> = [];
  logs: Array<{ deviceId: string; level: string; message: string; ts: Date | null }> = [];
  signedTtl: number | null = null;
  signedUrlOverride: string | null = null;

  addDevice(
    d: Partial<FakeDevice> & { id: string; mac: string; setupSecretHash: string },
  ): FakeDevice {
    const device: FakeDevice = {
      ownerId: '11111111-1111-4111-8111-111111111111',
      locationId: '22222222-2222-4222-8222-222222222222',
      latestPosterId: null,
      pollIntervalSeconds: 3600,
      resetRequested: false,
      timeZone: 'America/New_York',
      quietStartHour: null,
      quietEndHour: null,
      tokenHash: null,
      enrollmentState: 'pending',
      failedSetups: 0,
      telemetry: {},
      hardwareRevision: null,
      ...d,
    };
    this.devices.set(device.id, device);
    return device;
  }

  async createDeviceCredential(): Promise<boolean> {
    return true;
  }
  async rotateSetupSecret(): Promise<boolean> {
    return true;
  }
  async getEnrollment(): Promise<EnrollmentInfo[]> {
    return [];
  }
  async findSetupCandidate(mac: string): Promise<SetupCandidate | null> {
    const d = [...this.devices.values()].find(
      (x) => x.mac === mac && x.enrollmentState !== 'revoked',
    );
    return d ? { deviceId: d.id, setupSecretHash: d.setupSecretHash } : null;
  }
  async recordFailedSetup(deviceId: string): Promise<void> {
    this.devices.get(deviceId)!.failedSetups++;
  }
  async completeSetup(deviceId: string, tokenHash: string, hw: string | null): Promise<void> {
    const d = this.devices.get(deviceId)!;
    d.tokenHash = tokenHash;
    d.enrollmentState = 'enrolled';
    d.resetRequested = false;
    d.hardwareRevision = hw ?? d.hardwareRevision;
  }
  async authenticateDevice(tokenHash: string): Promise<DeviceAuthRecord | null> {
    const d = [...this.devices.values()].find(
      (x) => x.tokenHash === tokenHash && x.enrollmentState === 'enrolled',
    );
    return d
      ? {
          deviceId: d.id,
          ownerId: d.ownerId,
          locationId: d.locationId,
          latestPosterId: d.latestPosterId,
          pollIntervalSeconds: d.pollIntervalSeconds,
          resetRequested: d.resetRequested,
          timeZone: d.timeZone,
          quietStartHour: d.quietStartHour,
          quietEndHour: d.quietEndHour,
        }
      : null;
  }
  async recordTelemetry(deviceId: string, t: Record<string, unknown>): Promise<void> {
    this.devices.get(deviceId)!.telemetry = t;
  }
  async findServablePoster(device: DeviceAuthRecord): Promise<ServablePoster | null> {
    const own = this.posters.filter((p) => p.ownerId === device.ownerId);
    const hit = device.latestPosterId
      ? own.find((p) => p.posterId === device.latestPosterId)
      : own.find((p) => p.locationId === device.locationId);
    return hit ? { posterId: hit.posterId, devicePath: hit.devicePath, sha256: hit.sha256 } : null;
  }
  async insertDeviceLogs(
    deviceId: string,
    _fw: string | null,
    logs: Array<{ level: string; message: string; ts: Date | null }>,
  ) {
    for (const l of logs) this.logs.push({ deviceId, ...l });
  }
  async signDeviceBinaryUrl(path: string, ttl: number): Promise<string | null> {
    this.signedTtl = ttl;
    return (
      this.signedUrlOverride ??
      `http://127.0.0.1:54321/storage/v1/object/sign/device-binaries/${path}?token=fake`
    );
  }
  async setPosterBinaryPath(): Promise<boolean> {
    return true;
  }
  async markPosterBinaryVerified(): Promise<boolean> {
    return true;
  }
}

export class FakeAdminRepository implements AdminRepository {
  admins = new Set<string>();
  users: AdminUser[] = [];
  devices: AdminDevice[] = [];
  locations: AdminLocation[] = [];
  selections: AdminSelection[] = [];
  preview: PreviewInputs | null = null;

  async isAdmin(userId: string) {
    return this.admins.has(userId);
  }
  async setAdmin(userId: string, admin: boolean) {
    if (!this.users.some((u) => u.id === userId)) return false;
    if (admin) this.admins.add(userId);
    else this.admins.delete(userId);
    return true;
  }
  async listUsers() {
    return this.users;
  }
  async listDevices(filter: { ownerId?: string; deviceId?: string } = {}) {
    return this.devices.filter(
      (d) =>
        (!filter.ownerId || d.owner_id === filter.ownerId) &&
        (!filter.deviceId || d.id === filter.deviceId),
    );
  }
  async getLocation(id: string) {
    return this.locations.find((l) => l.id === id) ?? null;
  }
  async listLocations(ownerId: string) {
    return this.locations.filter((l) => l.owner_id === ownerId);
  }
  async updateDevice(
    id: string,
    patch: { name?: string; poll_interval_seconds?: number; location_id?: string | null },
  ) {
    const d = this.devices.find((x) => x.id === id);
    if (d) Object.assign(d, patch);
    return Boolean(d);
  }
  async updateLocation(id: string, patch: Partial<AdminLocation>) {
    const l = this.locations.find((x) => x.id === id);
    if (l) Object.assign(l, patch);
    return Boolean(l);
  }
  async saveSettings(deviceId: string, settings: AdminDevice['settings']) {
    const d = this.devices.find((x) => x.id === deviceId);
    if (d) Object.assign(d, { settings, has_custom_settings: true });
    return Boolean(d);
  }
  async listSelections(_deviceId: string, limit: number) {
    return this.selections.slice(0, limit);
  }
  async previewInputs() {
    return this.preview;
  }
}

export class FakeAdminAssetsRepository implements AdminAssetsRepository {
  art: AdminArtAsset[] = [];
  owners = new Set<string>();
  objects = new Set<string>();
  sourceImages: AdminSourceImage[] = [];
  posters: AdminPoster[] = [];
  coverageRows: CoverageRow[] = [];

  async listArt(f: ArtFilter) {
    return this.art
      .filter(
        (a) =>
          (!f.id || a.id === f.id) &&
          (!f.ownerId || a.owner_id === f.ownerId) &&
          (!f.status || a.status === f.status) &&
          (!f.scope || a.scope === f.scope),
      )
      .slice(0, f.limit);
  }
  async artStatusCounts() {
    const counts: Record<string, number> = {};
    for (const a of this.art) counts[a.status] = (counts[a.status] ?? 0) + 1;
    return counts;
  }
  async getArt(id: string) {
    return this.art.find((a) => a.id === id) ?? null;
  }
  async createArt(
    ownerId: string,
    f: ArtFields & { storage_path: string; status: 'draft' | 'pending_review' },
  ) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.art.push({
      id,
      owner_id: ownerId,
      owner_email: null,
      aircraft_id: null,
      aircraft_registration: null,
      source_image_id: null,
      thumbnail_path: null,
      generation_provider: null,
      generation_model: null,
      prompt_version: null,
      identity_confidence: null,
      approved_at: null,
      created_at: now,
      updated_at: now,
      sightings_30d: 0,
      image_url: null,
      thumbnail_url: null,
      ...f,
    });
    return id;
  }
  async updateArt(id: string, patch: Partial<ArtFields>) {
    const a = this.art.find((x) => x.id === id);
    if (a) Object.assign(a, patch);
    return Boolean(a);
  }
  async setArtStatus(
    id: string,
    status: AdminArtAsset['status'],
    notes: string | null | undefined,
    now: Date,
  ) {
    const a = this.art.find((x) => x.id === id);
    if (!a) return false;
    a.status = status;
    a.approved_at = status === 'approved' ? now.toISOString() : null;
    if (notes !== undefined) a.reviewer_notes = notes;
    return true;
  }
  async artObjectExists(path: string) {
    return this.objects.has(path);
  }
  async createArtUpload(path: string): Promise<SignedUpload> {
    return {
      bucket: 'aircraft-art',
      path,
      signed_url: `https://storage.test/${path}`,
      token: 't',
      expires_in_seconds: 7200,
    };
  }
  async artUrls(ids: string[]) {
    return Object.fromEntries(
      ids.map((id) => [id, { image_url: `https://storage.test/${id}`, thumbnail_url: null }]),
    );
  }
  async listSourceImages() {
    return this.sourceImages;
  }
  async listPosters() {
    return this.posters;
  }
  async coverage() {
    return this.coverageRows;
  }
  async ownerExists(ownerId: string) {
    return this.owners.has(ownerId);
  }
}

export const VALID_TOKEN = 'valid-access-token-for-tests-0123456789';
export const USER_ID = '11111111-1111-4111-8111-111111111111';

export function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps & {
  logLines: string[];
  trusted: FakeTrustedRepository;
  admin: FakeAdminRepository;
  adminAssets: FakeAdminAssetsRepository;
} {
  const logLines: string[] = [];
  const logger: Logger = createLogger({ level: 'debug', sink: (l) => logLines.push(l) });
  const trusted = new FakeTrustedRepository();
  const admin = new FakeAdminRepository();
  const adminAssets = new FakeAdminAssetsRepository();
  return {
    env: {
      APP_NAME: 'Overhead',
      NODE_ENV: 'test',
      CORS_ALLOWED_ORIGINS: ['https://app.example.test'],
      TRUST_PROXY: false,
      API_BODY_LIMIT_BYTES: 64 * 1024,
      DEVICE_SIGNED_URL_TTL_SECONDS: 300,
      DEFAULT_SEARCH_RADIUS_NM: 5,
      DEFAULT_OVERHEAD_RADIUS_M: 1200,
      DEFAULT_MAX_ALTITUDE_FT: 15000,
      DEFAULT_TIMEZONE: 'America/New_York',
    },
    logger,
    verifyAccessToken: async (token) => (token === VALID_TOKEN ? { userId: USER_ID } : null),
    // Any database use in these tests is a bug: validation must fail first.
    userClient: () =>
      new Proxy({} as TypedSupabaseClient, {
        get() {
          throw new Error('database should not be reached in this test');
        },
      }),
    checkDatabase: async () => true,
    rateLimiter: new MemoryRateLimiter(),
    ...overrides,
    trusted,
    admin,
    adminAssets,
    logLines,
  } as AppDeps & {
    logLines: string[];
    trusted: FakeTrustedRepository;
    admin: FakeAdminRepository;
    adminAssets: FakeAdminAssetsRepository;
  };
}

export type { TypedSupabaseClient };
