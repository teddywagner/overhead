import { AppError } from '@overhead/core';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from './lib/context';
import { errorResponse } from './lib/envelope';

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Assign a request id (honouring a well-formed inbound X-Request-Id). */
export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const inbound = c.req.header('x-request-id');
  const id = inbound && REQUEST_ID_RE.test(inbound) ? inbound : crypto.randomUUID();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
};

/**
 * Structured access log. Logs the matched route pattern and status only —
 * never query strings, headers, bodies, tokens or coordinates.
 */
export const accessLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const started = performance.now();
  await next();
  const deps = c.get('deps');
  const status = c.res.status;
  const fields = {
    request_id: c.get('requestId'),
    method: c.req.method,
    route: c.req.routePath,
    status,
    duration_ms: Math.round(performance.now() - started),
    user_id: c.get('userId'),
    device_id: c.get('deviceId'),
  };
  if (status >= 500) deps.logger.error('request', fields);
  else deps.logger.info('request', fields);
};

export function clientIp(c: Context<AppEnv>): string {
  const deps = c.get('deps');
  if (deps.env.TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (xff) return xff;
  }
  const server = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
  return server?.requestIP?.(c.req.raw)?.address ?? 'unknown';
}

export const apiBodyTooLarge = (c: Context<AppEnv>) =>
  errorResponse(c, 'payload_too_large', 'Request body too large', 413);

export function rateLimit(
  keyFn: (c: Context<AppEnv>) => string,
  limit: number,
  windowS: number,
  onLimited: (c: Context<AppEnv>, retryAfterS: number) => Response,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const result = c.get('deps').rateLimiter.hit(keyFn(c), limit, windowS);
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterS));
      return onLimited(c, result.retryAfterS);
    }
    return next();
  };
}

export const apiRateLimited = (c: Context<AppEnv>) =>
  errorResponse(c, 'rate_limited', 'Too many requests', 429);

/** Supabase access-token authentication for /api/v1. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/.exec(header);
  if (!match) throw new AppError('unauthorized', 'Missing or malformed bearer token');
  const token = match[1]!;
  const deps = c.get('deps');
  const user = await deps.verifyAccessToken(token);
  if (!user) throw new AppError('unauthorized', 'Invalid or expired access token');
  c.set('userId', user.userId);
  c.set('db', deps.userClient(token));
  await next();
};

export const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
};
