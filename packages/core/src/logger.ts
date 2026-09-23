export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * Keys whose values must never reach logs: credentials and private
 * coordinates. Matching is case-insensitive on the key name.
 */
const REDACT_KEYS = new Set(
  [
    'authorization',
    'cookie',
    'set-cookie',
    'apikey',
    'password',
    'token',
    'access_token',
    'refresh_token',
    'device_token',
    'setup_secret',
    'provision_secret',
    'secret',
    'secret_key',
    'signed_url',
    'signedurl',
    'image_url',
    'url',
    'database_url',
    'latitude',
    'longitude',
    'lat',
    'lon',
    'lng',
    'closest_latitude',
    'closest_longitude',
    'prev_latitude',
    'prev_longitude',
    'current_latitude',
    'current_longitude',
  ].map((k) => k.toLowerCase()),
);

export const REDACTED = '[redacted]';

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(redact({ ...value }, depth + 1) as object),
    };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    // Defensive scrub of bearer tokens and Supabase keys embedded in messages.
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`)
      .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, REDACTED);
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => process.stdout.write(`${line}\n`);

/** Structured JSON-lines logger with mandatory redaction. */
export function createLogger(
  options: {
    level?: LogLevel;
    service?: string;
    sink?: LogSink;
    base?: Record<string, unknown>;
  } = {},
): Logger {
  const threshold = LEVELS[options.level ?? 'info'];
  const sink = options.sink ?? defaultSink;
  const base = { ...(options.service ? { service: options.service } : {}), ...options.base };

  const emit = (
    level: Exclude<LogLevel, 'silent'>,
    msg: string,
    fields?: Record<string, unknown>,
  ) => {
    if (LEVELS[level] < threshold) return;
    const record = redact({ ts: new Date().toISOString(), level, msg, ...base, ...fields });
    sink(JSON.stringify(record));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...options, base: { ...options.base, ...fields }, sink }),
  };
}

export const silentLogger: Logger = createLogger({ level: 'silent' });
