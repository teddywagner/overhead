import { createRoute, z } from '@hono/zod-openapi';
import { APP_VERSION, appName } from '@overhead/core';
import { envelope, errorEnvelopeSchema, ok, requestId } from '../lib/envelope';
import { createRouter } from '../lib/router';

const healthSchema = z.object({ status: z.literal('ok'), name: z.string(), version: z.string() });
const readySchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({ config: z.enum(['ok', 'error']), database: z.enum(['ok', 'error']) }),
});

export const systemRouter = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/health',
      tags: ['System'],
      summary: 'Liveness probe',
      responses: {
        200: {
          description: 'Alive',
          content: { 'application/json': { schema: envelope(healthSchema) } },
        },
      },
    }),
    (c) =>
      ok(c, {
        status: 'ok' as const,
        name: appName({ APP_NAME: c.get('deps').env.APP_NAME }),
        version: APP_VERSION,
      }),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/ready',
      tags: ['System'],
      summary: 'Readiness probe (configuration and database connectivity)',
      responses: {
        200: {
          description: 'Ready',
          content: { 'application/json': { schema: envelope(readySchema) } },
        },
        503: {
          description: 'Not ready',
          content: { 'application/json': { schema: errorEnvelopeSchema } },
        },
      },
    }),
    async (c) => {
      // Configuration was validated at startup; reaching here means it passed.
      const database = (await c.get('deps').checkDatabase()) ? 'ok' : 'error';
      if (database !== 'ok') {
        return c.json(
          {
            data: null,
            error: {
              code: 'not_ready',
              message: 'Service not ready',
              details: { checks: { config: 'ok', database } },
            },
            request_id: requestId(c),
          },
          503,
        ) as never;
      }
      return ok(c, { status: 'ready' as const, checks: { config: 'ok' as const, database } });
    },
  );
