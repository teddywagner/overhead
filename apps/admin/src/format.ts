/** Formatting helpers. Times are shown in the frame's location time zone. */

export function fmtTime(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timeZone ?? undefined,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function fmtDuration(seconds: number): string {
  const s = Math.round(Math.abs(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 48) return rest ? `${h} h ${rest} min` : `${h} h`;
  return `${Math.round(h / 24)} d`;
}

export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = (now - Date.parse(iso)) / 1000;
  return s < 0 ? `in ${fmtDuration(s)}` : `${fmtDuration(s)} ago`;
}

export const fmtNum = (n: number | null | undefined, unit = '') =>
  n === null || n === undefined ? '—' : `${Math.round(n).toLocaleString()}${unit}`;

export const planeTitle = (p: {
  registration: string | null;
  callsign: string | null;
  icao_type_code: string | null;
}) => p.registration ?? p.callsign ?? p.icao_type_code ?? 'Unknown aircraft';

export const planeType = (p: {
  manufacturer: string | null;
  model: string | null;
  icao_type_code: string | null;
}) => [p.manufacturer, p.model].filter(Boolean).join(' ') || p.icao_type_code || 'Unknown type';

type RouteFields = {
  origin_code: string | null;
  destination_code: string | null;
  origin_name?: string | null;
  destination_name?: string | null;
};

/** "JFK → LAX", "? → LAX", or null when neither end is known. */
export const route = (p: RouteFields) =>
  p.origin_code || p.destination_code
    ? `${p.origin_code ?? '?'} → ${p.destination_code ?? '?'}`
    : null;

/** "New York JFK → Los Angeles" style names, when the route lookup found them. */
export const routeNames = (p: RouteFields) =>
  p.origin_name || p.destination_name
    ? `${p.origin_name ?? p.origin_code ?? 'Unknown'} → ${p.destination_name ?? p.destination_code ?? 'Unknown'}`
    : null;

export const SCOPE_LABEL: Record<string, string> = {
  registration: 'exact airframe',
  operator_livery: 'operator + type + livery',
  operator_type: 'operator + type',
  type: 'aircraft type',
  fallback: 'generic fallback',
};
