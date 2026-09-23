/**
 * Storage buckets are fixed server-side; clients never choose a bucket name.
 * Every object lives under `<owner_id>/<kind>/<uuid>-<safe-name>`.
 */
export const BUCKETS = {
  sourceImages: 'source-images',
  aircraftArt: 'aircraft-art',
  posterPreviews: 'poster-previews',
  deviceBinaries: 'device-binaries',
} as const;

export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

export const IMAGE_CONTENT_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const;

export type ImageContentType = keyof typeof IMAGE_CONTENT_TYPES;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reduce a client-supplied filename to a safe slug without extension. */
export function sanitizeFilename(name: string, maxLength = 60): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\.[^.]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return base.length > 0 ? base : 'file';
}

export function buildObjectPath(
  ownerId: string,
  kind: string,
  filename: string,
  extension: string,
): string {
  if (!UUID_RE.test(ownerId)) throw new Error('ownerId must be a uuid');
  if (!/^[a-z0-9-]{1,40}$/.test(kind)) throw new Error('invalid object kind');
  if (!/^[a-z0-9]{1,5}$/.test(extension)) throw new Error('invalid extension');
  return `${ownerId}/${kind}/${crypto.randomUUID()}-${sanitizeFilename(filename)}.${extension}`;
}

/**
 * Validate a client-provided object path: must be owner-prefixed, contain
 * only safe characters and no traversal segments.
 */
export function isOwnedObjectPath(path: string, ownerId: string): boolean {
  if (path.length > 300) return false;
  if (!/^[0-9a-f-]{36}(\/[a-z0-9][a-z0-9._-]{0,120})+$/.test(path)) return false;
  if (path.split('/').some((seg) => seg === '.' || seg === '..' || seg.includes('..')))
    return false;
  return path.startsWith(`${ownerId}/`);
}
