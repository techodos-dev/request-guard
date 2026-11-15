import type { GuardStore } from "./store.js";

/** Client-supplied keys: URL-safe characters, long enough to be unguessable. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && KEY_PATTERN.test(key);
}

export interface IdempotencyOptions {
  /** Prefix for store keys. Default `"idempotency:"`. */
  prefix?: string;
  /**
   * How long an in-progress claim blocks retries. Should exceed the handler's
   * maximum duration; if the process dies mid-request, retries resume after this.
   * Default 10 minutes.
   */
  lockTtlMs?: number;
  /** How long a completed result is replayed to retries. Default 24 hours. */
  resultTtlMs?: number;
}

export type IdempotencyOutcome<T> =
  /** `fn` ran now. `persisted` is false if the result could not be saved for replay. */
  | { status: "executed"; result: T; persisted: boolean }
  /** An earlier call with this key completed; its saved result is returned, `fn` did not run. */
  | { status: "replayed"; result: T }
  /** Another call with this key is still running; `fn` did not run. Typically answered with HTTP 409. */
  | { status: "in_progress" };

type StoredRecord<T> = { state: "processing" } | { state: "completed"; result: T };

export interface Idempotency {
  /**
   * Runs `fn` at most once per key (within the TTLs).
   *
   * - Completed before → returns the saved result (`replayed`).
   * - Running elsewhere → `in_progress`.
   * - Otherwise claims the key, runs `fn`, saves its result (`executed`).
   * - If `fn` throws, the claim is released so the client can retry, and the error is rethrown.
   *
   * The result must be JSON-serializable.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<IdempotencyOutcome<T>>;
}

export function createIdempotency(store: GuardStore, options: IdempotencyOptions = {}): Idempotency {
  const prefix = options.prefix ?? "idempotency:";
  const lockTtlMs = options.lockTtlMs ?? 10 * 60_000;
  const resultTtlMs = options.resultTtlMs ?? 24 * 60 * 60_000;

  async function readCompleted<T>(storeKey: string): Promise<{ result: T } | null> {
    const raw = await store.get(storeKey);
    if (raw === null) return null;
    const record = JSON.parse(raw) as StoredRecord<T>;
    return record.state === "completed" ? { result: record.result } : null;
  }

  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<IdempotencyOutcome<T>> {
      if (!isValidIdempotencyKey(key)) {
        throw new TypeError("Invalid idempotency key: expected 16-128 characters of [A-Za-z0-9_-]");
      }
      const storeKey = prefix + key;

      const earlier = await readCompleted<T>(storeKey);
      if (earlier) return { status: "replayed", result: earlier.result };

      const processing: StoredRecord<T> = { state: "processing" };
      const claimed = await store.setIfAbsent(storeKey, JSON.stringify(processing), lockTtlMs);
      if (!claimed) {
        // Lost the race: the other call may have finished between our read and claim.
        const finished = await readCompleted<T>(storeKey);
        return finished ? { status: "replayed", result: finished.result } : { status: "in_progress" };
      }

      let result: T;
      try {
        result = await fn();
      } catch (error) {
        await store.delete(storeKey).catch(() => {
          // Releasing is best-effort; the lock still expires after lockTtlMs.
        });
        throw error;
      }

      // The side effects already happened, so a failure to save the result must not
      // turn a successful call into an error. Report it instead.
      const completed: StoredRecord<T> = { state: "completed", result };
      const persisted = await store
        .set(storeKey, JSON.stringify(completed), resultTtlMs)
        .then(() => true, () => false);

      return { status: "executed", result, persisted };
    },
  };
}
