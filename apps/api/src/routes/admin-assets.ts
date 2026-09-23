import { createRoute, z } from '@hono/zod-openapi';
import { ART_SCOPES, ART_STATUSES, AppError, notFound } from '@overhead/core';
import { uuidParam } from '../lib/db';
import { ok } from '../lib/envelope';
import { createRouter, createdResponses, jsonBody, meta, okResponses } from '../lib/router';
import { OBJECT_KINDS, assertOwnedPath, imageObjectPath } from '../lib/storage';
import {
  adminArtAssetSchema,
  adminArtCreateSchema,
  adminArtListSchema,
  adminArtReviewSchema,
  adminArtUpdateSchema,
  adminArtUploadRequestSchema,
  adminPosterSchema,
  adminSourceImageSchema,
  artScopeProblem,
  coverageRowSchema,
  uploadUrlSchema,
} from '../schemas';

/**
 * Admin board: artwork, source images, posters and art coverage across
 * owners. Mounted under /admin/v1 behind requireUser + requireAdmin.
 */

const tag = 'Admin: assets';
const items = <T extends z.ZodType>(schema: T) => z.object({ items: z.array(schema) });
const limit = (max: number, dflt: number) => z.coerce.number().int().min(1).max(max).default(dflt);
const upper = (re: RegExp) => z.string().trim().toUpperCase().regex(re);

