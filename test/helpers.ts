import { MemoryStore } from "../src/index.js";

/** A MemoryStore driven by a manual clock. */
export function fakeClockStore(start = 1_700_000_000_000) {
  let time = start;
  const store = new MemoryStore(() => time);
  return {
    store,
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

/** Deferred promise for controlling when an async function finishes. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const VALID_KEY = "fake-idempotency-key-for-tests";
