import type { ApiEnv, Logger } from '@overhead/core';
import type { TypedSupabaseClient } from '@overhead/database';
import type { AdminAssetsRepository } from './admin-assets-repo';
import type { AdminRepository } from './admin-repo';
import type { RateLimiter } from './lib/rate-limit';
import type { TrustedRepository } from './trusted-repo';

export interface VerifiedUser {
  userId: string;
}

/**
 * Everything the HTTP layer needs, injected so routes can be tested
 * without a network or database.
 */
export interface AppDeps {
  env: Pick<
    ApiEnv,
    | 'APP_NAME'
    | 'NODE_ENV'
    | 'CORS_ALLOWED_ORIGINS'
    | 'TRUST_PROXY'
    | 'API_BODY_LIMIT_BYTES'
    | 'DEVICE_SIGNED_URL_TTL_SECONDS'
    | 'DEFAULT_SEARCH_RADIUS_NM'
    | 'DEFAULT_OVERHEAD_RADIUS_M'
    | 'DEFAULT_MAX_ALTITUDE_FT'
    | 'DEFAULT_TIMEZONE'
  >;
  logger: Logger;
  /** Verify a Supabase access token; null when invalid or expired. */
  verifyAccessToken(token: string): Promise<VerifiedUser | null>;
  /** Supabase client scoped to the caller's token (RLS enforced). */
  userClient(token: string): TypedSupabaseClient;
  /** Trusted server-side operations (private schema, secret key). */
  trusted: TrustedRepository;
  /** Cross-owner operations for the admin board (behind requireAdmin only). */
  admin: AdminRepository;
  /** Cross-owner artwork, images and posters for the admin board. */
  adminAssets: AdminAssetsRepository;
  /** Probe used by /ready. */
  checkDatabase(): Promise<boolean>;
  rateLimiter: RateLimiter;
  clock?: () => Date;
}