export const adminAssetsRouter = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/art-assets',
      ...meta(tag, 'List artwork across users', 'Pending review first, then newest.'),
      request: {
        query: z.object({
          owner_id: z.string().uuid().optional(),
          status: z.enum(ART_STATUSES).optional(),
          scope: z.enum(ART_SCOPES).optional(),
          type_code: upper(/^[A-Z0-9]{2,4}$/).optional(),
          operator: upper(/^[A-Z]{3}$/).optional(),
          limit: limit(200, 100),
        }),
      },
      responses: okResponses(adminArtListSchema),
    }),
    async (c) => {
      const q = c.req.valid('query');
      const repo = c.get('deps').adminAssets;
      const [list, counts] = await Promise.all([
        repo.listArt({
          ownerId: q.owner_id,
          status: q.status,
          scope: q.scope,
          typeCode: q.type_code,
          operatorIcao: q.operator,
          limit: q.limit,
        }),
        repo.artStatusCounts(q.owner_id),
      ]);
      return ok(c, { items: list, counts });
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/art-assets/upload-url',
      ...meta(tag, "Signed upload URL for artwork in a user's folder"),
      request: { body: jsonBody(adminArtUploadRequestSchema) },
      responses: createdResponses(uploadUrlSchema),
    }),
    async (c) => {
      const { owner_id, filename, content_type } = c.req.valid('json');
      const repo = c.get('deps').adminAssets;
      if (!(await repo.ownerExists(owner_id))) throw notFound('User');
      const path = imageObjectPath(owner_id, OBJECT_KINDS.art, filename, content_type);
      return ok(c, await repo.createArtUpload(path), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/art-assets',
      ...meta(
        tag,
        'Create artwork for a user',
        'storage_path must come from /admin/v1/art-assets/upload-url for the same owner. ' +
          'With approve=true the image must already be uploaded.',
      ),
      request: { body: jsonBody(adminArtCreateSchema) },
      responses: createdResponses(adminArtAssetSchema),
    }),
    async (c) => {
      const { owner_id, storage_path, approve, ...tags } = c.req.valid('json');
      const deps = c.get('deps');
      const repo = deps.adminAssets;
      if (!(await repo.ownerExists(owner_id))) throw notFound('User');
      assertOwnedPath(storage_path, owner_id, OBJECT_KINDS.art, 'storage_path');
      if (approve && !(await repo.artObjectExists(storage_path))) {
        throw new AppError('storage_object_missing', 'Artwork file has not been uploaded');
      }
      const id = await repo.createArt(owner_id, {
        scope: tags.scope,
        icao_type_code: tags.icao_type_code ?? null,
        operator_icao: tags.operator_icao ?? null,
        livery_name: tags.livery_name ?? null,
        registration: tags.registration ?? null,
        reviewer_notes: tags.reviewer_notes ?? null,
        storage_path,
        status: 'pending_review',
      });
      if (approve) await repo.setArtStatus(id, 'approved', undefined, deps.clock?.() ?? new Date());
      return ok(c, (await repo.getArt(id))!, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/art-assets/{id}',
      ...meta(tag, 'Get artwork'),
      request: { params: uuidParam },
      responses: okResponses(adminArtAssetSchema),
    }),
    async (c) => {
      const art = await c.get('deps').adminAssets.getArt(c.req.valid('param').id);
      if (!art) throw notFound('Art asset');
      return ok(c, art);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/art-assets/{id}',
      ...meta(tag, "Change artwork's tags (scope, type, operator, livery, registration, notes)"),
      request: { params: uuidParam, body: jsonBody(adminArtUpdateSchema) },
      responses: okResponses(adminArtAssetSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const patch = c.req.valid('json');
      const repo = c.get('deps').adminAssets;
      const current = await repo.getArt(id);
      if (!current) throw notFound('Art asset');
      const problem = artScopeProblem({ ...current, ...patch });
      if (problem) throw new AppError('validation_failed', problem);
      await repo.updateArt(id, patch);
      return ok(c, (await repo.getArt(id))!);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/art-assets/{id}/review',
      ...meta(
        tag,
        'Approve, reject, archive or reopen artwork',
        'Approval fails with storage_object_missing unless the image (and thumbnail) exist.',
      ),
      request: { params: uuidParam, body: jsonBody(adminArtReviewSchema) },
      responses: okResponses(adminArtAssetSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { status, reviewer_notes } = c.req.valid('json');
      const deps = c.get('deps');
      const repo = deps.adminAssets;
      const current = await repo.getArt(id);
      if (!current) throw notFound('Art asset');
      if (status === 'approved') {
        for (const path of [current.storage_path, current.thumbnail_path]) {
          if (path && !(await repo.artObjectExists(path))) {
            throw new AppError('storage_object_missing', 'Artwork file has not been uploaded');
          }
        }
      }
      await repo.setArtStatus(id, status, reviewer_notes, deps.clock?.() ?? new Date());
      return ok(c, (await repo.getArt(id))!);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/art-coverage',
      ...meta(
        tag,
        'Which planes have artwork',
        'Recorded passes grouped by owner, operator and aircraft type, with the best approved ' +
          'artwork for each group and any drafts waiting for review. Most-seen first.',
      ),
      request: {
        query: z.object({
          owner_id: z.string().uuid().optional(),
          days: z.coerce.number().int().min(1).max(365).default(30),
          include_near_misses: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true'),
        }),
      },
      responses: okResponses(items(coverageRowSchema)),
    }),
    async (c) => {
      const q = c.req.valid('query');
      const rows = await c.get('deps').adminAssets.coverage({
        ownerId: q.owner_id,
        days: q.days,
        includeNearMisses: q.include_near_misses,
      });
      return ok(c, { items: rows });
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/source-images',
      ...meta(tag, 'Reference photos across users, with licence details'),
      request: {
        query: z.object({ owner_id: z.string().uuid().optional(), limit: limit(200, 100) }),
      },
      responses: okResponses(items(adminSourceImageSchema)),
    }),
    async (c) => {
      const q = c.req.valid('query');
      return ok(c, {
        items: await c
          .get('deps')
          .adminAssets.listSourceImages({ ownerId: q.owner_id, limit: q.limit }),
      });
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/posters',
      ...meta(tag, 'Posters across users, with previews and binary status'),
      request: {
        query: z.object({
          owner_id: z.string().uuid().optional(),
          status: z.enum(['draft', 'rendering', 'ready', 'failed', 'archived']).optional(),
          limit: limit(200, 100),
        }),
      },
      responses: okResponses(items(adminPosterSchema)),
    }),
    async (c) => {
      const q = c.req.valid('query');
      return ok(c, {
        items: await c
          .get('deps')
          .adminAssets.listPosters({ ownerId: q.owner_id, status: q.status, limit: q.limit }),
      });
    },
  );
