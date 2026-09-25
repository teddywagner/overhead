import { createRoute, z } from '@hono/zod-openapi';
import { ART_SCOPES, ART_STATUSES, AppError, notFound } from '@overhead/core';
import { ProviderError, type PhotoCandidate } from '@overhead/flight-tracking';
import type { AppDeps } from '../deps';
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
  aircraftPhotoSchema,
  deletedSchema,
  photoCandidatesSchema,
  photoCollectionEntrySchema,
  photoCollectionSetSchema,
  photoPickResultSchema,
  photoPickSchema,
  artScopeProblem,
  coverageRowSchema,
  seenAircraftReportSchema,
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
const icao24Param = z.object({ icao24: z.string().regex(/^~?[0-9a-fA-F]{6}$/) });
const registrationQuery = z.object({ registration: upper(/^[A-Z0-9-]{1,12}$/).optional() });

function photoLookup(deps: AppDeps) {
  if (!deps.aircraftPhotos) {
    throw new AppError(
      'not_ready',
      'Aircraft photos need AIRCRAFT_PROVIDER_USER_AGENT set on the API',
    );
  }
  return deps.aircraftPhotos;
}

const candidateJson = (c: PhotoCandidate) => ({
  provider: c.provider,
  thumbnail_url: c.thumbnailUrl,
  image_url: c.imageUrl,
  page_url: c.pageUrl,
  creator: c.creator,
  license_name: c.licenseName,
  license_url: c.licenseUrl,
});

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
      path: '/seen-aircraft',
      ...meta(
        tag,
        'Planes seen overhead',
        'Recorded passes grouped by airframe, most-seen first, plus pass counts by aircraft ' +
          'type and by operator. `manufacturer` is a comma-separated list of name prefixes, ' +
          'e.g. `airbus,boeing`. `exclude_helicopters` drops types classed as helicopters, ' +
          'and Bell, Eurocopter and Airbus Helicopters aircraft whose type is unknown.',
      ),
      request: {
        query: z.object({
          owner_id: z.string().uuid().optional(),
          days: z.coerce.number().int().min(1).max(365).default(30),
          include_near_misses: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true'),
          type_code: upper(/^[A-Z0-9]{2,4}$/).optional(),
          operator: upper(/^[A-Z]{3}$/).optional(),
          manufacturer: z
            .string()
            .trim()
            .regex(/^[A-Za-z][A-Za-z .-]{0,39}(,[A-Za-z][A-Za-z .-]{0,39}){0,9}$/)
            .optional(),
          exclude_helicopters: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true'),
          limit: limit(500, 200),
        }),
      },
      responses: okResponses(seenAircraftReportSchema),
    }),
    async (c) => {
      const q = c.req.valid('query');
      return ok(
        c,
        await c.get('deps').adminAssets.seenAircraft({
          viewerId: c.get('userId'),
          ownerId: q.owner_id,
          days: q.days,
          includeNearMisses: q.include_near_misses,
          typeCode: q.type_code,
          operatorIcao: q.operator,
          manufacturers: q.manufacturer?.split(','),
          excludeHelicopters: q.exclude_helicopters,
          limit: q.limit,
        }),
      );
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/aircraft-photos/{icao24}/candidates',
      ...meta(
        tag,
        'Every photo on offer for an airframe',
        'From Planespotters.net, adsbdb (airport-data.com) and Wikimedia Commons (by ' +
          'registration). Sources that fail are listed in `failed`; the rest still return.',
      ),
      request: { params: icao24Param, query: registrationQuery },
      responses: okResponses(photoCandidatesSchema),
    }),
    async (c) => {
      const { icao24 } = c.req.valid('param');
      const { registration } = c.req.valid('query');
      const found = await photoLookup(c.get('deps')).candidates(icao24, registration ?? null);
      return ok(c, { items: found.items.map(candidateJson), failed: found.failed });
    },
  )
  .openapi(
    createRoute({
      method: 'post',
      path: '/aircraft-photos/{icao24}/picks',
      ...meta(
        tag,
        'Save a photo for an airframe',
        'image_url must be one of the photos the candidates endpoint lists for this airframe. ' +
          'Saved as a source image (links only). The latest pick is shown on the Aircraft page. ' +
          "When your collection has no photo for the aircraft's operator + type yet, this one " +
          'fills the slot; otherwise `collection` returns the current best to compare against.',
      ),
      request: { params: icao24Param, body: jsonBody(photoPickSchema) },
      responses: createdResponses(photoPickResultSchema),
    }),
    async (c) => {
      const { icao24 } = c.req.valid('param');
      const { image_url, registration } = c.req.valid('json');
      const deps = c.get('deps');
      const { items } = await photoLookup(deps).candidates(icao24, registration ?? null);
      const pick = items.find((p) => p.imageUrl === image_url);
      if (!pick) throw notFound('Photo for this aircraft');
      const saved = await deps.adminAssets.savePhotoPick(c.get('userId'), icao24, pick);
      if (!saved) throw notFound('Aircraft');
      return ok(c, saved, 201);
    },
  )
  .openapi(
    createRoute({
      method: 'put',
      path: '/photo-collection',
      ...meta(
        tag,
        'Choose the best photo for an operator + type',
        "Makes one of your saved photos the best for its aircraft's operator + type slot, " +
          "replacing the slot's current best.",
      ),
      request: { body: jsonBody(photoCollectionSetSchema) },
      responses: okResponses(photoCollectionEntrySchema),
    }),
    async (c) => {
      const { source_image_id } = c.req.valid('json');
      const result = await c
        .get('deps')
        .adminAssets.setCollectionBest(c.get('userId'), source_image_id);
      if (result === 'not_found') throw notFound('Saved photo');
      if (result === 'no_type') {
        throw new AppError(
          'validation_failed',
          'This aircraft’s type is unknown, so it has no collection slot',
        );
      }
      return ok(c, result);
    },
  )
  .openapi(
    createRoute({
      method: 'delete',
      path: '/aircraft-photos/picks/{id}',
      ...meta(tag, 'Remove a saved photo'),
      request: { params: uuidParam },
      responses: okResponses(deletedSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      if (!(await c.get('deps').adminAssets.deletePhotoPick(id))) throw notFound('Saved photo');
      return ok(c, { id, deleted: true as const });
    },
  )
  .openapi(
    createRoute({
      method: 'get',
      path: '/aircraft-photos/{icao24}',
      ...meta(
        tag,
        'Photo of an airframe',
        'Looked up on Planespotters.net by Mode S address, then registration, and cached. ' +
          'Fails with not_ready when AIRCRAFT_PROVIDER_USER_AGENT is not set or ' +
          'Planespotters cannot be reached.',
      ),
      request: {
        params: icao24Param,
        query: registrationQuery,
      },
      responses: okResponses(aircraftPhotoSchema),
    }),
    async (c) => {
      const { icao24 } = c.req.valid('param');
      const { registration } = c.req.valid('query');
      const photos = photoLookup(c.get('deps'));
      try {
        const p = await photos.photo(icao24, registration ?? null);
        return ok(c, {
          photo: p && {
            thumbnail_url: p.thumbnailUrl,
            large_url: p.largeUrl,
            page_url: p.pageUrl,
            photographer: p.photographer,
          },
        });
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        c.get('deps').logger.warn('aircraft photo lookup failed', { code: err.code });
        throw new AppError('not_ready', 'Photo lookup is unavailable right now');
      }
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
      method: 'post',
      path: '/source-images/{id}/cutout',
      ...meta(
        tag,
        'Remove a photo’s background',
        'Queues a background-removed copy (a "cutout") for the worker, or re-queues it. ' +
          'The worker needs CUTOUT_PROVIDER set. Refused when the photo’s licence does not ' +
          'allow edited copies (see `cutout_refusal`): Planespotters.net and airport-data.com ' +
          'photos may only be linked to.',
      ),
      request: { params: uuidParam },
      responses: okResponses(adminSourceImageSchema),
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const result = await c.get('deps').adminAssets.requestCutout(id);
      if (result === 'not_found') throw notFound('Source image');
      if ('refused' in result) throw new AppError('validation_failed', result.refused);
      return ok(c, result);
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
