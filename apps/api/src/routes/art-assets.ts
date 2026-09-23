import { createRoute, z } from '@hono/zod-openapi';
import type { TablesUpdate, TypedSupabaseClient } from '@overhead/database';
import { ART_SCOPES, ART_STATUSES, AppError, BUCKETS } from '@overhead/core';
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
  OBJECT_KINDS,
  assertOwnedPath,
  createSignedUpload,
  imageObjectPath,
  objectExists,
} from '../lib/storage';
import {
  ART_ASSET_COLUMNS,
  artAssetCreateSchema,
  artAssetSchema,
  artAssetUpdateSchema,
  artReviewSchema,
  artScopeProblem,
  deletedSchema,
  imageUploadRequestSchema,
  uploadUrlSchema,
} from '../schemas';

const tag = 'Art assets';

type ArtRow = z.infer<typeof artAssetSchema>;

export const artAssetsRouter = createRouter()
  .openapi(
    createRoute({
      method: 'post',
      path: '/art-assets/upload-url',
      ...meta(tag, 'Create a signed upload URL for artwork (or its thumbnail)'),
      request: { body: jsonBody(imageUploadRequestSchema) },
      responses: createdResponses(uploadUrlSchema),
    }),
    async (c) => {
      const { filename, content_type } = c.req.valid('json');
      const path = imageObjectPath(c.get('userId'), OBJECT_KINDS.art, filename, content_type);
      return ok(c, await createSignedUpload(c.get('db'), BUCKETS.aircraftArt, path), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/art-assets',
      ...meta(tag, 'List art assets'),
      request: {
        query: z.object({
          ...paginationQuery,
          status: z.enum(ART_STATUSES).optional(),
          scope: z.enum(ART_SCOPES).optional(),
          icao_type_code: z
            .string()
            .trim()
            .toUpperCase()
            .regex(/^[A-Z0-9]{2,4}$/)
            .optional(),
          aircraft_id: z.string().uuid().optional(),
        }),
      },
      responses: okResponses(page(artAssetSchema)),
    }),
    async (c) => {
      const q = c.req.valid('query');
      const after = decodeCursor(q.cursor);
      let query = c
        .get('db')
        .from('art_assets')
        .select(ART_ASSET_COLUMNS)
        .eq('owner_id', c.get('userId'))
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(q.limit + 1);
      if (q.status) query = query.eq('status', q.status);
      if (q.scope) query = query.eq('scope', q.scope);
      if (q.icao_type_code) query = query.eq('icao_type_code', q.icao_type_code);
      if (q.aircraft_id) query = query.eq('aircraft_id', q.aircraft_id);
      if (after) query = query.or(keysetFilter('created_at', 'id', after));
      const rows = unwrap(await query, 'Art assets') as Array<Record<string, unknown>>;
      return ok(c, {
        items: rows.slice(0, q.limit),
        next_cursor: nextCursor(rows, q.limit, 'created_at'),
      });
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/art-assets',
      ...meta(tag, 'Create an art asset record', 'New assets start as draft or pending_review.'),
      request: { body: jsonBody(artAssetCreateSchema) },
      responses: createdResponses(artAssetSchema),
    }),
    async (c) => {
      const body = c.req.valid('json');
      const userId = c.get('userId');
      assertOwnedPath(body.storage_path, userId, OBJECT_KINDS.art, 'storage_path');
      assertOwnedPath(body.thumbnail_path, userId, OBJECT_KINDS.art, 'thumbnail_path');
      if (body.status === 'archived') {
        throw new AppError('validation_failed', 'New art assets must be draft or pending_review');
      }
      const row = unwrap(
        await c
          .get('db')
          .from('art_assets')
          .insert({ ...body, owner_id: userId, status: body.status ?? 'draft' })
          .select(ART_ASSET_COLUMNS)
          .single(),
        'Art asset',
      );
      return ok(c, row, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/art-assets/{id}',
      ...meta(tag, 'Get an art asset'),
      request: { params: uuidParam },
      responses: okResponses(artAssetSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      return ok(c, await loadArt(c.get('db'), id, c.get('userId')));
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/art-assets/{id}',
      ...meta(
        tag,
        'Update an art asset',
        'Replacing the image of an approved asset returns it to pending_review.',
      ),
      request: { params: uuidParam, body: jsonBody(artAssetUpdateSchema) },
      responses: okResponses(artAssetSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const userId = c.get('userId');
      const db = c.get('db');
      assertOwnedPath(body.storage_path, userId, OBJECT_KINDS.art, 'storage_path');
      assertOwnedPath(body.thumbnail_path, userId, OBJECT_KINDS.art, 'thumbnail_path');
      const current = await loadArt(db, id, userId);
      const merged = { ...current, ...body };
      const problem = artScopeProblem(merged);
      if (problem) throw new AppError('validation_failed', problem);

      const patch: TablesUpdate<'art_assets'> = { ...body };
      const imageChanged =
        (body.storage_path !== undefined && body.storage_path !== current.storage_path) ||
        (body.thumbnail_path !== undefined && body.thumbnail_path !== current.thumbnail_path);
      if (current.status === 'approved' && (imageChanged || body.status !== undefined)) {
        patch.status = body.status ?? 'pending_review';
        patch.approved_at = null;
      }
      const row = unwrap(
        await db
          .from('art_assets')
          .update(patch)
          .eq('id', id)
          .eq('owner_id', userId)
          .select(ART_ASSET_COLUMNS)
          .maybeSingle(),
        'Art asset',
      );
      return ok(c, row);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/art-assets/{id}',
      ...meta(
        tag,
        'Delete an art asset record',
        'Stored objects are kept; delete them separately if unused.',
      ),
      request: { params: uuidParam },
      responses: okResponses(deletedSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      unwrap(
        await c
          .get('db')
          .from('art_assets')
          .delete()
          .eq('id', id)
          .eq('owner_id', c.get('userId'))
          .select('id')
          .maybeSingle(),
        'Art asset',
      );
      return ok(c, { id, deleted: true });
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/art-assets/{id}/approve',
      ...meta(
        tag,
        'Approve an art asset',
        'Fails with storage_object_missing unless the image (and thumbnail) exist.',
      ),
      request: { params: uuidParam, body: jsonBody(artReviewSchema) },
      responses: okResponses(artAssetSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { reviewer_notes } = c.req.valid('json');
      const db = c.get('db');
      const userId = c.get('userId');
      const current = await loadArt(db, id, userId);
      for (const path of [current.storage_path, current.thumbnail_path]) {
        if (path && !(await objectExists(db, BUCKETS.aircraftArt, path))) {
          throw new AppError('storage_object_missing', 'Artwork file has not been uploaded');
        }
      }
      const now = (c.get('deps').clock ?? (() => new Date()))().toISOString();
      const row = unwrap(
        await db
          .from('art_assets')
          .update({
            status: 'approved',
            approved_at: now,
            ...(reviewer_notes !== undefined ? { reviewer_notes } : {}),
          })
          .eq('id', id)
          .eq('owner_id', userId)
          .select(ART_ASSET_COLUMNS)
          .maybeSingle(),
        'Art asset',
      );
      return ok(c, row);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/art-assets/{id}/reject',
      ...meta(tag, 'Reject an art asset'),
      request: { params: uuidParam, body: jsonBody(artReviewSchema) },
      responses: okResponses(artAssetSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { reviewer_notes } = c.req.valid('json');
      const row = unwrap(
        await c
          .get('db')
          .from('art_assets')
          .update({
            status: 'rejected',
            approved_at: null,
            ...(reviewer_notes !== undefined ? { reviewer_notes } : {}),
          })
          .eq('id', id)
          .eq('owner_id', c.get('userId'))
          .select(ART_ASSET_COLUMNS)
          .maybeSingle(),
        'Art asset',
      );
      return ok(c, row);
    },
  );

async function loadArt(db: TypedSupabaseClient, id: string, userId: string): Promise<ArtRow> {
  return unwrap(
    await db
      .from('art_assets')
      .select(ART_ASSET_COLUMNS)
      .eq('id', id)
      .eq('owner_id', userId)
      .maybeSingle(),
    'Art asset',
  ) as ArtRow;
}
