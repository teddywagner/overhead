import { SQL } from 'bun';

/**
 * Trusted Postgres connection (Bun's built-in client, no native addons).
 * Used by the worker and the device endpoints for `private` schema access.
 *
 * With Supabase's transaction-mode pooler (port 6543) prepared statements
 * are unavailable, so they are disabled; direct and session-mode
 * connections work either way.
 */
export function createSql(databaseUrl: string, options: { max?: number } = {}): SQL {
  return new SQL({
    url: databaseUrl,
    max: options.max ?? 5,
    idleTimeout: 30,
    connectionTimeout: 10,
    prepare: false,
  });
}

export type Sql = SQL;

/** Cheap connectivity probe for readiness checks. */
export async function pingDatabase(sql: SQL, timeoutMs = 2000): Promise<boolean> {
  try {
    const result = await Promise.race([
      sql`select 1 as ok`,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return Array.isArray(result) && result.length === 1;
  } catch {
    return false;
  }
}
