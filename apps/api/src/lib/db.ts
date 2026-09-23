import { z } from '@hono/zod-openapi';
import { AppError } from '@overhead/core';

interface PostgrestLikeError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

/**
 * Map a PostgREST/Postgres error to a safe AppError. Raw database messages
 * can contain values (e.g. conflicting keys) so they are never returned.
 */
export function dbError(err: PostgrestLikeError, what = 'Record'): AppError {
  switch (err.code) {
    case 'PGRST116':
      return new AppError('not_found', `${what} not found`);
    case '23505':
      return new AppError('conflict', `${what} conflicts with an existing record`);
    case '23503':
      return new AppError(
        'validation_failed',
        'A referenced record does not exist or is not yours',
      );
    case '23514':
    case '23502':
    case '22P02':
    case '22007':
    case '22008':
      return new AppError('validation_failed', `${what} failed validation`);
    case '42501':
      return new AppError('forbidden', 'Not permitted');
    default:
      return new AppError('internal_error', 'Database request failed');
  }
}

export function unwrap<T>(
  result: { data: T | null; error: PostgrestLikeError | null },
  what = 'Record',
): T {
  if (result.error) throw dbError(result.error, what);
  if (result.data === null) throw new AppError('not_found', `${what} not found`);
  return result.data;
}

/** Escape LIKE wildcards in user input. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

const cursorSchema = z.object({ k: z.string().max(64), id: z.string().uuid() });

export interface Cursor {
  k: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')),
    );
    if (parsed.success && /^[0-9A-Za-z:.+-]+$/.test(parsed.data.k)) return parsed.data;
  } catch {
    // fall through
  }
  throw new AppError('validation_failed', 'Invalid cursor');
}

/**
 * PostgREST keyset condition for descending (key, id) order. Values are
 * validated (ISO timestamp / uuid) before interpolation and quoted.
 */
export function keysetFilter(column: string, idColumn: string, c: Cursor): string {
  return `${column}.lt."${c.k}",and(${column}.eq."${c.k}",${idColumn}.lt.${c.id})`;
}

export function nextCursor<T extends Record<string, unknown>>(
  rows: T[],
  limit: number,
  keyColumn: keyof T,
  idColumn: keyof T = 'id',
): string | null {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1]!;
  return encodeCursor({ k: String(last[keyColumn]), id: String(last[idColumn]) });
}

export const paginationQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(25).openapi({ example: 25 }),
  cursor: z.string().max(400).optional().openapi({ description: 'Opaque cursor from next_cursor' }),
};

export const uuidParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({
      param: { name: 'id', in: 'path' },
      example: '22222222-2222-4222-8222-222222222222',
    }),
});
