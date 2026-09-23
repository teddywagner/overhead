import {
  AppError,
  IMAGE_CONTENT_TYPES,
  buildObjectPath,
  isOwnedObjectPath,
  type BucketName,
  type ImageContentType,
} from '@overhead/core';
import type { TypedSupabaseClient } from '@overhead/database';

/** Signed upload URLs from Supabase Storage are valid for two hours. */
export const SIGNED_UPLOAD_TTL_SECONDS = 7200;

/** Object-name prefixes (after the owner id) per logical kind. */
export const OBJECT_KINDS = {
  source: 'source',
  art: 'art',
  preview: 'preview',
  binary: 'bin',
} as const;

export async function createSignedUpload(
  db: TypedSupabaseClient,
  bucket: BucketName,
  path: string,
) {
  // Uses the caller's token: Storage RLS requires the owner-id prefix.
  const { data, error } = await db.storage.from(bucket).createSignedUploadUrl(path);
  if (error || !data) throw new AppError('internal_error', 'Could not create upload URL');
  return {
    bucket,
    path: data.path,
    signed_url: data.signedUrl,
    token: data.token,
    expires_in_seconds: SIGNED_UPLOAD_TTL_SECONDS,
  };
}

export function imageObjectPath(
  ownerId: string,
  kind: (typeof OBJECT_KINDS)[keyof typeof OBJECT_KINDS],
  filename: string,
  contentType: ImageContentType,
) {
  return buildObjectPath(ownerId, kind, filename, IMAGE_CONTENT_TYPES[contentType]);
}

/** Validate a client-supplied object path for this owner and kind. */
export function assertOwnedPath(
  path: string | null | undefined,
  ownerId: string,
  kind: (typeof OBJECT_KINDS)[keyof typeof OBJECT_KINDS],
  field: string,
): void {
  if (path === null || path === undefined) return;
  if (!isOwnedObjectPath(path, ownerId) || !path.startsWith(`${ownerId}/${kind}/`)) {
    throw new AppError(
      'validation_failed',
      `${field} must be a path returned by the matching upload-url endpoint`,
    );
  }
}

export async function objectExists(
  db: TypedSupabaseClient,
  bucket: BucketName,
  path: string,
): Promise<boolean> {
  const { data, error } = await db.storage.from(bucket).exists(path);
  if (error) {
    // exists() reports a missing object as an error on some Storage versions.
    return false;
  }
  return data === true;
}
