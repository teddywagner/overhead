import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

export type TypedSupabaseClient = SupabaseClient<Database>;

export interface SupabaseConfig {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SECRET_KEY: string;
}

const serverAuth = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const;

/**
 * Client that acts as the calling user: requests carry the user's access
 * token, so Postgres RLS and Storage policies apply. Use for every
 * user-scoped query.
 */
export function createUserClient(config: SupabaseConfig, accessToken: string): TypedSupabaseClient {
  return createClient<Database>(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
    accessToken: async () => accessToken,
    global: { headers: { 'X-Client-Info': 'overhead-api' } },
  });
}

/** Client used only to verify access tokens (auth.getClaims). */
export function createAuthClient(config: SupabaseConfig): TypedSupabaseClient {
  return createClient<Database>(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
    auth: serverAuth,
  });
}

/**
 * Secret-key client. Bypasses RLS. Only for trusted server operations that
 * have already established authorisation themselves (e.g. signing a device
 * binary URL for an authenticated frame). Never used for user requests.
 */
export function createAdminClient(config: SupabaseConfig): TypedSupabaseClient {
  return createClient<Database>(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
    auth: serverAuth,
  });
}
