import { describe, expect, test } from 'bun:test';
import { silentLogger } from '@overhead/core';
import {
  CutoutError,
  RembgRemover,
  RemoveBgRemover,
  type BackgroundRemover,
  type ImageData,
} from '../src/background-removers';
import type { CutoutJob, CutoutStore } from '../src/cutout-store';
import { CutoutWorker, fetchPhoto, photoUrls } from '../src/cutouts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
const COMMONS = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/N76502_B738.jpg';

const job = (over: Partial<CutoutJob> = {}): CutoutJob => ({
  id: crypto.randomUUID(),
  ownerId: OWNER,
  sourceImageId: '22222222-2222-4222-8222-222222222222',
  attempts: 1,
  sourceProvider: 'wikimedia_commons',
  licenseName: 'CC BY-SA 4.0',
  storagePath: null,
  originalFileUrl: COMMONS,
  ...over,
});

class FakeStore implements CutoutStore {
  queue: CutoutJob[] = [];
  uploads = new Map<string, Uint8Array>();
  done: Array<{ id: string; path: string; provider: string }> = [];
  failed: Array<{ id: string; message: string; retryable: boolean }> = [];
  released: string[] = [];
  sources = new Map<string, ImageData>();

  async claim(limit: number) {
    return this.queue.splice(0, limit);
  }
  async downloadSource(path: string) {
    const s = this.sources.get(path);
    if (!s) throw new CutoutError('fetch_failed', 'missing', true);
    return s;
  }
  async upload(path: string, png: Uint8Array) {
    this.uploads.set(path, png);
  }
  async complete(j: CutoutJob, path: string, provider: string) {
    this.done.push({ id: j.id, path, provider });
  }
  async fail(j: CutoutJob, message: string, retryable: boolean) {
    this.failed.push({ id: j.id, message, retryable });
  }
  async release(j: CutoutJob) {
    this.released.push(j.id);
  }
}

type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
/** Test fetches take the URL as a string. */
const fake =
  (impl: (url: string, init?: RequestInit) => Promise<Response>): Fetch =>
  (url, init) =>
    impl(String(url), init);

const image = (bytes = JPEG, type = 'image/jpeg') =>
  new Response(bytes, { headers: { 'content-type': type } });

function setup(remover: Partial<BackgroundRemover> = {}, fetchImpl?: Fetch) {
  const store = new FakeStore();
  const seen: ImageData[] = [];
  const worker = new CutoutWorker({
    remover: {
      name: 'rembg',
      remove: async (img) => {
        seen.push(img);
        return PNG;
      },
      ...remover,
    },
    store,
    logger: silentLogger,
    intervalS: 30,
    batchSize: 3,
    userAgent: 'overhead-test/0.1 (+https://example.test)',
    fetch: fetchImpl ?? fake(async () => image()),
  });
  return { store, worker, seen };
}

describe('cutouts', () => {
  test('a Commons photo is downloaded, cut out and stored under the owner', async () => {
    const urls: string[] = [];
    const { store, worker, seen } = setup(
      {},
      fake(async (url: string) => {
        urls.push(url);
        return image();
      }),
    );
    const j = job();
    store.queue.push(j);
    expect(await worker.runOnce()).toEqual({ done: 1, failed: 0, paused: false });
    // The 2048 px rendering is enough and keeps the PNG small.
    expect(urls).toEqual([
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/N76502_B738.jpg/2048px-N76502_B738.jpg',
    ]);
    expect(seen[0]).toEqual({ bytes: JPEG, contentType: 'image/jpeg' });
    const path = `${OWNER}/cutout/${j.sourceImageId}.png`;
    expect(store.uploads.get(path)).toEqual(PNG);
    expect(store.done).toEqual([{ id: j.id, path, provider: 'rembg' }]);
  });

  test('falls back to the Commons original when it is narrower than the thumbnail', async () => {
    const urls: string[] = [];
    const { store, worker } = setup(
      {},
      fake(async (url: string) => {
        urls.push(url);
        return url.includes('/thumb/') ? new Response('too big', { status: 400 }) : image();
      }),
    );
    store.queue.push(job());
    await worker.runOnce();
    expect(urls).toEqual([photoUrls(COMMONS)[0]!, COMMONS]);
    expect(store.done).toHaveLength(1);
  });

  test('the owner’s own upload is read from Storage', async () => {
    const { store, worker, seen } = setup();
    const path = `${OWNER}/source/x.png`;
    store.sources.set(path, { bytes: PNG, contentType: 'image/png' });
    store.queue.push(job({ sourceProvider: 'upload', licenseName: null, storagePath: path }));
    await worker.runOnce();
    expect(seen[0]!.contentType).toBe('image/png');
    expect(store.done).toHaveLength(1);
  });

  test('licences are re-checked: linked-only photos fail for good', async () => {
    const { store, worker, seen } = setup();
    const j = job({ sourceProvider: 'planespotters', licenseName: null });
    store.queue.push(j);
    expect((await worker.runOnce()).failed).toBe(1);
    expect(seen).toHaveLength(0);
    expect(store.failed).toEqual([
      { id: j.id, message: expect.stringMatching(/Planespotters/), retryable: false },
    ]);
  });

  test('non-images and oversized photos are not retried; remover outages are', async () => {
    const notImage = setup(
      {},
      async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    );
    notImage.store.queue.push(job());
    await notImage.worker.runOnce();
    expect(notImage.store.failed[0]).toMatchObject({ retryable: false });

    const huge = setup(
      {},
      async () =>
        new Response(JPEG, {
          headers: { 'content-type': 'image/jpeg', 'content-length': String(30 * 1024 * 1024) },
        }),
    );
    huge.store.queue.push(job());
    await huge.worker.runOnce();
    expect(huge.store.failed[0]).toMatchObject({
      retryable: false,
      message: expect.stringMatching(/20 MB/),
    });

    const down = setup({
      remove: async () => {
        throw new CutoutError('remover_failed', 'rembg returned 502', true);
      },
    });
    down.store.queue.push(job());
    await down.worker.runOnce();
    expect(down.store.failed[0]).toMatchObject({ retryable: true });
  });

  test('a rate limit pauses the loop and hands the rest of the batch back', async () => {
    let now = 0;
    const store = new FakeStore();
    const worker = new CutoutWorker({
      remover: {
        name: 'remove_bg',
        remove: async () => {
          throw new CutoutError('rate_limited', 'remove.bg rate limit', true, 60_000);
        },
      },
      store,
      logger: silentLogger,
      intervalS: 30,
      batchSize: 3,
      userAgent: 'x',
      fetch: fake(async () => image()),
      pauseMs: 1000,
      clock: () => new Date(now),
    });
    const [a, b, c] = [job(), job(), job()];
    store.queue.push(a, b, c);
    expect((await worker.runOnce()).paused).toBe(true);
    expect(store.failed.map((f) => f.id)).toEqual([a.id]);
    expect(store.released).toEqual([b.id, c.id]);
    store.queue.push(b);
    expect(await worker.runOnce()).toEqual({ done: 0, failed: 0, paused: true });
    now = 61_000;
    expect((await worker.runOnce()).paused).toBe(true); // still limited: b fails again
  });
});

