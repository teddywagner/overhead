import { createRoute, z } from '@hono/zod-openapi';
import { BUCKETS } from '@overhead/core';
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
import { OBJECT_KINDS, assertOwnedPath, createSignedUpload, imageObjectPath } from '../lib/storage';
import {
  SOURCE_IMAGE_COLUMNS,
  deletedSchema,
  imageUploadRequestSchema,
  sourceImageCreateSchema,
  sourceImageSchema,
  sourceImageUpdateSchema,
  uploadUrlSchema,
} from '../schemas';

const tag = 'Source images';

export const sourceImagesRouter = createRouter()
  .openapi(
    createRoute({
      method: 'post',
      path: '/source-images/upload-url',
      ...meta(
        tag,
        'Create a signed upload URL for a source image',
        'The server chooses the bucket and an owner-prefixed path. Use the returned path as storage_path.',
      ),
      request: { body: jsonBody(imageUploadRequestSchema) },
      responses: createdResponses(uploadUrlSchema),
    }),
    async (c) => {
      const { filename, content_type } = c.req.valid('json');
      const path = imageObjectPath(c.get('userId'), OBJECT_KINDS.source, filename, content_type);
      return ok(c, await createSignedUpload(c.get('db'), BUCKETS.sourceImages, path), 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/source-images',
      ...meta(tag, 'List source images'),
      request: {
        query: z.object({ ...paginationQuery, aircraft_id: z.string().uuid().optional() }),
      },
      responses: okResponses(page(sourceImageSchema)),
    }),
    async (c) => {
      const { limit, cursor, aircraft_id } = c.req.valid('query');
      const after = decodeCursor(cursor);
      let q = c
        .get('db')
        .from('source_images')
        .select(SOURCE_IMAGE_COLUMNS)
        .eq('owner_id', c.get('userId'))
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      if (aircraft_id) q = q.eq('aircraft_id', aircraft_id);
      if (after) q = q.or(keysetFilter('created_at', 'id', after));
      const rows = unwrap(await q, 'Source images') as Array<Record<string, unknown>>;
      return ok(c, {
        items: rows.slice(0, limit),
        next_cursor: nextCursor(rows, limit, 'created_at'),
      });
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/source-images',
      ...meta(
        tag,
        'Record a source image',
        'Remote URLs are stored as metadata only; they are never fetched.',
      ),
      request: { body: jsonBody(sourceImageCreateSchema) },
      responses: createdResponses(sourceImageSchema),
    }),
    async (c) => {
      const body = c.req.valid('json');
      const userId = c.get('userId');
      assertOwnedPath(body.storage_path, userId, OBJECT_KINDS.source, 'storage_path');
      const row = unwrap(
        await c
          .get('db')
          .from('source_images')
          .insert({ ...body, owner_id: userId })
          .select(SOURCE_IMAGE_COLUMNS)
          .single(),
        'Source image',
      );
      return ok(c, row, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/source-images/{id}',
      ...meta(tag, 'Get a source image'),
      request: { params: uuidParam },
      responses: okResponses(sourceImageSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const row = unwrap(
        await c
          .get('db')
          .from('source_images')
          .select(SOURCE_IMAGE_COLUMNS)
          .eq('id', id)
          .eq('owner_id', c.get('userId'))
          .maybeSingle(),
        'Source image',
      );
      return ok(c, row);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/source-images/{id}',
      ...meta(tag, 'Update a source image'),
      request: { params: uuidParam, body: jsonBody(sourceImageUpdateSchema) },
      responses: okResponses(sourceImageSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const userId = c.get('userId');
      assertOwnedPath(body.storage_path, userId, OBJECT_KINDS.source, 'storage_path');
      const row = unwrap(
        await c
          .get('db')
          .from('source_images')
          .update(body)
          .eq('id', id)
          .eq('owner_id', userId)
          .select(SOURCE_IMAGE_COLUMNS)
          .maybeSingle(),
        'Source image',
      );
      return ok(c, row);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/source-images/{id}',
      ...meta(tag, 'Delete a source image and its stored object'),
      request: { params: uuidParam },
      responses: okResponses(deletedSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const db = c.get('db');
      const row = unwrap(
        await db
          .from('source_images')
          .delete()
          .eq('id', id)
          .eq('owner_id', c.get('userId'))
          .select('id,storage_path')
          .maybeSingle(),
        'Source image',
      ) as { storage_path: string | null };
      if (row.storage_path) await db.storage.from(BUCKETS.sourceImages).remove([row.storage_path]);
      return ok(c, { id, deleted: true });
    },
  );
