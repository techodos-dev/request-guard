import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdempotency, upstashStore, type UpstashLikeClient, type UpstashLikeTransaction } from "../src/index.js";
import { VALID_KEY } from "./helpers.js";

/** Mimics @upstash/redis responses, including its default JSON auto-deserialization. */
function fakeUpstash(options: { autoDeserialize: boolean }) {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  const client: UpstashLikeClient = {
    async set(key, value, { px, nx }) {
      if (nx && data.has(key)) return null;
      data.set(key, value);
      ttls.set(key, px);
      return "OK";
    },
    async get(key) {
      const raw = data.get(key);
      if (raw === undefined) return null;
      if (!options.autoDeserialize) return raw;
      try { return JSON.parse(raw); } catch { return raw; }
    },
    async del(key) {
      return data.delete(key) ? 1 : 0;
    },
    multi() {
      const ops: Array<() => unknown> = [];
      const tx: UpstashLikeTransaction = {
        incr(key) { ops.push(() => { const n = Number(data.get(key) ?? 0) + 1; data.set(key, String(n)); return n; }); return tx; },
        pexpire(key, ms) { ops.push(() => { ttls.set(key, ms); return 1; }); return tx; },
        async exec() { return ops.map((op) => op()); },
      };
      return tx;
    },
  };
  return { client, data, ttls };
}

for (const autoDeserialize of [true, false]) {
  test(`idempotency round-trips through the Upstash adapter (autoDeserialize=${autoDeserialize})`, async () => {
    const idem = createIdempotency(upstashStore(fakeUpstash({ autoDeserialize }).client));
    await idem.run(VALID_KEY, async () => ({ booking: "abc", count: 2 }));
    const retry = await idem.run(VALID_KEY, async () => ({ booking: "other", count: 0 }));
    assert.deepEqual(retry, { status: "replayed", result: { booking: "abc", count: 2 } });
  });
}

test("setIfAbsent maps Upstash 'OK' / null to true / false", async () => {
  const store = upstashStore(fakeUpstash({ autoDeserialize: true }).client);
  assert.equal(await store.setIfAbsent("k", "v", 1_000), true);
  assert.equal(await store.setIfAbsent("k", "v", 1_000), false);
});

test("incrementWithExpiry increments and sets the expiry in one transaction", async () => {
  const { client, ttls } = fakeUpstash({ autoDeserialize: true });
  const store = upstashStore(client);
  assert.equal(await store.incrementWithExpiry("c", 60_000), 1);
  assert.equal(await store.incrementWithExpiry("c", 60_000), 2);
  assert.equal(ttls.get("c"), 60_000);
});
