/**
 * Calendar date (YYYY-MM-DD) of an instant in an IANA time zone. Used to
 * assign overflights and posters to the location's local day.
 */
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const toIso = (d: Date) => d.toISOString();

export const secondsBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 1000;
