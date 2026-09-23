import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const required = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .trim()
    .min(1);

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const baseEnvSchema = z.object({
  APP_NAME: z.string().trim().min(1).default('Overhead'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  DEFAULT_SEARCH_RADIUS_NM: z.coerce.number().positive().max(250).default(5),
  DEFAULT_OVERHEAD_RADIUS_M: z.coerce.number().positive().max(50_000).default(1200),
  DEFAULT_MAX_ALTITUDE_FT: z.coerce.number().positive().max(60_000).default(15_000),
  DEFAULT_TIMEZONE: z
    .string()
    .default('America/New_York')
    .refine(isValidTimeZone, 'must be an IANA time zone such as America/New_York'),
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: required('DATABASE_URL').refine(
    (v) => /^postgres(ql)?:\/\//.test(v),
    'must be a postgres:// connection string',
  ),
});

export const supabaseEnvSchema = z.object({
  SUPABASE_URL: required('SUPABASE_URL').pipe(z.url('must be a URL')),
  SUPABASE_PUBLISHABLE_KEY: required('SUPABASE_PUBLISHABLE_KEY'),
  SUPABASE_SECRET_KEY: required('SUPABASE_SECRET_KEY'),
});

export const apiEnvSchema = baseEnvSchema
  .extend(supabaseEnvSchema.shape)
  .extend(databaseEnvSchema.shape)
  .extend({
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    CORS_ALLOWED_ORIGINS: csv,
    TRUST_PROXY: bool,
    API_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(64 * 1024),
    DEVICE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  });

export const workerEnvSchema = baseEnvSchema
  .extend(databaseEnvSchema.shape)
  .extend({
    AIRCRAFT_PROVIDER: z.enum(['adsb_lol', 'airplanes_live', 'mock']).default('adsb_lol'),
    ADSB_LOL_BASE_URL: z.url().default('https://api.adsb.lol'),
    AIRPLANES_LIVE_BASE_URL: z.url().default('https://api.airplanes.live'),
    /** Sent to whichever ADS-B provider is active. */
    AIRCRAFT_PROVIDER_USER_AGENT: z.string().trim().default(''),
    /** Legacy name for AIRCRAFT_PROVIDER_USER_AGENT; still honoured. */
    AIRPLANES_LIVE_USER_AGENT: z.string().trim().default(''),
    /** Aircraft/route details lookup. Disabled automatically with the mock provider. */
    ENRICHMENT_PROVIDER: z.enum(['adsbdb', 'none']).default('adsbdb'),
    ADSBDB_BASE_URL: z.url().default('https://api.adsbdb.com'),
    ENRICHMENT_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(30),
    ENRICHMENT_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    WORKER_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(15),
    PASS_GAP_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    OVERFLIGHT_POINT_SAMPLE_SECONDS: z.coerce.number().int().min(1).max(600).default(30),
    OVERFLIGHT_POINT_MAX_PER_PASS: z.coerce.number().int().min(2).max(2000).default(200),
    RETENTION_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(60),
    MOCK_SCENARIO: z.string().default('direct-crossing'),
  })
  .superRefine((env, ctx) => {
    if (env.AIRCRAFT_PROVIDER !== 'mock' && providerUserAgent(env).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['AIRCRAFT_PROVIDER_USER_AGENT'],
        message:
          `is required when AIRCRAFT_PROVIDER=${env.AIRCRAFT_PROVIDER} ` +
          '(use a descriptive value with contact details, e.g. "overhead/0.1 (you@example.com)")',
      });
    }
  });

/** The User-Agent for ADS-B provider requests (new name first, legacy fallback). */
export function providerUserAgent(env: {
  AIRCRAFT_PROVIDER_USER_AGENT: string;
  AIRPLANES_LIVE_USER_AGENT: string;
}): string {
  return env.AIRCRAFT_PROVIDER_USER_AGENT || env.AIRPLANES_LIVE_USER_AGENT;
}

export type BaseEnv = z.infer<typeof baseEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Parse and validate environment variables. Messages name the variable and
 * the problem but never echo the supplied value, which may be a secret.
 */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  // Empty strings (e.g. untouched .env placeholders) count as unset.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v !== '') cleaned[k] = v;
  }
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => {
        const key = issue.path.join('.') || '(root)';
        if (issue.code === 'invalid_type') return `${key} is required`;
        return `${key} ${issue.message}`;
      }),
    );
  }
  return result.data;
}
