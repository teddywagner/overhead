/** Normalisation helpers shared by provider adapters. */

export function normalizeIcao24(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return /^~?[0-9a-f]{6}$/.test(s) ? s : null;
}

export function normalizeCallsign(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z0-9]{1,8}$/.test(s) ? s : null;
}

export function normalizeRegistration(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z0-9-]{1,12}$/.test(s) ? s : null;
}

export function normalizeTypeCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z0-9]{2,4}$/.test(s) ? s : null;
}

export function normalizeText(v: unknown, max = 160): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  return s.length > 0 ? s.slice(0, max) : null;
}

export function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function normalizeTrack(v: unknown): number | null {
  const n = finiteOrNull(v);
  if (n === null) return null;
  return n >= 0 && n < 360 ? n : ((n % 360) + 360) % 360;
}
