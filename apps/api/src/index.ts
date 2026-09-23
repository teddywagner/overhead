import {
  APP_VERSION,
  apiEnvSchema,
  appName,
  appSlug,
  createLogger,
  loadEnv,
  type ApiEnv,
} from '@overhead/core';
import {
  createAdminClient,
  createAuthClient,
  createSql,
  createUserClient,
  pingDatabase,
} from '@overhead/database';
import { createApp } from './app';
import type { AppDeps, VerifiedUser } from './deps';
import { MemoryRateLimiter } from './lib/rate-limit';
import { SqlTrustedRepository } from './trusted-repo';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function buildDeps(env: ApiEnv): AppDeps & { close(): Promise<void> } {
  const logger = createLogger({ level: env.LOG_LEVEL, service: `${appSlug(env)}-api` });
  const sql = createSql(env.DATABASE_URL, { max: 10 });
  const authClient = createAuthClient(env);
  const admin = createAdminClient(env);

  const verifyAccessToken = async (token: string): Promise<VerifiedUser | null> => {
    // getClaims verifies the JWT signature (locally via JWKS for asymmetric
    // keys, via the Auth server otherwise) and its expiry.
    const { data, error } = await authClient.auth.getClaims(token);
    if (error || !data?.claims) return null;
    const { sub, role } = data.claims as { sub?: string; role?: string };
    if (!sub || !UUID_RE.test(sub) || role !== 'authenticated') return null;
    return { userId: sub };
  };

  return {
    env,
    logger,
    verifyAccessToken,
    userClient: (token) => createUserClient(env, token),
    trusted: new SqlTrustedRepository(sql, admin),
    checkDatabase: () => pingDatabase(sql),
    rateLimiter: new MemoryRateLimiter(),
    close: () => sql.close(),
  };
}

async function main(): Promise<void> {
  let env: ApiEnv;
  try {
    env = loadEnv(apiEnvSchema);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const deps = buildDeps(env);
  const app = createApp(deps);
  const server = Bun.serve({
    hostname: env.API_HOST,
    port: env.API_PORT,
    fetch: (req, srv) => app.fetch(req, srv),
    maxRequestBodySize: Math.max(env.API_BODY_LIMIT_BYTES, 64 * 1024),
  });
  deps.logger.info('api listening', {
    app: appName(env),
    version: APP_VERSION,
    host: env.API_HOST,
    port: server.port,
  });

  const shutdown = async (signal: string) => {
    deps.logger.info('shutting down', { signal });
    await server.stop();
    await deps.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (import.meta.main) {
  await main();
}