describe('photo downloads', () => {
  test('only Commons originals get a thumbnail URL', () => {
    expect(photoUrls('https://example.test/a.jpg')).toEqual(['https://example.test/a.jpg']);
    expect(photoUrls('https://upload.wikimedia.org/wikipedia/commons/1/1a/Scan.tif')[0]).toMatch(
      /2048px-Scan\.tif\.png$/,
    );
  });

  test('sends a User-Agent', async () => {
    let ua = null as string | null;
    await fetchPhoto('https://example.test/a.jpg', {
      userAgent: 'overhead-test',
      fetch: fake(async (_url: string, init?: RequestInit) => {
        ua = new Headers(init?.headers).get('user-agent');
        return image();
      }),
    });
    expect(ua).toBe('overhead-test');
  });
});

describe('background removers', () => {
  test('rembg gets the photo and model as a multipart upload', async () => {
    let sent = null as { url: string; form: FormData } | null;
    const remover = new RembgRemover({
      baseUrl: 'http://rembg:7000',
      model: 'isnet-general-use',
      fetch: fake(async (url: string, init?: RequestInit) => {
        sent = { url, form: init!.body as FormData };
        return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      }),
    });
    expect(await remover.remove({ bytes: JPEG, contentType: 'image/jpeg' })).toEqual(PNG);
    expect(sent!.url).toBe('http://rembg:7000/api/remove');
    expect(sent!.form.get('model')).toBe('isnet-general-use');
    expect((sent!.form.get('file') as File).name).toBe('photo.jpg');
  });

  test('remove.bg gets the API key; errors say whether to retry', async () => {
    let key = null as string | null;
    const respond = { status: 200, body: PNG as string | Uint8Array, retryAfter: '' };
    const remover = new RemoveBgRemover({
      apiKey: 'secret',
      fetch: fake(async (_url: string, init?: RequestInit) => {
        key = new Headers(init?.headers).get('x-api-key');
        return new Response(respond.body, {
          status: respond.status,
          headers: respond.retryAfter ? { 'retry-after': respond.retryAfter } : {},
        });
      }),
    });
    expect(await remover.remove({ bytes: JPEG, contentType: 'image/jpeg' })).toEqual(PNG);
    expect(key).toBe('secret');

    Object.assign(respond, { status: 429, body: '{}', retryAfter: '30' });
    await expect(remover.remove({ bytes: JPEG, contentType: 'image/jpeg' })).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
      retryAfterMs: 30_000,
    });
    Object.assign(respond, { status: 400, body: '{}', retryAfter: '' });
    await expect(remover.remove({ bytes: JPEG, contentType: 'image/jpeg' })).rejects.toMatchObject({
      code: 'remover_failed',
      retryable: false,
    });
    Object.assign(respond, { status: 200, body: 'not a png' });
    await expect(remover.remove({ bytes: JPEG, contentType: 'image/jpeg' })).rejects.toMatchObject({
      code: 'bad_output',
    });
  });
});
