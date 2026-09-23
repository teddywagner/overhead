import { createLogger, type Logger } from '@overhead/core';
import type { TypedSupabaseClient } from '@overhead/database';
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

export const VALID_TOKEN = 'valid-access-token-for-tests-0123456789';
export const USER_ID = '11111111-1111-4111-8111-111111111111';

export function makeDeps(
  overrides: Partial<AppDeps> = {},
): AppDeps & { logLines: string[]; trusted: FakeTrustedRepository } {
  const logLines: string[] = [];
  const logger: Logger = createLogger({ level: 'debug', sink: (l) => logLines.push(l) });
  const trusted = new FakeTrustedRepository();
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
    logLines,
  } as AppDeps & { logLines: string[]; trusted: FakeTrustedRepository };
}

export type { TypedSupabaseClient };
