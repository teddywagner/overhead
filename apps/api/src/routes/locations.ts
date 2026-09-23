import { createRoute, z } from '@hono/zod-openapi';
import { AppError } from '@overhead/core';
import {
  decodeCursor,
  keysetFilter,
  nextCursor,
  paginationQuery,
  unwrap,
  uuidParam,
} from '../lib/db';
import { ok, page } from '../lib/envelope';
import { createRouter, createdResponses, jsonBody, meta, okResponses } from '../lib/router';
import {
  LOCATION_COLUMNS,
  LOCATION_SUMMARY_COLUMNS,
  deletedSchema,
  locationCreateSchema,
  locationSchema,
  locationSummarySchema,
  locationUpdateSchema,
} from '../schemas';

const tag = 'Locations';

export const locationsRouter = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/locations',
      ...meta(
        tag,
        'List locations',
        'Coordinates are omitted; fetch a single location to see them.',
      ),
      request: { query: z.object(paginationQuery) },
      responses: okResponses(page(locationSummarySchema)),
    }),
    async (c) => {
      const { limit, cursor } = c.req.valid('query');
      const after = decodeCursor(cursor);
      let q = c
        .get('db')
        .from('locations')
        .select(LOCATION_SUMMARY_COLUMNS)
        .eq('owner_id', c.get('userId'))
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (after) q = q.or(keysetFilter('created_at', 'id', after));
      const rows = unwrap(await q, 'Locations') as Array<Record<string, unknown>>;
      return ok(c, {
        items: rows.slice(0, limit),
        next_cursor: nextCursor(rows, limit, 'created_at'),
      });
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/locations',
      ...meta(tag, 'Create a location'),
      request: { body: jsonBody(locationCreateSchema) },
      responses: createdResponses(locationSchema),
    }),
    async (c) => {
      const body = c.req.valid('json');
      const { env } = c.get('deps');
      const record = {
        owner_id: c.get('userId'),
        name: body.name,
        latitude: body.latitude,
        longitude: body.longitude,
        search_radius_nm: body.search_radius_nm ?? env.DEFAULT_SEARCH_RADIUS_NM,
        overhead_radius_m: body.overhead_radius_m ?? Math.round(env.DEFAULT_OVERHEAD_RADIUS_M),
        max_altitude_ft: body.max_altitude_ft ?? Math.round(env.DEFAULT_MAX_ALTITUDE_FT),
        timezone: body.timezone ?? env.DEFAULT_TIMEZONE,
        is_active: body.is_active ?? true,
      };
      if (record.overhead_radius_m > record.search_radius_nm * 1852) {
        throw new AppError(
          'validation_failed',
          'overhead_radius_m must fit inside search_radius_nm',
        );
      }
      const row = unwrap(
        await c.get('db').from('locations').insert(record).select(LOCATION_COLUMNS).single(),
        'Location',
      );
      return ok(c, row, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/locations/{id}',
      ...meta(tag, 'Get a location, including its private coordinates'),
      request: { params: uuidParam },
      responses: okResponses(locationSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const row = unwrap(
        await c
          .get('db')
          .from('locations')
          .select(LOCATION_COLUMNS)
          .eq('id', id)
          .eq('owner_id', c.get('userId'))
          .maybeSingle(),
        'Location',
      );
      return ok(c, row);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/locations/{id}',
      ...meta(tag, 'Update a location'),
      request: { params: uuidParam, body: jsonBody(locationUpdateSchema) },
      responses: okResponses(locationSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = unwrap(
        await c
          .get('db')
          .from('locations')
          .update(body)
          .eq('id', id)
          .eq('owner_id', c.get('userId'))
          .select(LOCATION_COLUMNS)
          .maybeSingle(),
        'Location',
      );
      return ok(c, row);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/locations/{id}',
      ...meta(tag, 'Delete a location', 'Also deletes its overflights, posters and worker state.'),
      request: { params: uuidParam },
      responses: okResponses(deletedSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      unwrap(
        await c
          .get('db')
          .from('locations')
          .delete()
          .eq('id', id)
          .eq('owner_id', c.get('userId'))
          .select('id')
          .maybeSingle(),
        'Location',
      );
      return ok(c, { id, deleted: true });
    },
  );
