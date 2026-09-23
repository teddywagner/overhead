import { createRoute, z } from '@hono/zod-openapi';
import { AppError, BUCKETS, POSTER_STATUSES } from '@overhead/core';
import { PANEL_HEIGHT, PANEL_WIDTH, verifyPanelBinary } from '@overhead/device-protocol';
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
import { OBJECT_KINDS, assertOwnedPath, createSignedUpload } from '../lib/storage';
import {
  POSTER_COLUMNS,
  POSTER_ITEM_COLUMNS,
  deletedSchema,
  posterCreateSchema,
  posterItemSchema,
  posterItemsCreateSchema,
  posterSchema,
  posterUpdateSchema,
  uploadUrlSchema,
} from '../schemas';

const tag = 'Posters';

type PosterRow = z.infer<typeof posterSchema>;

export const postersRouter = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/posters',
      ...meta(tag, 'List posters'),
      request: {
        query: z.object({
          ...paginationQuery,
          location_id: z.string().uuid().optional(),
          status: z.enum(POSTER_STATUSES).optional(),
        }),
      },
      responses: okResponses(page(posterSchema)),
    }),
    async (c) => {
      const q = c.req.valid('query');
      const after = decodeCursor(q.cursor);
      let query = c
        .get('db')
        .from('posters')
        .select(POSTER_COLUMNS)
        .eq('owner_id', c.get('userId'))
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(q.limit + 1);
      if (q.location_id) query = query.eq('location_id', q.location_id);
      if (q.status) query = query.eq('status', q.status);
      if (after) query = query.or(keysetFilter('created_at', 'id', after));
      const rows = unwrap(await query, 'Posters') as Array<Record<string, unknown>>;
      return ok(c, {
        items: rows.slice(0, q.limit),
        next_cursor: nextCursor(rows, q.limit, 'created_at'),
      });
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/posters',
      ...meta(tag, 'Create poster metadata', 'Rendering is not part of this phase.'),
      request: { body: jsonBody(posterCreateSchema) },
      responses: createdResponses(posterSchema),
    }),
    async (c) => {
      const body = c.req.valid('json');
      const row = unwrap(
        await c
          .get('db')
          .from('posters')
          .insert({
            owner_id: c.get('userId'),
            location_id: body.location_id,
            local_date: body.local_date,
            template_version: body.template_version,
            width: body.width ?? PANEL_WIDTH,
            height: body.height ?? PANEL_HEIGHT,
          })
          .select(POSTER_COLUMNS)
          .single(),
        'Poster',
      );
      return ok(c, row, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/posters/{id}',
      ...meta(tag, 'Get a poster with its items'),
      request: { params: uuidParam },
      responses: okResponses(posterSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const row = unwrap(
        await c
          .get('db')
          .from('posters')
          .select(`${POSTER_COLUMNS},items:poster_items(${POSTER_ITEM_COLUMNS})`)
          .eq('id', id)
          .eq('owner_id', c.get('userId'))
          .order('display_order', { referencedTable: 'items', ascending: true })
          .maybeSingle(),
        'Poster',
      );
      return ok(c, row);
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/posters/{id}',
      ...meta(
        tag,
        'Update a poster',
        'Setting status to "ready" downloads the uploaded device binary, verifies it is a 960,000-byte ' +
          'Spectra 6 panel image and records its sha256. Frames are only ever served verified binaries.',
      ),
      request: { params: uuidParam, body: jsonBody(posterUpdateSchema) },
      responses: okResponses(posterSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const db = c.get('db');
      const userId = c.get('userId');
      assertOwnedPath(
        body.full_color_preview_path,
        userId,
        OBJECT_KINDS.preview,
        'full_color_preview_path',
      );
      assertOwnedPath(body.eink_preview_path, userId, OBJECT_KINDS.preview, 'eink_preview_path');

      const { status, ...rest } = body;
      if (status !== 'ready') {
        // Moving away from "ready" is a plain metadata update.
        const patch = status === undefined ? rest : { ...rest, status };
        const row = unwrap(
          await db
            .from('posters')
            .update(patch)
            .eq('id', id)
            .eq('owner_id', userId)
            .select(POSTER_COLUMNS)
            .maybeSingle(),
          'Poster',
        );
        return ok(c, row);
      }

      if (Object.keys(rest).length > 0) {
        unwrap(
          await db
            .from('posters')
            .update(rest)
            .eq('id', id)
            .eq('owner_id', userId)
            .select('id')
            .maybeSingle(),
          'Poster',
        );
      }
      const poster = unwrap(
        await db
          .from('posters')
          .select(POSTER_COLUMNS)
          .eq('id', id)
          .eq('owner_id', userId)
          .maybeSingle(),
        'Poster',
      ) as PosterRow;
      if (poster.width !== PANEL_WIDTH || poster.height !== PANEL_HEIGHT) {
        throw new AppError('invalid_state', `Frame posters must be ${PANEL_WIDTH}x${PANEL_HEIGHT}`);
      }
      const path = poster.device_binary_path;
      if (!path)
        throw new AppError(
          'invalid_state',
          'Upload a device binary before marking the poster ready',
        );
      const download = await db.storage.from(BUCKETS.deviceBinaries).download(path);
      if (download.error || !download.data) {
        throw new AppError('storage_object_missing', 'Device binary has not been uploaded');
      }
      const verdict = verifyPanelBinary(new Uint8Array(await download.data.arrayBuffer()));
      if (!verdict.ok)
        throw new AppError('validation_failed', `Device binary rejected: ${verdict.error}`);
      const updated = await c
        .get('deps')
        .trusted.markPosterBinaryVerified(userId, id, path, verdict.sha256);
      if (!updated) throw new AppError('conflict', 'Poster changed during verification; retry');
      const row = unwrap(
        await db
          .from('posters')
          .select(POSTER_COLUMNS)
          .eq('id', id)
          .eq('owner_id', userId)
          .maybeSingle(),
        'Poster',
      );
      return ok(c, row);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/posters/{id}',
      ...meta(tag, 'Delete a poster and its items'),
      request: { params: uuidParam },
      responses: okResponses(deletedSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      unwrap(
        await c
          .get('db')
          .from('posters')
          .delete()
          .eq('id', id)
          .eq('owner_id', c.get('userId'))
          .select('id')
          .maybeSingle(),
        'Poster',
      );
      return ok(c, { id, deleted: true });
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/posters/{id}/items',
      ...meta(tag, 'Add overflights to a poster', 'Overflights and art assets must belong to you.'),
      request: { params: uuidParam, body: jsonBody(posterItemsCreateSchema) },
      responses: createdResponses(z.object({ items: z.array(posterItemSchema) })),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { items } = c.req.valid('json');
      const userId = c.get('userId');
      const db = c.get('db');
      unwrap(
        await db.from('posters').select('id').eq('id', id).eq('owner_id', userId).maybeSingle(),
        'Poster',
      );
      const rows = unwrap(
        await db
          .from('poster_items')
          .insert(
            items.map((i) => ({
              owner_id: userId,
              poster_id: id,
              overflight_id: i.overflight_id,
              art_asset_id: i.art_asset_id ?? null,
              display_order: i.display_order,
              rendered_labels: i.rendered_labels ?? {},
            })),
          )
          .select(POSTER_ITEM_COLUMNS),
        'Poster item',
      );
      return ok(c, { items: rows }, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/posters/{id}/device-binary-upload-url',
      ...meta(
        tag,
        'Create a signed upload URL for the frame binary',
        'Resets the poster to draft (if ready) until the new binary is verified via PATCH status=ready.',
      ),
      request: { params: uuidParam },
      responses: createdResponses(uploadUrlSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const userId = c.get('userId');
      const db = c.get('db');
      unwrap(
        await db.from('posters').select('id').eq('id', id).eq('owner_id', userId).maybeSingle(),
        'Poster',
      );
      // Short, server-chosen path: signed URLs must fit the frame's 768-byte buffer.
      const suffix = crypto.randomUUID().slice(0, 8);
      const path = `${userId}/${OBJECT_KINDS.binary}/${id}-${suffix}.bin`;
      const upload = await createSignedUpload(db, BUCKETS.deviceBinaries, path);
      const updated = await c.get('deps').trusted.setPosterBinaryPath(userId, id, path);
      if (!updated) throw new AppError('not_found', 'Poster not found');
      return ok(c, upload, 201);
    },
  );
