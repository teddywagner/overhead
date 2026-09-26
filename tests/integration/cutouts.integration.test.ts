/**
 * Cutouts against local Supabase: an admin queues a background-removed copy
 * of a photo, the worker's store claims it, stores the PNG in the owner's
 * Storage folder and marks it done, and the admin board gets a signed link.
 * Failures back off; licences that forbid edited copies are refused.
 *
 * With CUTOUT_REMBG_URL set (e.g. `docker run -p 7000:7000 danielgatis/rembg
 * s`), one test also runs a real rembg server.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { CUTOUT_MAX_ATTEMPTS, silentLogger } from '@overhead/core';
import { createAdminClient, createUserClient, type Sql } from '@overhead/database';
import {
  CutoutError,
  RembgRemover,
  isPng,
  type BackgroundRemover,
} from '../../apps/worker/src/background-removers';
import { PostgresCutoutStore } from '../../apps/worker/src/cutout-store';
import { CutoutWorker } from '../../apps/worker/src/cutouts';
import {
  ENV,
  call,
  createTestUser,
  deleteTestUser,
  makeApp,
  skipIntegration,
  sqlFor,
  type TestUser,
} from './harness';

/** An RGB PNG: a white fuselage-and-wings shape on a blue sky. */
function planePng(w = 160, h = 100): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) {
      const body = Math.abs(y - h / 2) < h * 0.06 && x > w * 0.1 && x < w * 0.9;
      const wing = Math.abs(x - w / 2) < w * 0.06 && Math.abs(y - h / 2) < h * 0.35;
      const [r, g, b] = body || wing ? [245, 245, 248] : [74, 134, 200];
      raw.set([r!, g!, b!], y * (1 + w * 3) + 1 + x * 3);
    }
  }
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const CUTOUT_PNG = planePng(8, 6);

