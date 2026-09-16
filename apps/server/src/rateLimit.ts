/**
 * Minimal in-memory sliding-window rate limiter.
 *
 * Purpose is cost control, not security: a runaway client loop calling a paid
 * vision API can burn a quota in minutes. For multi-instance deployments swap
 * this for Redis or the platform's native limiter.
 */

const WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 10_000;

const hits = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export function checkRateLimit(key: string, limit: number): RateLimitResult {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);

  if (recent.length >= limit) {
    const oldest = recent[0] ?? now;
    hits.set(key, recent);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
    };
  }

  recent.push(now);
  hits.set(key, recent);

  // Opportunistic cleanup so the map cannot grow without bound.
  if (hits.size > MAX_TRACKED_CLIENTS) {
    for (const [k, timestamps] of hits) {
      if (timestamps.every((t) => t <= cutoff)) hits.delete(k);
    }
  }

  return {
    allowed: true,
    remaining: limit - recent.length,
    retryAfterSec: 0,
  };
}
