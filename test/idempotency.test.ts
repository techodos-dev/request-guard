import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdempotency, isValidIdempotencyKey, type GuardStore } from "../src/index.js";
import { deferred, fakeClockStore, VALID_KEY } from "./helpers.js";

test("first call executes and saves the result", async () => {
  const { store } = fakeClockStore();
  const outcome = await createIdempotency(store).run(VALID_KEY, async () => ({ id: 1 }));
  assert.deepEqual(outcome, { status: "executed", result: { id: 1 }, persisted: true });
});

test("a retry replays the saved result without running fn again", async () => {
  const { store } = fakeClockStore();
  const idem = createIdempotency(store);
  let calls = 0;
  const fn = async () => ({ id: ++calls });

  await idem.run(VALID_KEY, fn);
  const retry = await idem.run(VALID_KEY, fn);

  assert.deepEqual(retry, { status: "replayed", result: { id: 1 } });
  assert.equal(calls, 1);
});

test("a concurrent call with the same key is reported in progress", async () => {
  const { store } = fakeClockStore();
  const idem = createIdempotency(store);
  const gate = deferred<string>();
  let calls = 0;

  const first = idem.run(VALID_KEY, async () => {
    calls++;
    return gate.promise;
  });
  const second = await idem.run(VALID_KEY, async () => {
    calls++;
    return "second";
  });
  gate.resolve("first");

  assert.deepEqual(second, { status: "in_progress" });
  assert.deepEqual(await first, { status: "executed", result: "first", persisted: true });
  assert.equal(calls, 1);
});

test("if fn throws, the key is released so the client can retry", async () => {
  const { store } = fakeClockStore();
  const idem = createIdempotency(store);

  await assert.rejects(idem.run(VALID_KEY, async () => { throw new Error("upstream down"); }), /upstream down/);
  const retry = await idem.run(VALID_KEY, async () => "ok");

  assert.equal(retry.status, "executed");
});

test("a failure to save the result does not fail the call", async () => {
  const { store } = fakeClockStore();
  const failingSet: GuardStore = { ...bind(store), set: async () => { throw new Error("store down"); } };
  const outcome = await createIdempotency(failingSet).run(VALID_KEY, async () => "done");
  assert.deepEqual(outcome, { status: "executed", result: "done", persisted: false });
});

test("results expire after resultTtlMs", async () => {
  const { store, advance } = fakeClockStore();
  const idem = createIdempotency(store, { resultTtlMs: 1_000 });
  await idem.run(VALID_KEY, async () => 1);
  advance(1_001);
  const later = await idem.run(VALID_KEY, async () => 2);
  assert.deepEqual(later, { status: "executed", result: 2, persisted: true });
});

test("an abandoned claim stops blocking retries after lockTtlMs", async () => {
  const { store, advance } = fakeClockStore();
  const idem = createIdempotency(store, { lockTtlMs: 5_000 });
  void idem.run(VALID_KEY, () => new Promise<never>(() => {})); // simulates a crashed instance
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await idem.run(VALID_KEY, async () => "x"), { status: "in_progress" });
  advance(5_001);
  assert.equal((await idem.run(VALID_KEY, async () => "x")).status, "executed");
});

test("invalid keys are rejected before touching the store", async () => {
  const { store } = fakeClockStore();
  const idem = createIdempotency(store);
  for (const key of ["short", "has spaces in it!!!!", "x".repeat(129), ""]) {
    await assert.rejects(idem.run(key, async () => 1), TypeError);
  }
  assert.equal(isValidIdempotencyKey(VALID_KEY), true);
  assert.equal(isValidIdempotencyKey(42), false);
});

function bind(store: GuardStore): GuardStore {
  return {
    setIfAbsent: store.setIfAbsent.bind(store),
    set: store.set.bind(store),
    get: store.get.bind(store),
    delete: store.delete.bind(store),
    incrementWithExpiry: store.incrementWithExpiry.bind(store),
  };
}
