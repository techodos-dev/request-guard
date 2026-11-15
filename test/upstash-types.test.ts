// Compile-time check: the real @upstash/redis client satisfies UpstashLikeClient.
// (No network calls — the client is constructed but never used.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "@upstash/redis";
import { upstashStore } from "../src/index.js";

test("accepts a real @upstash/redis client (type-level)", () => {
  const store = upstashStore(new Redis({ url: "https://example.invalid", token: "unused" }));
  assert.equal(typeof store.setIfAbsent, "function");
});
