import { createRoute, z } from '@hono/zod-openapi';
import { AppError, METERS_PER_NM, notFound } from '@overhead/core';
import {
  decideCommit,
  mergeDisplaySettings,
  selectForDisplay,
  toDisplayItems,
  wakeSchedule,
  type DisplaySettings,
} from '@overhead/display';
import { uuidParam } from '../lib/db';
import { ok } from '../lib/envelope';
import { createRouter, jsonBody, meta, okResponses } from '../lib/router';
import {
  adminDeviceDetailSchema,
  adminDeviceSchema,
  adminDeviceUpdateSchema,
  adminLocationSchema,
  adminLocationUpdateSchema,
  adminSelectionSchema,
  adminUserSchema,
  displayPreviewRequestSchema,
  displayPreviewSchema,
  displaySettingsPatchSchema,
  displaySettingsSchema,
} from '../schemas';

/**
 * Admin board API (/admin/v1). Mounted behind requireUser + requireAdmin:
 * these routes read across owners through the trusted connection.
 */

const tag = 'Admin';
const WAKE_PREVIEW_COUNT = 12;

const items = <T extends z.ZodType>(schema: T) => z.object({ items: z.array(schema) });
const adminRoleSchema = z.object({ user_id: z.string().uuid(), is_admin: z.boolean() });

function checkQuietHours(s: DisplaySettings): void {
  if ((s.quiet_start_hour === null) !== (s.quiet_end_hour === null)) {
    throw new AppError(
      'validation_failed',
      'quiet_start_hour and quiet_end_hour must both be set or both be null',
    );
  }
}

