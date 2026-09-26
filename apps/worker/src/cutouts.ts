import { cutoutPath, cutoutRefusal, type Logger } from '@overhead/core';
import { CutoutError, type BackgroundRemover, type ImageData } from './background-removers';
import type { CutoutJob, CutoutStore } from './cutout-store';
import { safeMessage } from './poller';

/** The source-images bucket's limit; photos and cutouts must fit in it. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Wikimedia Commons originals can be tens of megapixels; a 2048 px wide
 * rendering is plenty for a cutout and keeps the PNG well under the limit.
 * Commons refuses thumbnails wider than the original, so fall back to it.
 */
export function photoUrls(url: string): string[] {
  const m =
    /^(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons)\/([0-9a-f]\/[0-9a-f]{2})\/([^/]+)$/.exec(
      url,
    );
  if (!m) return [url];
  const [, base, hash, name] = m;
  const thumbName = /\.(tiff?|svg)$/i.test(name!) ? `${name}.png` : name;
  return [`${base}/thumb/${hash}/${name}/2048px-${thumbName}`, url];
}

/** Download a linked photo (size- and type-checked). */
export async function fetchPhoto(
  url: string,
  options: { userAgent: string; fetch?: Fetch; timeoutMs?: number },
): Promise<ImageData> {
  const doFetch = options.fetch ?? fetch;
  let last: CutoutError | null = null;
  for (const candidate of photoUrls(url)) {
    let res: Response;
    try {
      res = await doFetch(candidate, {
        headers: { 'User-Agent': options.userAgent, Accept: IMAGE_TYPES.join(', ') },
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch {
      last = new CutoutError('fetch_failed', 'Could not download the photo', true);
      continue;
    }
    if (!res.ok) {
      last = new CutoutError(
        'fetch_failed',
        `Downloading the photo returned ${res.status}`,
        res.status === 429 || res.status >= 500,
      );
      continue;
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!IMAGE_TYPES.includes(contentType)) {
      throw new CutoutError('not_an_image', 'The photo is not a JPEG, PNG or WebP image', false);
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_IMAGE_BYTES) {
      throw new CutoutError('too_large', 'The photo is larger than 20 MB', false);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new CutoutError('too_large', 'The photo is larger than 20 MB', false);
    }
    return { bytes, contentType };
  }
  throw last ?? new CutoutError('fetch_failed', 'Could not download the photo', true);
}

export interface CutoutWorkerOptions {
  remover: BackgroundRemover;
  store: CutoutStore;
  logger: Logger;
  intervalS: number;
  /** Cutouts per round. They are slow (seconds each), so keep this small. */
  batchSize: number;
  userAgent: string;
  fetch?: Fetch;
  /** Pause after a rate limit. */
  pauseMs?: number;
  clock?: () => Date;
}

export interface CutoutRound {
  done: number;
  failed: number;
  paused: boolean;
}

/**
 * Makes requested cutouts: downloads each photo, has the background remover
 * isolate the aircraft, and stores the transparent PNG next to the owner's
 * other source images. Licences are re-checked here, not just when queued.
 */
export class CutoutWorker {
  private pausedUntil = 0;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(private readonly options: CutoutWorkerOptions) {}

  private now(): number {
    return (this.options.clock ?? (() => new Date()))().getTime();
  }

  private async make(job: CutoutJob): Promise<void> {
    const { remover, store } = this.options;
    const refusal = cutoutRefusal({
      source_provider: job.sourceProvider,
      license_name: job.licenseName,
      storage_path: job.storagePath,
    });
    if (refusal) throw new CutoutError('not_allowed', refusal, false);

    let photo: ImageData;
    if (job.storagePath) photo = await store.downloadSource(job.storagePath);
    else if (job.originalFileUrl) {
      photo = await fetchPhoto(job.originalFileUrl, {
        userAgent: this.options.userAgent,
        fetch: this.options.fetch,
      });
    } else throw new CutoutError('fetch_failed', 'The photo has no file or link', false);

    const png = await remover.remove(photo);
    if (png.byteLength > MAX_IMAGE_BYTES) {
      throw new CutoutError('too_large', 'The cutout is larger than 20 MB', false);
    }
    const path = cutoutPath(job.ownerId, job.sourceImageId);
    await store.upload(path, png);
    await store.complete(job, path, remover.name);
  }

  async runOnce(): Promise<CutoutRound> {
    const { store, logger, batchSize } = this.options;
    const round: CutoutRound = { done: 0, failed: 0, paused: false };
    if (this.now() < this.pausedUntil) return { ...round, paused: true };

    let jobs: CutoutJob[];
    try {
      jobs = await store.claim(batchSize);
    } catch (err) {
      logger.error('cutout round failed', { error: safeMessage(err) });
      return round;
    }
    for (const job of jobs) {
      if (this.stopped) {
        // Hand unstarted jobs back for the next run.
        await store.release(job).catch(() => undefined);
        continue;
      }
      try {
        await this.make(job);
        round.done++;
      } catch (err) {
        round.failed++;
        const known = err instanceof CutoutError;
        const message = known ? err.message : 'Unexpected error while making the cutout';
        await store.fail(job, message, known ? err.retryable : true).catch(() => undefined);
        logger.warn('cutout failed', {
          cutout_id: job.id,
          code: known ? err.code : 'processing_error',
          error: known ? err.message : safeMessage(err),
        });
        if (known && err.code === 'rate_limited') {
          this.pausedUntil =
            this.now() + Math.max(err.retryAfterMs ?? 0, this.options.pauseMs ?? 10 * 60_000);
          round.paused = true;
          for (const rest of jobs.slice(jobs.indexOf(job) + 1)) {
            await store.release(rest).catch(() => undefined);
          }
          break;
        }
      }
    }
    if (round.done || round.failed) logger.info('cutout round', { ...round });
    return round;
  }

  async start(): Promise<void> {
    const intervalMs = this.options.intervalS * 1000;
    while (!this.stopped) {
      await this.runOnce();
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }
}
