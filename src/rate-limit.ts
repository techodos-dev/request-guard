import type { GuardStore } from "./store.js";

export interface RateLimitOptions {
  /** Maximum requests per identifier per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Prefix for store keys. Default `"ratelimit:"`. */
  prefix?: string;
  /**
   * What to do when the store is unreachable.
   * - `"open"` (default): allow the request. Right for read-only endpoints where an outage
   *   of the limiter must not take the feature down.
   * - `"closed"`: deny it. Right for endpoints with side effects (sending email, writing data).
   */
  onStoreError?: "open" | "closed";
  /** Clock in milliseconds; inject a fake clock in tests. */
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window (0 when denied). */
  remaining: number;
  /** Milliseconds until the current window resets — suitable for a `Retry-After` header. */
  resetInMs: number;
  /** True when the decision came from `onStoreError` because the store failed. */
  degraded: boolean;
}

export interface RateLimiter {
  check(identifier: string): Promise<RateLimitResult>;
}

/**
 * Fixed-window counter: at most `limit` requests per identifier per window.
 *
 * Each window has its own key (`prefix + identifier + ":" + windowIndex`), incremented and
 * given an expiry in one atomic step, so no counter can outlive its window. Fixed windows
 * allow up to 2× `limit` across a window boundary; that trade-off buys one store round trip
 * per request and is acceptable for abuse protection.
 */
export function createRateLimiter(store: GuardStore, options: RateLimitOptions): RateLimiter {
  const { limit, windowMs } = options;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new RangeError("windowMs must be a positive integer");
  const prefix = options.prefix ?? "ratelimit:";
  const failOpen = (options.onStoreError ?? "open") === "open";
  const now = options.now ?? Date.now;

  return {
    async check(identifier) {
      const time = now();
      const windowIndex = Math.floor(time / windowMs);
      const resetInMs = (windowIndex + 1) * windowMs - time;

      let count: number;
      try {
        count = await store.incrementWithExpiry(`${prefix}${identifier}:${windowIndex}`, windowMs);
      } catch {
        return { allowed: failOpen, remaining: 0, resetInMs, degraded: true };
      }

      const allowed = count <= limit;
      return { allowed, remaining: allowed ? limit - count : 0, resetInMs, degraded: false };
    },
  };
}

export interface CooldownOptions {
  /** Minimum time between accepted actions per identifier. */
  cooldownMs: number;
  /** Prefix for store keys. Default `"cooldown:"`. */
  prefix?: string;
}

export interface Cooldown {
  /** `true` if the action may proceed now (and starts the cooldown); `false` if still cooling down. */
  tryAcquire(identifier: string): Promise<boolean>;
}

/**
 * One action per identifier per `cooldownMs` — e.g. one form submission per minute per IP.
 * A single atomic SET NX; store errors propagate so the caller decides how to fail.
 */
export function createCooldown(store: GuardStore, options: CooldownOptions): Cooldown {
  const prefix = options.prefix ?? "cooldown:";
  return {
    tryAcquire: (identifier) => store.setIfAbsent(prefix + identifier, "1", options.cooldownMs),
  };
}
