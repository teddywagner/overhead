import { z } from '@hono/zod-openapi';
import type { AppError, ErrorCode } from '@overhead/core';
import type { Context } from 'hono';

export const errorBodySchema = z
  .object({
    code: z.string().openapi({ example: 'not_found' }),
    message: z.string().openapi({ example: 'Location not found' }),
    details: z.unknown().optional(),
  })
  .openapi('Error');

export const errorEnvelopeSchema = z
  .object({
    data: z.null(),
    error: errorBodySchema,
    request_id: z.string(),
  })
  .openapi('ErrorEnvelope');

export function envelope<T extends z.ZodType>(data: T) {
  return z.object({ data, error: z.null(), request_id: z.string() });
}

export function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), next_cursor: z.string().nullable() });
}

export function requestId(c: Context): string {
  return (c.get('requestId' as never) as string | undefined) ?? 'unknown';
}

/**
 * Success envelope. Typed as `never` so handlers satisfy @hono/zod-openapi's
 * declared-response typing without restating every row type; response
 * shapes are covered by the route schemas (docs) and the API tests.
 */
export function ok<T>(c: Context, data: T, status: 200 | 201 = 200): never {
  return c.json({ data, error: null, request_id: requestId(c) }, status) as never;
}

export function errorResponse(
  c: Context,
  code: ErrorCode,
  message: string,
  status: number,
  details?: unknown,
) {
  return c.json(
    {
      data: null,
      error: { code, message, ...(details === undefined ? {} : { details }) },
      request_id: requestId(c),
    },
    status as 400,
  );
}

export function appErrorResponse(c: Context, err: AppError) {
  return errorResponse(c, err.code, err.message, err.status, err.details);
}

/** Standard error responses for OpenAPI route declarations. */
export const errorResponses = {
  400: {
    description: 'Validation failed',
    content: { 'application/json': { schema: errorEnvelopeSchema } },
  },
  401: {
    description: 'Missing or invalid access token',
    content: { 'application/json': { schema: errorEnvelopeSchema } },
  },
  404: {
    description: 'Not found',
    content: { 'application/json': { schema: errorEnvelopeSchema } },
  },
  409: {
    description: 'Conflict',
    content: { 'application/json': { schema: errorEnvelopeSchema } },
  },
  429: {
    description: 'Rate limited',
    content: { 'application/json': { schema: errorEnvelopeSchema } },
  },
} as const;

export function jsonResponse<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } };
}
