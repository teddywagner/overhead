/**
 * Write the OpenAPI document to docs/openapi.json without any network,
 * database or credentials: route schemas are the single source of truth.
 *   bun run openapi
 */
import { silentLogger } from '@overhead/core';
import { createApp } from '../src/app';
import type { AppDeps } from '../src/deps';
import { MemoryRateLimiter } from '../src/lib/rate-limit';

const unavailable = () => {
  throw new Error('not available while exporting OpenAPI');
};

const deps = {
  env: {
    APP_NAME: process.env.APP_NAME ?? 'Overhead',
    NODE_ENV: 'development',
    CORS_ALLOWED_ORIGINS: [],
    TRUST_PROXY: false,
    API_BODY_LIMIT_BYTES: 65_536,
    DEVICE_SIGNED_URL_TTL_SECONDS: 300,
    DEFAULT_SEARCH_RADIUS_NM: 5,
    DEFAULT_OVERHEAD_RADIUS_M: 1200,
    DEFAULT_MAX_ALTITUDE_FT: 15000,
    DEFAULT_TIMEZONE: 'America/New_York',
  },
  logger: silentLogger,
  verifyAccessToken: async () => null,
  userClient: unavailable,
  trusted: new Proxy({}, { get: unavailable }),
  checkDatabase: async () => false,
  rateLimiter: new MemoryRateLimiter(),
} as unknown as AppDeps;

const res = await createApp(deps).request('/openapi.json');
const doc = await res.json();
const out = new URL('../../../docs/openapi.json', import.meta.url);
await Bun.write(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(
  `wrote ${Object.keys((doc as { paths: object }).paths).length} paths to docs/openapi.json`,
);
