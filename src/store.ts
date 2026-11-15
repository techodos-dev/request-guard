/**
 * The minimal set of atomic operations request-guard needs from a key-value store.
 *
 * Every operation must be atomic on the store side — that is what makes the
 * guards safe across many concurrent serverless instances. Redis provides all of
 * them natively; `MemoryStore` provides them for a single process (tests, local dev).
 */
export interface GuardStore {
  /** Store `value` only if `key` does not exist. Returns `true` if it was written. (Redis: SET NX PX) */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;

  /** Overwrite `key` with `value` and a new expiry. (Redis: SET PX) */
  set(key: string, value: string, ttlMs: number): Promise<void>;

  /** Read a string value, or `null` if missing or expired. (Redis: GET) */
  get(key: string): Promise<string | null>;

  /** Remove `key`. No-op if missing. (Redis: DEL) */
  delete(key: string): Promise<void>;

  /**
   * Increment an integer counter and make sure it expires after `ttlMs`.
   * Must be a single atomic step so a counter can never be left without an expiry.
   * Returns the value after incrementing. (Redis: MULTI INCR + PEXPIRE)
   */
  incrementWithExpiry(key: string, ttlMs: number): Promise<number>;
}
