// In-memory, per-caller rate limiter for the browser-invoked Edge Functions
// (currently `refresh`).
//
// Why in-memory rather than a DB-backed counter: the whole point is to shed a
// misbehaving client's load *before* it turns into Postgres work. A client
// stuck on a buggy version that pull-to-refreshes (or re-adds feeds) in a loop
// would otherwise spend, on every call, a JWT round-trip + a `subscriptions`
// select + one `feeds` read per subscription — even when the per-feed publisher
// debounce ends up skipping the upstream fetch. Counting those requests in a DB
// table would add writes to the exact resource we're trying to protect, so the
// bucket lives in module memory instead: zero network, zero DB, ~one Map entry
// per active caller.
//
// Scope and honesty about what this does NOT do: a module-level bucket lives
// for the lifetime of one warm Edge isolate. A single client hammering the
// endpoint keeps landing on the same warm isolate, so this reliably bounds the
// "one buggy client in a refetch loop" case we actually see. It is deliberately
// best-effort and does NOT bound a distributed flood across many isolates/
// regions, nor the direct PostgREST read path (`feed_items`), which has no Edge
// Function in front of it. A true distributed cap belongs at the gateway
// (Cloudflare / platform rate limiting) and is tracked separately.
//
// Cost/reliability (guardrail #5): negligible. No new infra, no external call,
// no DB work; memory is bounded by an opportunistic sweep of idle buckets.

export interface TokenBucketOptions {
  /** Burst size — tokens available when the bucket is full. */
  capacity: number;
  /** Sustained rate: tokens refilled per second. */
  refillPerSec: number;
  /** Map-size threshold that triggers an opportunistic sweep of idle keys. */
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Whole seconds until the next token is available (0 when allowed). */
  retryAfterS: number;
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

const DEFAULT_MAX_KEYS = 10_000;

/**
 * A token-bucket limiter keyed by an arbitrary string (we key by JWT subject).
 * The clock is injected (`nowMs`) so callers and tests are deterministic — no
 * reliance on wall-clock time inside the limiter, which keeps the tests from
 * being racy (CLAUDE.md testing rules).
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly maxKeys: number;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** Consume one token for `key`. Returns whether the call is allowed. */
  take(key: string, nowMs: number): RateLimitResult {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, updatedAtMs: nowMs };
      this.buckets.set(key, bucket);
    } else {
      // Lazily refill based on elapsed time since this bucket was last touched.
      const elapsedS = Math.max(0, (nowMs - bucket.updatedAtMs) / 1000);
      bucket.tokens = Math.min(
        this.capacity,
        bucket.tokens + elapsedS * this.refillPerSec,
      );
      bucket.updatedAtMs = nowMs;
    }

    // Keep the map from growing without bound under caller churn. A fully
    // refilled idle bucket is indistinguishable from a fresh one, so dropping it
    // loses no state — the next request re-creates it at capacity.
    if (this.buckets.size > this.maxKeys) this.sweep(nowMs);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterS: 0 };
    }
    const deficit = 1 - bucket.tokens;
    return { allowed: false, retryAfterS: Math.ceil(deficit / this.refillPerSec) };
  }

  /** Visible for tests/observability: current number of tracked keys. */
  size(): number {
    return this.buckets.size;
  }

  private sweep(nowMs: number): void {
    const fullAfterMs = (this.capacity / this.refillPerSec) * 1000;
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.updatedAtMs >= fullAfterMs) this.buckets.delete(key);
    }
  }
}

/**
 * Derive a stable rate-limit key from an `Authorization: Bearer <jwt>` header.
 * We use the JWT's `sub` (the Supabase user id) so the bucket follows the user
 * across hourly token rotation. This does NOT verify the signature, and that is
 * a deliberate scope boundary, not an oversight:
 *
 * - The target is an *honest* client stuck in a refetch loop — it sends its own
 *   real, stable token, so `sub`-keying buckets it correctly and sheds it.
 * - A *malicious* caller can forge unsigned JWT-shaped headers with a rotating
 *   `sub` to get a fresh bucket per request and still reach the `subscriptions`
 *   query. We don't defend that here: there is no non-spoofable pre-auth key
 *   available in-code (the forwarded IP is forgeable too), and verifying the
 *   signature would need the JWT secret on the hot path. Bounding adversarial /
 *   distributed traffic is the gateway's job (real client IP + verified
 *   identity, before Postgres) — see SCALING.md "Shedding an abusive client".
 *
 * Falls back to the raw token, then to a shared `anon` bucket.
 */
export function rateLimitKey(authHeader: string | null | undefined): string {
  const token = (authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return 'anon';
  const sub = subjectFromJwt(token);
  return sub ? `sub:${sub}` : `tok:${token}`;
}

function subjectFromJwt(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    // base64url → base64, then decode the JSON payload.
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64);
    const claims = JSON.parse(json) as { sub?: unknown };
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}
