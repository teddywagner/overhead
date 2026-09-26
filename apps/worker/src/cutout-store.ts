import { BUCKETS, CUTOUT_MAX_ATTEMPTS } from '@overhead/core';
import type { Sql, TypedSupabaseClient } from '@overhead/database';
import { CutoutError, type ImageData } from './background-removers';

/** A queued cutout and the photo it is of. */
export interface CutoutJob {
  id: string;
  ownerId: string;
  sourceImageId: string;
  attempts: number;
  sourceProvider: string;
  licenseName: string | null;
  /** The owner's uploaded file, when the photo is not a linked pick. */
  storagePath: string | null;
  originalFileUrl: string | null;
}

export interface CutoutStore {
  /** Take up to `limit` cutouts to make, marking them processing. */
  claim(limit: number): Promise<CutoutJob[]>;
  downloadSource(path: string): Promise<ImageData>;
  upload(path: string, png: Uint8Array): Promise<void>;
  complete(job: CutoutJob, path: string, provider: string): Promise<void>;
  /** Record a failure; retryable ones are tried again later, up to the attempt limit. */
  fail(job: CutoutJob, message: string, retryable: boolean): Promise<void>;
  /** Put a claimed job back untouched (its attempt is not counted). */
  release(job: CutoutJob): Promise<void>;
}

type Row = Record<string, unknown>;
const strOrNull = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** Cutouts whose worker died mid-way are failed (and so retried) after this long. */
const STALE_MINUTES = 15;

export class PostgresCutoutStore implements CutoutStore {
  constructor(
    private readonly sql: Sql,
    /** Secret-key client: reads and writes any owner's objects. */
    private readonly storage: TypedSupabaseClient,
  ) {}

  async claim(limit: number): Promise<CutoutJob[]> {
    await this.sql`
      update public.image_cutouts
         set status = 'failed', error = 'Timed out while processing'
       where status = 'processing'
         and updated_at < now() - make_interval(mins => ${STALE_MINUTES})`;
    // Failed attempts back off: 2 minutes after the first, 4 after the second...
    const rows = (await this.sql`
      with next as (
        select id from public.image_cutouts
         where status = 'pending'
            or (status = 'failed' and attempts < ${CUTOUT_MAX_ATTEMPTS}
                and updated_at < now() - make_interval(mins => attempts * 2))
         order by requested_at
         limit ${limit}
           for update skip locked
      )
      update public.image_cutouts c
         set status = 'processing', attempts = c.attempts + 1, error = null
        from next, public.source_images s
       where c.id = next.id and s.id = c.source_image_id
      returning c.id, c.owner_id, c.source_image_id, c.attempts, s.source_provider,
                s.license_name, s.storage_path, s.original_file_url`) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      ownerId: String(r.owner_id),
      sourceImageId: String(r.source_image_id),
      attempts: Number(r.attempts),
      sourceProvider: String(r.source_provider),
      licenseName: strOrNull(r.license_name),
      storagePath: strOrNull(r.storage_path),
      originalFileUrl: strOrNull(r.original_file_url),
    }));
  }

  async downloadSource(path: string): Promise<ImageData> {
    const { data, error } = await this.storage.storage.from(BUCKETS.sourceImages).download(path);
    if (error || !data) {
      throw new CutoutError('fetch_failed', 'Could not read the uploaded photo', true);
    }
    return { bytes: new Uint8Array(await data.arrayBuffer()), contentType: data.type };
  }

  async upload(path: string, png: Uint8Array): Promise<void> {
    const { error } = await this.storage.storage
      .from(BUCKETS.sourceImages)
      .upload(path, png, { contentType: 'image/png', upsert: true });
    if (error) throw new CutoutError('storage_failed', 'Could not store the cutout', true);
  }

  async complete(job: CutoutJob, path: string, provider: string): Promise<void> {
    await this.sql`
      update public.image_cutouts
         set status = 'done', storage_path = ${path}, provider = ${provider}, error = null,
             processed_at = now()
       where id = ${job.id}`;
  }

  async release(job: CutoutJob): Promise<void> {
    await this.sql`
      update public.image_cutouts
         set status = 'pending', attempts = greatest(attempts - 1, 0)
       where id = ${job.id} and status = 'processing'`;
  }

  async fail(job: CutoutJob, message: string, retryable: boolean): Promise<void> {
    await this.sql`
      update public.image_cutouts
         set status = 'failed', error = ${message.slice(0, 500)},
             attempts = case when ${retryable} then attempts else greatest(attempts, ${CUTOUT_MAX_ATTEMPTS}) end
       where id = ${job.id}`;
  }
}