export const adminRouter = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/me',
      ...meta(tag, 'Confirm admin access', 'Returns 403 for signed-in users who are not admins.'),
      responses: okResponses(z.object({ user_id: z.string().uuid(), is_admin: z.literal(true) })),
    }),
    (c) => ok(c, { user_id: c.get('userId'), is_admin: true as const }),
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/users',
      ...meta(tag, 'List users with activity counts'),
      responses: okResponses(items(adminUserSchema)),
    }),
    async (c) => ok(c, { items: await c.get('deps').admin.listUsers() }),
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/users/{id}/admin',
      ...meta(tag, 'Make a user an admin'),
      request: { params: uuidParam },
      responses: okResponses(adminRoleSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      if (!(await c.get('deps').admin.setAdmin(id, true))) throw notFound('User');
      return ok(c, { user_id: id, is_admin: true });
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/users/{id}/admin',
      ...meta(tag, "Remove a user's admin access", 'You cannot remove your own access.'),
      request: { params: uuidParam },
      responses: okResponses(adminRoleSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      if (id === c.get('userId')) {
        throw new AppError('invalid_state', 'You cannot remove your own admin access');
      }
      if (!(await c.get('deps').admin.setAdmin(id, false))) throw notFound('User');
      return ok(c, { user_id: id, is_admin: false });
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/devices',
      ...meta(tag, 'List frames across users'),
      request: { query: z.object({ owner_id: z.string().uuid().optional() }) },
      responses: okResponses(items(adminDeviceSchema)),
    }),
    async (c) => {
      const { owner_id } = c.req.valid('query');
      return ok(c, { items: await c.get('deps').admin.listDevices({ ownerId: owner_id }) });
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/devices/{id}',
      ...meta(tag, 'Get a frame with its location rules'),
      request: { params: uuidParam },
      responses: okResponses(adminDeviceDetailSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const admin = c.get('deps').admin;
      const [device] = await admin.listDevices({ deviceId: id });
      if (!device) throw notFound('Device');
      const location = device.location_id ? await admin.getLocation(device.location_id) : null;
      const artIds = (device.current_selection?.items ?? []).flatMap((i) =>
        i.art_asset_id ? [i.art_asset_id] : [],
      );
      const art_urls = await c.get('deps').adminAssets.artUrls(artIds);
      return ok(c, { device, location, art_urls });
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/devices/{id}',
      ...meta(
        tag,
        'Rename a frame, change how often it wakes, or point it at another location',
        "location_id must belong to the frame's owner.",
      ),
      request: { params: uuidParam, body: jsonBody(adminDeviceUpdateSchema) },
      responses: okResponses(adminDeviceSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const patch = c.req.valid('json');
      const admin = c.get('deps').admin;
      if (patch.location_id) {
        const [device] = await admin.listDevices({ deviceId: id });
        if (!device) throw notFound('Device');
        const location = await admin.getLocation(patch.location_id);
        if (!location || location.owner_id !== device.owner_id) {
          throw new AppError(
            'validation_failed',
            "location_id must be one of the frame owner's locations",
          );
        }
      }
      if (!(await admin.updateDevice(id, patch))) throw notFound('Device');
      const [device] = await admin.listDevices({ deviceId: id });
      return ok(c, device!);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/devices/{id}/display-settings',
      ...meta(
        tag,
        "Change a frame's display settings",
        'Omitted fields keep their current value (or the default, for a frame without settings).',
      ),
      request: { params: uuidParam, body: jsonBody(displaySettingsPatchSchema) },
      responses: okResponses(displaySettingsSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const admin = c.get('deps').admin;
      const [device] = await admin.listDevices({ deviceId: id });
      if (!device) throw notFound('Device');
      const next = mergeDisplaySettings(device.settings, c.req.valid('json'));
      checkQuietHours(next);
      if (!(await admin.saveSettings(id, next))) throw notFound('Device');
      return ok(c, next);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/devices/{id}/selections',
      ...meta(tag, 'Committed display selections, newest first'),
      request: {
        params: uuidParam,
        query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      },
      responses: okResponses(items(adminSelectionSchema)),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { limit } = c.req.valid('query');
      return ok(c, { items: await c.get('deps').admin.listSelections(id, limit) });
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/devices/{id}/display-preview',
      ...meta(
        tag,
        'Preview what a frame would show',
        'Runs the same selection as the worker, optionally with draft settings or at another ' +
          'instant, and returns every candidate with its score and why it was or was not picked. ' +
          'Nothing is saved.',
      ),
      request: { params: uuidParam, body: jsonBody(displayPreviewRequestSchema) },
      responses: okResponses(displayPreviewSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const deps = c.get('deps');
      const at = body.at ? new Date(body.at) : (deps.clock?.() ?? new Date());

      const [device] = await deps.admin.listDevices({ deviceId: id });
      if (!device) throw notFound('Device');
      const settings = mergeDisplaySettings(device.settings, body.settings);
      checkQuietHours(settings);
      const inputs = await deps.admin.previewInputs(id, at, settings.window_hours);
      if (!inputs) throw new AppError('invalid_state', 'The frame has no location');

      const pick = selectForDisplay(inputs.candidates, settings, inputs.device.rules, at);
      const art_urls = await deps.adminAssets.artUrls(
        inputs.candidates.flatMap((c) => (c.art_asset_id ? [c.art_asset_id] : [])),
      );
      const pollS = body.poll_interval_seconds ?? inputs.device.pollIntervalSeconds;
      return ok(c, {
        at: at.toISOString(),
        settings,
        poll_interval_seconds: pollS,
        timezone: inputs.device.timeZone,
        selected: toDisplayItems(pick.selected),
        candidates: pick.ranked.map((r) => ({
          ...r.candidate,
          score: r.score,
          components: r.components,
          excluded: r.excluded,
        })),
        current_selection: inputs.current,
        decision: decideCommit(
          inputs.current,
          pick.selected.map((s) => s.candidate.overflight_id),
          at,
          settings.min_dwell_minutes,
        ),
        wake_schedule: wakeSchedule(
          at,
          pollS,
          inputs.device.timeZone,
          settings,
          WAKE_PREVIEW_COUNT,
        ),
        art_urls,
      });
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/locations',
      ...meta(tag, "A user's locations (never coordinates)"),
      request: { query: z.object({ owner_id: z.string().uuid() }) },
      responses: okResponses(items(adminLocationSchema)),
    }),
    async (c) => {
      const { owner_id } = c.req.valid('query');
      return ok(c, { items: await c.get('deps').admin.listLocations(owner_id) });
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/locations/{id}',
      ...meta(tag, "Change a location's detection rules (never its coordinates)"),
      request: { params: uuidParam, body: jsonBody(adminLocationUpdateSchema) },
      responses: okResponses(adminLocationSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const patch = c.req.valid('json');
      const admin = c.get('deps').admin;
      const current = await admin.getLocation(id);
      if (!current) throw notFound('Location');
      const next = { ...current, ...patch };
      if (next.overhead_radius_m > next.search_radius_nm * METERS_PER_NM) {
        throw new AppError(
          'validation_failed',
          'overhead_radius_m must fit inside search_radius_nm',
        );
      }
      await admin.updateLocation(id, patch);
      return ok(c, (await admin.getLocation(id))!);
    },
  );
