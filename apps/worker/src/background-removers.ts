/**
 * Background removers: take a photo, return a PNG with everything but the
 * subject (the aircraft) transparent.
 *
 * - `rembg`: a self-hosted rembg server (`rembg s`, e.g. the
 *   danielgatis/rembg image). Free; runs the model on your own machine.
 * - `remove_bg`: the remove.bg API. Paid per image; no server to run.
 */

export interface ImageData {
  bytes: Uint8Array;
  contentType: string;
}

export interface BackgroundRemover {
  readonly name: 'rembg' | 'remove_bg';
  remove(image: ImageData): Promise<Uint8Array>;
}

/** A cutout step failed; `retryable` says whether trying again may help. */
export class CutoutError extends Error {
  constructor(
    readonly code:
      | 'fetch_failed'
      | 'not_an_image'
      | 'too_large'
      | 'remover_failed'
      | 'rate_limited'
      | 'bad_output'
      | 'storage_failed'
      | 'not_allowed',
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const isPng = (bytes: Uint8Array) => PNG_SIGNATURE.every((b, i) => bytes[i] === b);

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function extensionFor(contentType: string): string {
  return contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
}

async function send(
  doFetch: Fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new CutoutError(
      'remover_failed',
      `${label} unreachable: ${err instanceof Error ? err.name : 'error'}`,
      true,
    );
  }
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after'));
    throw new CutoutError(
      'rate_limited',
      `${label} rate limit`,
      true,
      Number.isFinite(after) && after > 0 ? after * 1000 : null,
    );
  }
  if (!res.ok) {
    // 4xx other than 429 means this image (or our request) will not work.
    throw new CutoutError('remover_failed', `${label} returned ${res.status}`, res.status >= 500);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!isPng(bytes)) throw new CutoutError('bad_output', `${label} did not return a PNG`, true);
  return bytes;
}

export class RembgRemover implements BackgroundRemover {
  readonly name = 'rembg' as const;
  constructor(
    private readonly options: {
      baseUrl: string;
      /** e.g. isnet-general-use (Apache-2.0) or birefnet-general (MIT, slower, sharper). */
      model: string;
      fetch?: Fetch;
      timeoutMs?: number;
    },
  ) {}

  remove(image: ImageData): Promise<Uint8Array> {
    const form = new FormData();
    form.set(
      'file',
      new Blob([image.bytes], { type: image.contentType }),
      `photo.${extensionFor(image.contentType)}`,
    );
    form.set('model', this.options.model);
    const url = new URL('/api/remove', this.options.baseUrl).toString();
    return send(
      this.options.fetch ?? fetch,
      url,
      { method: 'POST', body: form },
      this.options.timeoutMs ?? 120_000,
      'rembg',
    );
  }
}

export class RemoveBgRemover implements BackgroundRemover {
  readonly name = 'remove_bg' as const;
  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl?: string;
      fetch?: Fetch;
      timeoutMs?: number;
    },
  ) {}

  remove(image: ImageData): Promise<Uint8Array> {
    const form = new FormData();
    form.set(
      'image_file',
      new Blob([image.bytes], { type: image.contentType }),
      `photo.${extensionFor(image.contentType)}`,
    );
    form.set('size', 'auto');
    form.set('format', 'png');
    // Trim the transparent margin so the aircraft fills the image.
    form.set('crop', 'true');
    const url = new URL('/v1.0/removebg', this.options.baseUrl ?? 'https://api.remove.bg');
    return send(
      this.options.fetch ?? fetch,
      url.toString(),
      { method: 'POST', body: form, headers: { 'X-Api-Key': this.options.apiKey } },
      this.options.timeoutMs ?? 120_000,
      'remove.bg',
    );
  }
}
