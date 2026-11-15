// Example: a Vercel/Node serverless handler that creates an order at most once per
// client key and limits each IP to 10 attempts per minute.
// Type-checked with the project (`npm run typecheck`) so it cannot drift from the API.
import { Redis } from "@upstash/redis";
import { createCooldown, createIdempotency, createRateLimiter, isValidIdempotencyKey, upstashStore } from "../src/index.js";

interface Req { method?: string; headers: Record<string, string | string[] | undefined>; body?: { idempotencyKey?: unknown; item?: string } }
interface Res { status(code: number): Res; setHeader(name: string, value: string): void; json(body: unknown): void }

const store = upstashStore(Redis.fromEnv());
const limiter = createRateLimiter(store, { limit: 10, windowMs: 60_000, onStoreError: "closed" });
const cooldown = createCooldown(store, { cooldownMs: 2_000 });
const idempotency = createIdempotency(store);

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = String(req.headers["x-real-ip"] ?? "unknown");
  const limit = await limiter.check(ip);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(Math.ceil(limit.resetInMs / 1000)));
    return res.status(429).json({ error: "Too many requests" });
  }
  if (!(await cooldown.tryAcquire(ip))) return res.status(429).json({ error: "Slow down" });

  const key = req.body?.idempotencyKey;
  if (!isValidIdempotencyKey(key)) return res.status(400).json({ error: "Missing or invalid idempotencyKey" });

  try {
    const outcome = await idempotency.run(key, () => createOrder(req.body?.item ?? ""));
    if (outcome.status === "in_progress") return res.status(409).json({ error: "Request already in progress" });
    return res.status(200).json(outcome.result);
  } catch {
    return res.status(502).json({ error: "Could not create the order, please retry" });
  }
}

async function createOrder(item: string): Promise<{ orderId: string; item: string }> {
  return { orderId: crypto.randomUUID(), item };
}
