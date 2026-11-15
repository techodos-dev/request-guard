import type { GuardStore } from "../store.js";

/**
 * The subset of the `@upstash/redis` client this adapter uses. Typed structurally so
 * request-guard has no runtime dependency on the Upstash SDK.
 */
export interface UpstashLikeClient {
  set(key: string, value: string, options: { px: number; nx?: true }): Promise<unknown>;
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  multi(): UpstashLikeTransaction;
}

export interface UpstashLikeTransaction {
  incr(key: string): UpstashLikeTransaction;
  pexpire(key: string, ms: number): UpstashLikeTransaction;
  exec(): Promise<unknown[]>;
}

/**
 * Adapts an `@upstash/redis` client (or any client with the same shape) to `GuardStore`.
 *
 * @example
 * import { Redis } from "@upstash/redis";
 * const store = upstashStore(Redis.fromEnv());
 */
export function upstashStore(redis: UpstashLikeClient): GuardStore {
  return {
    async setIfAbsent(key, value, ttlMs) {
      // Upstash returns "OK" when written and null when the key already existed.
      return (await redis.set(key, value, { px: ttlMs, nx: true })) === "OK";
    },

    async set(key, value, ttlMs) {
      await redis.set(key, value, { px: ttlMs });
    },

    async get(key) {
      const value = await redis.get(key);
      if (value === null || value === undefined) return null;
      // The Upstash SDK JSON-parses stored strings by default; normalize back to a string
      // so callers behave the same whether or not automaticDeserialization is enabled.
      return typeof value === "string" ? value : JSON.stringify(value);
    },

    async delete(key) {
      await redis.del(key);
    },

    async incrementWithExpiry(key, ttlMs) {
      const [count] = await redis.multi().incr(key).pexpire(key, ttlMs).exec();
      if (typeof count !== "number") {
        throw new TypeError(`Expected INCR to return a number, received ${typeof count}`);
      }
      return count;
    },
  };
}
