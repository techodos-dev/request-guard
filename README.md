# request-guard

Idempotency and rate limiting for serverless HTTP handlers, backed by Redis (Upstash) or any
key-value store with a few atomic operations. Written in TypeScript, zero runtime dependencies.

## Why

Serverless functions run as many short-lived instances at once, so in-memory guards don't work:

- **Duplicate side effects.** A user double-clicks "Book", or a mobile network retries a request
  whose response was lost. Without idempotency the handler creates two bookings and sends two emails.
- **Abuse and quota exhaustion.** An endpoint that calls a paid or rate-limited upstream API
  (Google Calendar, an LLM, SMS) can be looped by a script until the quota is gone.

The patterns here were first written for the booking backend of a small business's production
website and extracted into a standalone, tested library.

## Install

Not published to npm yet. To try it:

```bash
git clone https://github.com/techodos-dev/request-guard.git
cd request-guard && npm ci && npm run build
```

## Usage

```ts
import { Redis } from "@upstash/redis";
import { upstashStore, createIdempotency, createRateLimiter, isValidIdempotencyKey } from "request-guard";

const store = upstashStore(Redis.fromEnv());
const limiter = createRateLimiter(store, { limit: 10, windowMs: 60_000 });
const idempotency = createIdempotency(store);

// inside a handler
const { allowed, resetInMs } = await limiter.check(clientIp);
if (!allowed) return tooManyRequests(Math.ceil(resetInMs / 1000));

if (!isValidIdempotencyKey(body.idempotencyKey)) return badRequest();
const outcome = await idempotency.run(body.idempotencyKey, () => createBooking(body));

if (outcome.status === "in_progress") return conflict();      // 409
return ok(outcome.result);                                     // "executed" or "replayed"
```

A complete, type-checked handler is in [`examples/vercel-handler.ts`](examples/vercel-handler.ts).

## API

### `createIdempotency(store, options?)` → `{ run(key, fn) }`

Runs `fn` at most once per key.

| Situation | Result | `fn` runs? |
| --- | --- | --- |
| First call | `{ status: "executed", result, persisted }` | yes |
| Retry after success | `{ status: "replayed", result }` (saved result) | no |
| Same key still running | `{ status: "in_progress" }` | no |
| `fn` throws | error is rethrown, key released so the client can retry | — |

`persisted: false` means `fn` succeeded but its result could not be saved (store outage). The call
still succeeds, because the side effects already happened — reporting an error would invite a
duplicate retry. Options: `lockTtlMs` (default 10 min; should exceed the handler timeout so a crashed
instance can't block a key forever), `resultTtlMs` (default 24 h), `prefix`.

Keys must be 16–128 characters of `[A-Za-z0-9_-]`; generate them on the client with
`crypto.randomUUID()`.

### `createRateLimiter(store, { limit, windowMs, onStoreError?, prefix? })` → `{ check(id) }`

Fixed-window counter. Returns `{ allowed, remaining, resetInMs, degraded }`.

- `onStoreError: "open"` (default) allows requests when the store is down — for read-only endpoints
  where the limiter must not become an outage. Use `"closed"` for endpoints with side effects.
- `degraded: true` tells you the decision came from that fallback, so you can log it.

### `createCooldown(store, { cooldownMs, prefix? })` → `{ tryAcquire(id) }`

One action per identifier per period (e.g. one form submission per minute per IP).

### Stores

| Store | Use |
| --- | --- |
| `upstashStore(redis)` | Production. Works with `@upstash/redis` (typed structurally — no dependency) |
| `MemoryStore` | Tests and local development only (state is per process) |
| your own | Implement `GuardStore` (5 atomic operations) for ioredis, DynamoDB, etc. |

## Design decisions

- **Atomicity lives in the store.** Claims use `SET NX PX`; counters use `INCR` + `PEXPIRE` inside one
  `MULTI`, so a counter can never be left without an expiry (a separate `PEXPIRE` call that fails
  would block an IP forever).
- **Fixed window, not sliding.** One round trip per request. It can admit up to 2× `limit` across a
  window boundary, which is acceptable for abuse protection; use a sliding-window log if you need
  exact limits.
- **Release on failure, keep on success.** Failed work can be retried immediately; successful work is
  replayed instead of repeated.
- **Upstash quirk handled.** The Upstash SDK JSON-parses stored values by default; the adapter
  normalizes reads so behavior is identical with or without `automaticDeserialization`.

## Limitations

- Idempotency is per key, not per request body: reusing a key with a different payload replays the
  first result. Bind keys to the payload on the client if that matters.
- Results must be JSON-serializable.
- If the store is unavailable, `run` throws before executing `fn` (it cannot guarantee once-only).

## Development

```bash
npm ci
npm run typecheck   # strict TypeScript, including tests and examples
npm test            # node:test suite
npm run coverage    # with coverage report (Node 22.5+)
npm run build       # emits dist/ with type declarations
```

CI runs type checking, build and tests on Node 20 and 22.

## License

[MIT](LICENSE)
