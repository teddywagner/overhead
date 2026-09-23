import { OpenAPIHono, type z } from '@hono/zod-openapi';
import type { AppEnv } from './context';
import { envelope, errorResponse, errorResponses } from './envelope';

/** Router whose validation failures use the standard error envelope. */
export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const details = result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        }));
        return errorResponse(c, 'validation_failed', 'Request validation failed', 400, details);
      }
    },
  });
}

/** Shared route metadata for authenticated /api/v1 routes. */
export const meta = (tag: string, summary: string, description?: string) => ({
  tags: [tag],
  summary,
  ...(description ? { description } : {}),
  security: [{ bearerAuth: [] }],
});

export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
  required: true as const,
});

export const okResponses = <T extends z.ZodType>(schema: T) => ({
  200: { description: 'Success', content: { 'application/json': { schema: envelope(schema) } } },
  ...errorResponses,
});

export const createdResponses = <T extends z.ZodType>(schema: T) => ({
  201: { description: 'Created', content: { 'application/json': { schema: envelope(schema) } } },
  ...errorResponses,
});
