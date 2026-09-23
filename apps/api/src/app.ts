import type { OpenAPIHono } from '@hono/zod-openapi';
import { APP_VERSION, AppError, appName } from '@overhead/core';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppDeps } from './deps';
import type { AppEnv } from './lib/context';
import { appErrorResponse, errorResponse } from './lib/envelope';
import { LIMITS } from './lib/rate-limit';
import { createRouter } from './lib/router';
import {
  accessLog,
  apiBodyTooLarge,
  apiRateLimited,
  clientIp,
  noStore,
  rateLimit,
  requestContext,
  requireAdmin,
  requireUser,
} from './middleware';
import { adminRouter } from './routes/admin';
import { adminAssetsRouter } from './routes/admin-assets';
import { aircraftRouter } from './routes/aircraft';
import { artAssetsRouter } from './routes/art-assets';
import { deviceProtocolRouter } from './routes/device-protocol';
import { devicesRouter } from './routes/devices';
import { hangarRouter } from './routes/hangar';
import { locationsRouter } from './routes/locations';
import { overflightsRouter } from './routes/overflights';
import { postersRouter } from './routes/posters';
import { profileRouter } from './routes/profile';
import { sourceImagesRouter } from './routes/source-images';
import { systemRouter } from './routes/system';

export function createApp(deps: AppDeps) {
  const app = createRouter();

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    await next();
  });
  app.use('*', requestContext);
  app.use('*', accessLog);
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      crossOriginResourcePolicy: 'same-origin',
      referrerPolicy: 'no-referrer',
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    }),
  );
  app.use('*', noStore);

  const allowed = new Set(deps.env.CORS_ALLOWED_ORIGINS);
  const corsFor = (path: string) =>
    app.use(
      path,
      cors({
        origin: (origin) => (allowed.has(origin) ? origin : null),
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
        exposeHeaders: ['X-Request-Id', 'Retry-After'],
        maxAge: 600,
        credentials: false,
      }),
    );
  corsFor('/api/*');
  corsFor('/admin/*');

  // --- system -------------------------------------------------------------
  const systemLimit = rateLimit(
    (c) => `system:${clientIp(c)}`,
    LIMITS.system.limit,
    LIMITS.system.windowS,
    apiRateLimited,
  );
  app.use('/health', systemLimit);
  app.use('/ready', systemLimit);
  app.use('/openapi.json', systemLimit);
  app.route('/', systemRouter);

  // --- authenticated application API -------------------------------------
  app.use(
    '/api/v1/*',
    bodyLimit({ maxSize: deps.env.API_BODY_LIMIT_BYTES, onError: apiBodyTooLarge }),
  );
  app.use('/api/v1/*', requireUser);
  app.use(
    '/api/v1/*',
    rateLimit(
      (c) => `user:${c.get('userId')}`,
      LIMITS.user.limit,
      LIMITS.user.windowS,
      apiRateLimited,
    ),
  );
  // Routers are widened before mounting: their accumulated route types
  // (including supabase-js select-string parsing) are not needed here and
  // would otherwise exceed the compiler's instantiation depth.
  const apiRouters = [
    profileRouter,
    locationsRouter,
    aircraftRouter,
    overflightsRouter,
    hangarRouter,
    sourceImagesRouter,
    artAssetsRouter,
    postersRouter,
    devicesRouter,
  ] as unknown as OpenAPIHono<AppEnv>[];
  for (const router of apiRouters) app.route('/api/v1', router);

  // --- admin board (cross-owner; admins only) ----------------------------
  app.use(
    '/admin/v1/*',
    bodyLimit({ maxSize: deps.env.API_BODY_LIMIT_BYTES, onError: apiBodyTooLarge }),
  );
  app.use('/admin/v1/*', requireUser);
  app.use(
    '/admin/v1/*',
    rateLimit(
      (c) => `admin:${c.get('userId')}`,
      LIMITS.user.limit,
      LIMITS.user.windowS,
      apiRateLimited,
    ),
  );
  app.use('/admin/v1/*', requireAdmin);
  app.route('/admin/v1', adminRouter as unknown as OpenAPIHono<AppEnv>);
  app.route('/admin/v1', adminAssetsRouter as unknown as OpenAPIHono<AppEnv>);

  // --- FlightPortrait-compatible device protocol --------------------------
  app.route('/device/v1', deviceProtocolRouter);

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Supabase Auth access token',
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'deviceBearer', {
    type: 'http',
    scheme: 'bearer',
    description: '64-hex device token issued by POST /device/v1/setup',
  });
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: `${appName({ APP_NAME: deps.env.APP_NAME })} API`,
      version: APP_VERSION,
      description:
        'Backend API. Application endpoints return {data, error, request_id} envelopes; ' +
        'device endpoints follow the FlightPortrait protocol wire format.',
    },
  });

  app.notFound((c) => {
    if (c.req.path.startsWith('/device/')) return c.json({ detail: 'unknown endpoint' }, 404);
    return errorResponse(c, 'not_found', 'Route not found', 404);
  });

  app.onError((err, c) => {
    if (err instanceof AppError) return appErrorResponse(c, err);
    deps.logger.error('unhandled error', {
      request_id: c.get('requestId'),
      route: c.req.routePath,
      error_name: err instanceof Error ? err.name : 'unknown',
      error: err instanceof Error ? err.message : String(err),
    });
    if (c.req.path.startsWith('/device/')) return c.json({ detail: 'internal error' }, 500);
    return errorResponse(c, 'internal_error', 'Internal server error', 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
export type { AppEnv };
