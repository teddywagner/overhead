/**
 * Fixed-window in-memory rate limiter. Adequate for a single API instance;
 * see docs/security.md for multi-instance deployment notes.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterS: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowS: number): RateLimitResult;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, limit: number, windowS: number): RateLimitResult {
    const now = this.now();
    const windowMs = windowS * 1000;
    this.sweep(now);
    let w = this.windows.get(key);
    if (!w || now - w.start >= windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    const allowed = w.count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - w.count),
      retryAfterS: allowed ? 0 : Math.max(1, Math.ceil((w.start + windowMs - now) / 1000)),
    };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, w] of this.windows) if (now - w.start > 3_600_000) this.windows.delete(k);
  }
}

/** Limits used across the API (requests per window seconds). */
export const LIMITS = {
  system: { limit: 120, windowS: 60 },
  user: { limit: 600, windowS: 60 },
  deviceSetupIp: { limit: 20, windowS: 600 },
  deviceSetupMac: { limit: 10, windowS: 600 },
  deviceDisplay: { limit: 30, windowS: 60 },
  deviceDisplayIp: { limit: 120, windowS: 60 },
  deviceLog: { limit: 10, windowS: 60 },
} as const;