describe.skipIf(skipIntegration)('cutouts', () => {
  const env = ENV!;
  let sql: Sql;
  let admin: TestUser;
  let owner: TestUser;
  let app: ReturnType<typeof makeApp>['app'];
  let deps: ReturnType<typeof makeApp>['deps'];
  const storage = () => createAdminClient(env).storage.from('source-images');
  let uploadId: string;
  let spottedId: string;

  const worker = (remover: BackgroundRemover) =>
    new CutoutWorker({
      remover,
      store: new PostgresCutoutStore(sql, createAdminClient(env)),
      logger: silentLogger,
      intervalS: 30,
      batchSize: 5,
      userAgent: 'overhead-test',
    });
  const stub = (run: () => Promise<Uint8Array>): BackgroundRemover => ({
    name: 'rembg',
    remove: run,
  });
  const cutoutRow = async (id: string) =>
    (
      (await sql`select status, attempts, storage_path, error from public.image_cutouts
                  where source_image_id = ${id}`) as Array<{
        status: string;
        attempts: number;
        storage_path: string | null;
        error: string | null;
      }>
    )[0];
  const listed = async () =>
    (
      await call<{
        items: Array<{
          id: string;
          cutout: { status: string; image_url: string | null } | null;
          cutout_refusal: string | null;
        }>;
      }>(app, 'GET', `/admin/v1/source-images?owner_id=${owner.id}`, admin)
    ).body.data.items;

  beforeAll(async () => {
    ({ app, deps } = makeApp(env));
    sql = sqlFor(env);
    admin = await createTestUser(env, 'cutout-admin');
    owner = await createTestUser(env, 'cutout-owner');
    await sql`insert into private.admins (user_id) values (${admin.id})`;
    const path = `${owner.id}/source/plane.png`;
    const up = await storage().upload(path, planePng(), { contentType: 'image/png' });
    if (up.error) throw up.error;
    const [upload] = (await sql`
      insert into public.source_images (owner_id, source_provider, storage_path, license_name)
      values (${owner.id}, 'upload', ${path}, 'Own photo') returning id`) as Array<{
      id: string;
    }>;
    const [spotted] = (await sql`
      insert into public.source_images (owner_id, source_provider, original_file_url, raw_metadata)
      values (${owner.id}, 'planespotters', 'https://t.plnspttrs.net/1_280.jpg',
              '{"kind":"photo_pick"}'::jsonb) returning id`) as Array<{ id: string }>;
    uploadId = upload!.id;
    spottedId = spotted!.id;
  });

  afterAll(async () => {
    await storage().remove([`${owner.id}/source/plane.png`, `${owner.id}/cutout/${uploadId}.png`]);
    await deleteTestUser(env, admin);
    await deleteTestUser(env, owner);
    await sql.close();
    await deps.close();
  });

  test('linked-only photos are refused; the owner’s upload is queued', async () => {
    const refused = await call(app, 'POST', `/admin/v1/source-images/${spottedId}/cutout`, admin);
    expect(refused.status).toBe(400);
    expect((await listed()).find((i) => i.id === spottedId)!.cutout_refusal).toMatch(
      /Planespotters/,
    );

    const queued = await call<{ cutout: { status: string } }>(
      app,
      'POST',
      `/admin/v1/source-images/${uploadId}/cutout`,
      admin,
    );
    expect(queued.status).toBe(200);
    expect(queued.body.data.cutout.status).toBe('pending');
    // Owners cannot queue their own (admin board only).
    const own = await call(app, 'POST', `/admin/v1/source-images/${uploadId}/cutout`, owner);
    expect(own.status).toBe(403);
  });

  test('a retryable failure backs off; a permanent one stops', async () => {
    const flaky = worker(
      stub(async () => {
        throw new CutoutError('remover_failed', 'rembg returned 502', true);
      }),
    );
    expect((await flaky.runOnce()).failed).toBe(1);
    expect(await cutoutRow(uploadId)).toMatchObject({ status: 'failed', attempts: 1 });
    // Backing off: nothing to claim straight away.
    expect(await flaky.runOnce()).toEqual({ done: 0, failed: 0, paused: false });

    await sql`update public.image_cutouts set status = 'pending' where source_image_id = ${uploadId}`;
    const broken = worker(
      stub(async () => {
        throw new CutoutError('not_an_image', 'nope', false);
      }),
    );
    await broken.runOnce();
    expect(await cutoutRow(uploadId)).toMatchObject({
      status: 'failed',
      attempts: CUTOUT_MAX_ATTEMPTS,
    });
  });

  test('re-requesting resets it; the worker stores the PNG and the board links it', async () => {
    await call(app, 'POST', `/admin/v1/source-images/${uploadId}/cutout`, admin);
    expect(await cutoutRow(uploadId)).toMatchObject({ status: 'pending', attempts: 0 });

    const seen: string[] = [];
    const ok = worker({
      name: 'rembg',
      remove: async (img) => {
        seen.push(img.contentType);
        return CUTOUT_PNG;
      },
    });
    expect((await ok.runOnce()).done).toBe(1);
    expect(seen).toEqual(['image/png']);
    const row = await cutoutRow(uploadId);
    expect(row).toMatchObject({
      status: 'done',
      storage_path: `${owner.id}/cutout/${uploadId}.png`,
      error: null,
    });

    const item = (await listed()).find((i) => i.id === uploadId)!;
    expect(item.cutout!.status).toBe('done');
    const res = await fetch(item.cutout!.image_url!);
    expect(res.ok).toBe(true);
    expect(isPng(new Uint8Array(await res.arrayBuffer()))).toBe(true);
  });

  test('owners can read their own cutout rows, and no one else’s', async () => {
    const mine = createUserClient(env, owner.token);
    const theirs = createUserClient(env, admin.token);
    const a = await mine.from('image_cutouts').select('status').eq('source_image_id', uploadId);
    const b = await theirs.from('image_cutouts').select('status').eq('source_image_id', uploadId);
    expect(a.data).toEqual([{ status: 'done' }]);
    expect(b.data).toEqual([]);
    // Nobody writes them directly.
    const w = await mine
      .from('image_cutouts')
      .update({ status: 'pending' })
      .eq('source_image_id', uploadId);
    expect(w.error).not.toBeNull();
  });

  test.skipIf(!process.env.CUTOUT_REMBG_URL)(
    'a real rembg server makes a transparent PNG',
    async () => {
      await call(app, 'POST', `/admin/v1/source-images/${uploadId}/cutout`, admin);
      const real = worker(
        new RembgRemover({ baseUrl: process.env.CUTOUT_REMBG_URL!, model: 'isnet-general-use' }),
      );
      expect(await real.runOnce()).toMatchObject({ done: 1, failed: 0 });
      const { data } = await storage().download(`${owner.id}/cutout/${uploadId}.png`);
      const bytes = new Uint8Array(await data!.arrayBuffer());
      expect(isPng(bytes)).toBe(true);
      // Colour type 6: RGBA, i.e. it has an alpha channel.
      expect(bytes[25]).toBe(6);
    },
  );
});
