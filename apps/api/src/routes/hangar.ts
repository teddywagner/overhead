import { createRoute, z } from '@hono/zod-openapi';
import { decodeCursor, keysetFilter, nextCursor, paginationQuery, unwrap } from '../lib/db';
import { ok, page } from '../lib/envelope';
import { createRouter, meta, okResponses } from '../lib/router';
import {
  HANGAR_COLUMNS,
  OVERFLIGHT_COLUMNS,
  hangarEntrySchema,
  overflightSchema,
} from '../schemas';

const tag = 'Hangar';

export const hangarRouter = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/hangar',
      ...meta(
        tag,
        'Unique aircraft you have observed',
        'Aggregated by the security-invoker view public.hangar_aircraft, so only your own overflights count.',
      ),
      request: { query: z.object(paginationQuery) },
      responses: okResponses(page(hangarEntrySchema)),
    }),
    async (c) => {
      const { limit, cursor } = c.req.valid('query');
      const after = decodeCursor(cursor);
      let q = c
        .get('db')
        .from('hangar_aircraft')
        .select(HANGAR_COLUMNS)
        .eq('owner_id', c.get('userId'))
        .order('last_seen_at', { ascending: false })
        .order('aircraft_id', { ascending: false })
        .limit(limit + 1);
      if (after) q = q.or(keysetFilter('last_seen_at', 'aircraft_id', after));
      const rows = unwrap(await q, 'Hangar') as Array<Record<string, unknown>>;
      return ok(c, {
        items: rows.slice(0, limit),
        next_cursor: nextCursor(rows, limit, 'last_seen_at', 'aircraft_id'),
      });
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/hangar/{aircraft_id}',
      ...meta(tag, 'Hangar entry with its most recent passes'),
      request: {
        params: z.object({
          aircraft_id: z
            .string()
            .uuid()
            .openapi({ param: { name: 'aircraft_id', in: 'path' } }),
        }),
      },
      responses: okResponses(
        hangarEntrySchema
          .extend({ recent_overflights: z.array(overflightSchema) })
          .openapi('HangarDetail'),
      ),
    }),
    async (c) => {
      const { aircraft_id } = c.req.valid('param');
      const db = c.get('db');
      const userId = c.get('userId');
      const entry = unwrap(
        await db
          .from('hangar_aircraft')
          .select(HANGAR_COLUMNS)
          .eq('owner_id', userId)
          .eq('aircraft_id', aircraft_id)
          .maybeSingle(),
        'Hangar entry',
      ) as Record<string, unknown>;
      const recent = unwrap(
        await db
          .from('overflights')
          .select(OVERFLIGHT_COLUMNS)
          .eq('owner_id', userId)
          .eq('aircraft_id', aircraft_id)
          .order('closest_seen_at', { ascending: false })
          .limit(20),
        'Overflights',
      );
      return ok(c, { ...entry, recent_overflights: recent });
    },
  );
