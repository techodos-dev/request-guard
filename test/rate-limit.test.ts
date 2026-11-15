import { test } from "node:test";
import assert from "node:assert/strict";
import { createCooldown, createRateLimiter, type GuardStore } from "../src/index.js";
import { fakeClockStore } from "./helpers.js";

test("allows up to the limit, then denies until the window resets", async () => {
  const { store, now, advance } = fakeClockStore(60_000 * 100); // aligned to a window start
  const limiter = createRateLimiter(store, { limit: 3, windowMs: 60_000, now });

  const results = [];
  for (let i = 0; i < 4; i++) results.push(await limiter.check("1.2.3.4"));

  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false]);
  assert.deepEqual(results.map((r) => r.remaining), [2, 1, 0, 0]);
  assert.equal(results[3]?.resetInMs, 60_000);

  advance(60_000);
  assert.equal((await limiter.check("1.2.3.4")).allowed, true, "new window");
});

test("identifiers are limited independently", async () => {
  const { store, now } = fakeClockStore();
  const limiter = createRateLimiter(store, { limit: 1, windowMs: 1_000, now });
  assert.equal((await limiter.check("a")).allowed, true);
  assert.equal((await limiter.check("a")).allowed, false);
  assert.equal((await limiter.check("b")).allowed, true);
});

test("store errors fail open by default and closed when configured", async () => {
  const broken: GuardStore = {
    setIfAbsent: async () => { throw new Error("down"); },
    set: async () => { throw new Error("down"); },
    get: async () => { throw new Error("down"); },
    delete: async () => { throw new Error("down"); },
    incrementWithExpiry: async () => { throw new Error("down"); },
  };
  const open = await createRateLimiter(broken, { limit: 1, windowMs: 1_000 }).check("x");
  const closed = await createRateLimiter(broken, { limit: 1, windowMs: 1_000, onStoreError: "closed" }).check("x");
  assert.deepEqual([open.allowed, open.degraded], [true, true]);
  assert.deepEqual([closed.allowed, closed.degraded], [false, true]);
});

test("rejects invalid configuration", () => {
  const { store } = fakeClockStore();
  assert.throws(() => createRateLimiter(store, { limit: 0, windowMs: 1_000 }), RangeError);
  assert.throws(() => createRateLimiter(store, { limit: 1, windowMs: 1.5 }), RangeError);
});

test("cooldown allows one action per period", async () => {
  const { store, advance } = fakeClockStore();
  const cooldown = createCooldown(store, { cooldownMs: 60_000 });
  assert.equal(await cooldown.tryAcquire("1.2.3.4"), true);
  assert.equal(await cooldown.tryAcquire("1.2.3.4"), false);
  advance(60_000);
  assert.equal(await cooldown.tryAcquire("1.2.3.4"), true);
});
