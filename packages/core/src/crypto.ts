/** Lowercase hex SHA-256 of a UTF-8 string or bytes. */
export function sha256Hex(input: string | Uint8Array | ArrayBuffer): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(input);
  return hasher.digest('hex');
}

function randomBytes(n: number): Buffer {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return Buffer.from(buf);
}

/** Cryptographically random bytes, lowercase hex encoded. */
export const randomHex = (bytes: number): string => randomBytes(bytes).toString('hex');

/** Cryptographically random bytes, base64url encoded without padding. */
export const randomBase64Url = (bytes: number): string => randomBytes(bytes).toString('base64url');

/** Constant-time comparison for equal-length digests. */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
