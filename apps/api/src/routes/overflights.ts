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
import { createRouter, meta, okResponses } from '../lib/router';
import {
  OVERFLIGHT_COLUMNS,
  includePositionQuery,
  overflightDetailSchema,
  overflightPointSchema,
  overflightQuerySchema,
  overflightSchema,
} from '../schemas';

const tag = 'Overflights';
const AIRCRAFT_EMBED = 'icao_type_code,operator_icao,manufacturer,model';

export const overflightsRouter = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/overflights',
      ...meta(
        tag,
        'List overflights',
        'Newest first by closest approach. Dates are local to the location. Closest-approach ' +
          'coordinates are omitted unless include_position=true.',
      ),
      request: { query: overflightQuerySchema.extend(paginationQuery) },
      responses: okResponses(page(overflightSchema)),
    }),
    async (c) => {
      const q = c.req.valid('query');
      if (q.from && q.to && q.from > q.to)
        throw new AppError('validation_failed', 'from must not be after to');
      const after = decodeCursor(q.cursor);
      const needsInner = Boolean(q.type_code || q.operator);
      const position = q.include_position === 'true' ? ',closest_latitude,closest_longitude' : '';
      const columns: string = `${OVERFLIGHT_COLUMNS}${position},aircraft${needsInner ? '!inner' : ''}(${AIRCRAFT_EMBED})`;
      let query = c
        .get('db')
        .from('overflights')
        .select(columns)
        .eq('owner_id', c.get('userId'))
        .order('closest_seen_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(q.limit + 1);
      if (q.location_id) query = query.eq('location_id', q.location_id);
      if (q.from) query = query.gte('local_date', q.from);
      if (q.to) query = query.lte('local_date', q.to);
      if (q.registration) query = query.eq('registration', q.registration);
      if (q.status) query = query.eq('status', q.status);
      if (q.type_code) query = query.eq('aircraft.icao_type_code', q.type_code);
      if (q.operator) query = query.eq('aircraft.operator_icao', q.operator);
      if (after) query = query.or(keysetFilter('closest_seen_at', 'id', after));
      const rows = unwrap(await query, 'Overflights') as unknown as Array<Record<string, unknown>>;
      return ok(c, {
        items: rows.slice(0, q.limit),
        next_cursor: nextCursor(rows, q.limit, 'closest_seen_at'),
      });
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/overflights/{id}',
      ...meta(tag, 'Get an overflight'),
      request: {
        params: uuidParam,
        query: z.object({ include_position: includePositionQuery }),
      },
      responses: okResponses(overflightDetailSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const withPosition = c.req.valid('query').include_position === 'true';
      const columns = `${OVERFLIGHT_COLUMNS},provider_pass_key,raw_summary${
        withPosition ? ',closest_latitude,closest_longitude' : ''
      },aircraft(${AIRCRAFT_EMBED})`;
      const row = unwrap(
        await c
          .get('db')
          .from('overflights')
          .select(columns)
          .eq('id', id)
          .eq('owner_id', c.get('userId'))
          .maybeSingle(),
        'Overflight',
      );
      return ok(c, row);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/overflights/{id}/points',
      ...meta(
        tag,
        'Sampled track points for an overflight',
        'Returns private coordinates; ordered by time.',
      ),
      request: { params: uuidParam },
      responses: okResponses(z.object({ items: z.array(overflightPointSchema) })),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const db = c.get('db');
      unwrap(
        await db
          .from('overflights')
          .select('id')
          .eq('id', id)
          .eq('owner_id', c.get('userId'))
          .maybeSingle(),
        'Overflight',
      );
      const points = unwrap(
        await db
          .from('overflight_points')
          .select(
            'observed_at,latitude,longitude,altitude_ft,groundspeed_knots,track_degrees,source',
          )
          .eq('overflight_id', id)
          .order('observed_at', { ascending: true })
          .limit(2000),
        'Points',
      );
      return ok(c, { items: points });
    },
  );
