export const ERROR_STATUS = {
  bad_request: 400,
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_state: 409,
  storage_object_missing: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal_error: 500,
  not_ready: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** An error whose code and message are safe to return to API clients. */
export class AppError extends Error {
  readonly status: (typeof ERROR_STATUS)[ErrorCode];
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_STATUS[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('not_found', `${what} not found`);
