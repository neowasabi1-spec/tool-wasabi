/**
 * In-memory sliding-window rate limiter.
 * Per SOC 2 Availability & Security: prevents abuse and DoS.
 *
 * In production, swap the Map store with Redis for multi-instance support.
 */

interface RateLimitEntry {
  timestamps: number[];
}

interface RateLimiterConfig {
  windowMs: number;
  maxRequests: number;
}

const stores = new Map<string, Map<string, RateLimitEntry>>();

function getStore(name: string): Map<string, RateLimitEntry> {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name)!;
}

export function createRateLimiter(name: string, config: RateLimiterConfig) {
  const store = getStore(name);

  return {
    check(identifier: string): { allowed: boolean; retryAfterMs: number; remaining: number } {
      const now = Date.now();
      const windowStart = now - config.windowMs;

      let entry = store.get(identifier);
      if (!entry) {
        entry = { timestamps: [] };
        store.set(identifier, entry);
      }

      entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

      if (entry.timestamps.length >= config.maxRequests) {
        const oldestInWindow = entry.timestamps[0];
        const retryAfterMs = oldestInWindow + config.windowMs - now;
        return { allowed: false, retryAfterMs, remaining: 0 };
      }

      entry.timestamps.push(now);
      return {
        allowed: true,
        retryAfterMs: 0,
        remaining: config.maxRequests - entry.timestamps.length,
      };
    },

    reset(identifier: string) {
      store.delete(identifier);
    },
  };
}

// Pre-configured limiters for different tiers
export const apiLimiter = createRateLimiter('api-general', {
  windowMs: 60_000,
  maxRequests: 60,
});

export const aiLimiter = createRateLimiter('api-ai', {
  windowMs: 60_000,
  maxRequests: 15,
});

export const authLimiter = createRateLimiter('auth', {
  windowMs: 900_000, // 15 min
  maxRequests: 10,
});

export function getClientIp(request: Request): string {
  const headers = new Headers(request.headers);
  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('x-real-ip') ||
    'unknown'
  );
}
