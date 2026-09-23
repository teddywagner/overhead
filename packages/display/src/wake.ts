/** Seconds since local midnight of an instant in an IANA time zone. */
function localSecondOfDay(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 3600 + get('minute') * 60 + get('second');
}

export interface QuietHours {
  quiet_start_hour: number | null;
  quiet_end_hour: number | null;
}

/** Whether an instant falls inside the quiet hours (which may wrap midnight). */
export function inQuietHours(instant: Date, timeZone: string, quiet: QuietHours): boolean {
  const { quiet_start_hour: start, quiet_end_hour: end } = quiet;
  if (start === null || end === null || start === end) return false;
  const t = localSecondOfDay(instant, timeZone);
  const s = start * 3600;
  const e = end * 3600;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/**
 * How long a frame should sleep: its poll interval, extended so that it
 * never wakes during quiet hours. A wake that would land inside them is
 * pushed to the end of the quiet period. (Around a DST change the wake can
 * be an hour off, which is harmless.)
 */
export function sleepSecondsWithQuietHours(
  now: Date,
  baseSeconds: number,
  timeZone: string | null,
  quiet: QuietHours,
): number {
  if (!timeZone || quiet.quiet_end_hour === null) return baseSeconds;
  const wake = new Date(now.getTime() + baseSeconds * 1000);
  if (!inQuietHours(wake, timeZone, quiet)) return baseSeconds;
  const untilEnd =
    (quiet.quiet_end_hour * 3600 - localSecondOfDay(wake, timeZone) + 86_400) % 86_400;
  return baseSeconds + untilEnd;
}

/** The next `count` scheduled (timer) wakes, for previewing a frame's cadence. */
export function wakeSchedule(
  from: Date,
  baseSeconds: number,
  timeZone: string | null,
  quiet: QuietHours,
  count: number,
): string[] {
  const wakes: string[] = [];
  let t = from;
  for (let i = 0; i < count; i++) {
    t = new Date(t.getTime() + sleepSecondsWithQuietHours(t, baseSeconds, timeZone, quiet) * 1000);
    wakes.push(t.toISOString());
  }
  return wakes;
}
