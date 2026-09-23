import { createRoute } from '@hono/zod-openapi';
import {
  decodeCursor,
  escapeLike,
  keysetFilter,
  nextCursor,
  paginationQuery,
  unwrap,
  uuidParam,
} from '../lib/db';
import { ok, page } from '../lib/envelope';
import { createRouter, jsonBody, meta, okResponses } from '../lib/router';
import {
  AIRCRAFT_COLUMNS,
  aircraftQuerySchema,
  aircraftSchema,
  aircraftUpdateSchema,
} from '../schemas';

const tag = 'Aircraft';

export const aircraftRouter = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/aircraft',
      ...meta(
        tag,
        'Search aircraft you have observed',
        'Filters: registration (prefix), icao24 (exact), type_code (exact), manufacturer and model (substring).',
      ),
      request: { query: aircraftQuerySchema.extend(paginationQuery) },
      responses: okResponses(page(aircraftSchema)),
    }),
    async (c) => {
      const q = c.req.valid('query');
      const after = decodeCursor(q.cursor);
      // RLS limits rows to aircraft the caller has observed or annotated.
      let query = c
        .get('db')
        .from('aircraft')
        .select(AIRCRAFT_COLUMNS)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(q.limit + 1);
      if (q.registration)
        query = query.ilike('registration', `${escapeLike(q.registration.toUpperCase())}%`);
      if (q.icao24) query = query.eq('icao24', q.icao24);
      if (q.type_code) query = query.eq('icao_type_code', q.type_code);
      if (q.manufacturer) query = query.ilike('manufacturer', `%${escapeLike(q.manufacturer)}%`);
      if (q.model) query = query.ilike('model', `%${escapeLike(q.model)}%`);
      if (after) query = query.or(keysetFilter('created_at', 'id', after));
      const rows = unwrap(await query, 'Aircraft') as Array<Record<string, unknown>>;
      return ok(c, {
        items: rows.slice(0, q.limit),
        next_cursor: nextCursor(rows, q.limit, 'created_at'),
      });
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/aircraft/{id}',
      ...meta(tag, 'Get an aircraft'),
      request: { params: uuidParam },
      responses: okResponses(aircraftSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const row = unwrap(
        await c.get('db').from('aircraft').select(AIRCRAFT_COLUMNS).eq('id', id).maybeSingle(),
        'Aircraft',
      );
      return ok(c, row);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/aircraft/{id}',
      ...meta(
        tag,
        'Correct aircraft metadata',
        'Allowed only for aircraft you have observed. Marks metadata_source as "manual" so provider data will not overwrite registration or type.',
      ),
      request: { params: uuidParam, body: jsonBody(aircraftUpdateSchema) },
      responses: okResponses(aircraftSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = unwrap(
        await c
          .get('db')
          .from('aircraft')
          .update({ ...body, metadata_source: 'manual' })
          .eq('id', id)
          .select(AIRCRAFT_COLUMNS)
          .maybeSingle(),
        'Aircraft',
      );
      return ok(c, row);
    },
  );
