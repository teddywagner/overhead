import { apiEnvSchema, loadEnv, type ApiEnv } from '@overhead/core';
import { createAdminClient, createSql, type Sql } from '@overhead/database';
import { createClient } from '@supabase/supabase-js';
import { createApp } from '../../apps/api/src/app';
import { buildDeps } from '../../apps/api/src/index';

/**
 * Integration tests run against a local Supabase stack (`bun run db:start`
 * then `bun run db:reset`) using the variables in `.env`. They are skipped
 * when the stack is unreachable unless REQUIRE_INTEGRATION=1.
 */
export async function integrationEnv(): Promise<ApiEnv | null> {
  if (process.env.SKIP_INTEGRATION === '1') return null;
  let env: ApiEnv;
  try {
    env = loadEnv(apiEnvSchema);
  } catch (err) {
    if (process.env.REQUIRE_INTEGRATION === '1') throw err;
    return null;
  }
  const host = new URL(env.SUPABASE_URL).hostname;
  if (process.env.REQUIRE_INTEGRATION !== '1' && !['127.0.0.1', 'localhost'].includes(host)) {
    // Never run destructive integration tests against a hosted project by accident.
    return null;
  }
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`auth health ${res.status}`);
  } catch (err) {
    if (process.env.REQUIRE_INTEGRATION === '1') throw err;
    return null;
  }
  return env;
}

export const ENV = await integrationEnv();
export const skipIntegration = ENV === null;
if (skipIntegration && process.env.SKIP_INTEGRATION !== '1') {
  console.warn('[integration] local Supabase not reachable — integration tests skipped');
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  headers: Record<string, string>;
}

export async function createTestUser(env: ApiEnv, label: string): Promise<TestUser> {
  const admin = createAdminClient(env);
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@overhead.test`;
  const password = `pw-${crypto.randomUUID()}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw created.error ?? new Error('createUser failed');
  const anon = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const session = await anon.auth.signInWithPassword({ email, password });
  if (session.error || !session.data.session) throw session.error ?? new Error('sign-in failed');
  const token = session.data.session.access_token;
  return {
    id: created.data.user.id,
    email,
    token,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
}

export async function deleteTestUser(env: ApiEnv, user: TestUser): Promise<void> {
  await createAdminClient(env).auth.admin.deleteUser(user.id);
}

export function makeApp(env: ApiEnv) {
  const deps = buildDeps({ ...env, LOG_LEVEL: 'silent' });
  return { app: createApp(deps), deps };
}

export function sqlFor(env: ApiEnv): Sql {
  return createSql(env.DATABASE_URL, { max: 2 });
}

export interface Envelope<T = unknown> {
  data: T;
  error: { code: string; message: string } | null;
  request_id: string;
}

export async function call<T = unknown>(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  user: TestUser | null,
  body?: unknown,
): Promise<{ status: number; body: Envelope<T> }> {
  const res = await app.request(path, {
    method,
    headers: user ? user.headers : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Envelope<T> };
}
