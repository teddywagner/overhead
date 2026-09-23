import { createRoute, z } from '@hono/zod-openapi';
import { AppError } from '@overhead/core';
import type { TypedSupabaseClient } from '@overhead/database';
import { generateSetupSecret, hashCredential, normalizeMac } from '@overhead/device-protocol';
import type { AppDeps } from '../deps';
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
  DEVICE_COLUMNS,
  deletedSchema,
  deviceCreateSchema,
  deviceSchema,
  deviceUpdateSchema,
  deviceWithSecretSchema,
  rotateSecretSchema,
} from '../schemas';

const tag = 'Devices';

type DeviceRow = Record<string, unknown> & { id: string };

async function withEnrollment(deps: AppDeps, ownerId: string, rows: DeviceRow[]) {
  const info = await deps.trusted.getEnrollment(
    ownerId,
    rows.map((r) => r.id),
  );
  const byId = new Map(info.map((i) => [i.deviceId, i]));
  return rows.map((r) => ({
    ...r,
    enrollment_state: byId.get(r.id)?.enrollmentState ?? null,
    token_created_at: byId.get(r.id)?.tokenCreatedAt ?? null,
  }));
}

async function loadDevice(
  db: TypedSupabaseClient,
  id: string,
  ownerId: string,
): Promise<DeviceRow> {
  return unwrap(
    await db
      .from('devices')
      .select(DEVICE_COLUMNS)
      .eq('id', id)
      .eq('owner_id', ownerId)
      .maybeSingle(),
    'Device',
  ) as DeviceRow;
}

export const devicesRouter = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/devices',
      ...meta(tag, 'List devices'),
      request: { query: z.object(paginationQuery) },
      responses: okResponses(page(deviceSchema)),
    }),
    async (c) => {
      const { limit, cursor } = c.req.valid('query');
      const after = decodeCursor(cursor);
      const userId = c.get('userId');
      let q = c
        .get('db')
        .from('devices')
        .select(DEVICE_COLUMNS)
        .eq('owner_id', userId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (after) q = q.or(keysetFilter('created_at', 'id', after));
      const rows = unwrap(await q, 'Devices') as DeviceRow[];
      const items = await withEnrollment(c.get('deps'), userId, rows.slice(0, limit));
      return ok(c, { items, next_cursor: nextCursor(rows, limit, 'created_at') });
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/devices',
      ...meta(
        tag,
        'Register a frame',
        'Returns a setup secret exactly once. Enter it as the BYOS setup secret when provisioning the frame; only its SHA-256 hash is stored.',
      ),
      request: { body: jsonBody(deviceCreateSchema) },
      responses: createdResponses(deviceWithSecretSchema),
    }),
    async (c) => {
      const body = c.req.valid('json');
      const mac = normalizeMac(body.mac_address);
      if (!mac) throw new AppError('validation_failed', 'mac_address must be a 48-bit MAC address');
      const userId = c.get('userId');
      const db = c.get('db');
      const deps = c.get('deps');
      const device = unwrap(
        await db
          .from('devices')
          .insert({
            owner_id: userId,
            name: body.name,
            mac_address: mac,
            location_id: body.location_id ?? null,
            hardware_revision: body.hardware_revision ?? null,
            poll_interval_seconds: body.poll_interval_seconds ?? 3600,
          })
          .select(DEVICE_COLUMNS)
          .single(),
        'Device',
      ) as DeviceRow;

      const secret = generateSetupSecret();
      let stored = false;
      try {
        stored = await deps.trusted.createDeviceCredential(
          userId,
          device.id,
          hashCredential(secret),
        );
      } finally {
        if (!stored) await db.from('devices').delete().eq('id', device.id).eq('owner_id', userId);
      }
      if (!stored) throw new AppError('internal_error', 'Could not create device credentials');
      const [withState] = await withEnrollment(deps, userId, [device]);
      return ok(c, { device: withState, setup_secret: secret }, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/devices/{id}',
      ...meta(tag, 'Get a device'),
      request: { params: uuidParam },
      responses: okResponses(deviceSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const userId = c.get('userId');
      const device = await loadDevice(c.get('db'), id, userId);
      const [withState] = await withEnrollment(c.get('deps'), userId, [device]);
      return ok(c, withState);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/devices/{id}',
      ...meta(tag, 'Update a device'),
      request: { params: uuidParam, body: jsonBody(deviceUpdateSchema) },
      responses: okResponses(deviceSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const userId = c.get('userId');
      const row = unwrap(
        await c
          .get('db')
          .from('devices')
          .update(body)
          .eq('id', id)
          .eq('owner_id', userId)
          .select(DEVICE_COLUMNS)
          .maybeSingle(),
        'Device',
      ) as DeviceRow;
      const [withState] = await withEnrollment(c.get('deps'), userId, [row]);
      return ok(c, withState);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/devices/{id}',
      ...meta(
        tag,
        'Delete a device',
        'Its credentials are deleted and its token stops working immediately.',
      ),
      request: { params: uuidParam },
      responses: okResponses(deletedSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      unwrap(
        await c
          .get('db')
          .from('devices')
          .delete()
          .eq('id', id)
          .eq('owner_id', c.get('userId'))
          .select('id')
          .maybeSingle(),
        'Device',
      );
      return ok(c, { id, deleted: true });
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/devices/{id}/rotate-setup-secret',
      ...meta(tag, 'Issue a new setup secret (shown once)'),
      request: { params: uuidParam, body: jsonBody(rotateSecretSchema) },
      responses: okResponses(deviceWithSecretSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { revoke_token } = c.req.valid('json');
      const userId = c.get('userId');
      const deps = c.get('deps');
      const device = await loadDevice(c.get('db'), id, userId);
      const secret = generateSetupSecret();
      const rotated = await deps.trusted.rotateSetupSecret(
        userId,
        id,
        hashCredential(secret),
        revoke_token ?? false,
      );
      if (!rotated) throw new AppError('not_found', 'Device not found');
      const [withState] = await withEnrollment(deps, userId, [device]);
      return ok(c, { device: withState, setup_secret: secret });
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/devices/{id}/request-reset',
      ...meta(
        tag,
        'Ask the frame to factory-reset on its next wake',
        'Delivered as reset=true in the next /device/v1/display response; cleared when the frame sets up again.',
      ),
      request: { params: uuidParam },
      responses: okResponses(deviceSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const userId = c.get('userId');
      const row = unwrap(
        await c
          .get('db')
          .from('devices')
          .update({ reset_requested: true })
          .eq('id', id)
          .eq('owner_id', userId)
          .select(DEVICE_COLUMNS)
          .maybeSingle(),
        'Device',
      ) as DeviceRow;
      const [withState] = await withEnrollment(c.get('deps'), userId, [row]);
      return ok(c, withState);
    },
  );
