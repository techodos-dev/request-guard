import type { GuardStore } from "../store.js";

interface Entry {
  value: string;
  expiresAt: number;
}

/**
 * In-process store for tests and local development.
 *
 * Not suitable for production on serverless platforms: each instance has its own
 * memory, so limits and idempotency would only apply per instance.
 */
export class MemoryStore implements GuardStore {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;

  /** @param now Clock in milliseconds; inject a fake clock in tests. */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.#read(key) !== null) return false;
    this.#write(key, value, ttlMs);
    return true;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.#write(key, value, ttlMs);
  }

  async get(key: string): Promise<string | null> {
    return this.#read(key);
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async incrementWithExpiry(key: string, ttlMs: number): Promise<number> {
    const next = Number(this.#read(key) ?? "0") + 1;
    this.#write(key, String(next), ttlMs);
    return next;
  }

  #read(key: string): string | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value;
  }

  #write(key: string, value: string, ttlMs: number): void {
    assertTtl(ttlMs);
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs });
  }
}

function assertTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`ttlMs must be a positive integer, received ${ttlMs}`);
  }
}
