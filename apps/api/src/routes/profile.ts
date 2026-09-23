import { createRoute } from '@hono/zod-openapi';
import { unwrap } from '../lib/db';
import { ok } from '../lib/envelope';
import { createRouter, jsonBody, meta, okResponses } from '../lib/router';
import { profileSchema, profileUpdateSchema } from '../schemas';

const tag = 'Profile';
const COLUMNS = 'id,display_name,timezone,created_at,updated_at';

export const profileRouter = createRouter()
  .openapi(
    createRoute({
      method: 'get',
      path: '/profile',
      ...meta(tag, "Get the caller's profile (created on first access)"),
      responses: okResponses(profileSchema),
    }),
    async (c) => {
      const db = c.get('db');
      const userId = c.get('userId');
      const existing = await db.from('profiles').select(COLUMNS).eq('id', userId).maybeSingle();
      if (existing.data) return ok(c, existing.data);
      const created = await db
        .from('profiles')
        .upsert(
          { id: userId, timezone: c.get('deps').env.DEFAULT_TIMEZONE },
          { onConflict: 'id', ignoreDuplicates: true },
        )
        .select(COLUMNS)
        .maybeSingle();
      if (created.data) return ok(c, created.data);
      return ok(
        c,
        unwrap(await db.from('profiles').select(COLUMNS).eq('id', userId).maybeSingle(), 'Profile'),
      );
    },
  )
  .openapi(
    createRoute({
      method: 'patch',
      path: '/profile',
      ...meta(tag, "Update the caller's profile"),
      request: { body: jsonBody(profileUpdateSchema) },
      responses: okResponses(profileSchema),
    }),
    async (c) => {
      const body = c.req.valid('json');
      const userId = c.get('userId');
      const db = c.get('db');
      const updated = await db
        .from('profiles')
        .update(body)
        .eq('id', userId)
        .select(COLUMNS)
        .maybeSingle();
      if (updated.data) return ok(c, updated.data);
      const inserted = await db
        .from('profiles')
        .insert({ id: userId, timezone: c.get('deps').env.DEFAULT_TIMEZONE, ...body })
        .select(COLUMNS)
        .single();
      return ok(c, unwrap(inserted, 'Profile'));
    },
  );
