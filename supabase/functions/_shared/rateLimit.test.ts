// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { RateLimiter, rateLimitKey } from './rateLimit.ts';

// A deterministic clock helper — the limiter takes `nowMs` explicitly so these
// tests never depend on wall-clock timing.
const T0 = 1_700_000_000_000;

describe('RateLimiter — token bucket', () => {
  it('allows a full burst up to capacity, then denies', () => {
    const rl = new RateLimiter({ capacity: 3, refillPerSec: 1 });
    expect(rl.take('u1', T0).allowed).toBe(true);
    expect(rl.take('u1', T0).allowed).toBe(true);
    expect(rl.take('u1', T0).allowed).toBe(true);
    const denied = rl.take('u1', T0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterS).toBe(1); // 1 token / 1 per sec
  });

  it('refills over elapsed time', () => {
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 1 });
    rl.take('u1', T0);
    rl.take('u1', T0);
    expect(rl.take('u1', T0).allowed).toBe(false);
    // 1s later, one token has refilled.
    expect(rl.take('u1', T0 + 1000).allowed).toBe(true);
    expect(rl.take('u1', T0 + 1000).allowed).toBe(false);
  });

  it('never refills past capacity', () => {
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 1 });
    rl.take('u1', T0); // consume 1 → 1 left
    // A long idle gap would over-refill an unclamped bucket.
    expect(rl.take('u1', T0 + 60_000).allowed).toBe(true); // back to 2, take 1
    expect(rl.take('u1', T0 + 60_000).allowed).toBe(true); // 1 left
    expect(rl.take('u1', T0 + 60_000).allowed).toBe(false); // empty
  });

  it('computes whole-second retry-after for a sub-1/sec rate', () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 0.2 }); // 1 / 5s
    expect(rl.take('u1', T0).allowed).toBe(true);
    const denied = rl.take('u1', T0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterS).toBe(5); // ceil(1 / 0.2)
  });

  it('keys are independent', () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1 });
    expect(rl.take('a', T0).allowed).toBe(true);
    expect(rl.take('a', T0).allowed).toBe(false);
    // A different caller has its own bucket.
    expect(rl.take('b', T0).allowed).toBe(true);
  });

  it('sweeps fully-refilled idle buckets once past maxKeys', () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1, maxKeys: 2 });
    rl.take('a', T0);
    rl.take('b', T0);
    // Third distinct key trips the sweep; a + b have since fully refilled
    // (>=1s elapsed at refill 1/s), so they're dropped as stateless.
    rl.take('c', T0 + 2000);
    expect(rl.size()).toBe(1);
  });
});

describe('rateLimitKey', () => {
  // Build an unsigned JWT-shaped token: header.payload.sig (sig is ignored).
  function jwt(payload: Record<string, unknown>): string {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
  }

  it('keys by the JWT subject so it survives token rotation', () => {
    const a = `Bearer ${jwt({ sub: 'user-123', exp: 1 })}`;
    const b = `Bearer ${jwt({ sub: 'user-123', exp: 999 })}`; // rotated token
    expect(rateLimitKey(a)).toBe('sub:user-123');
    expect(rateLimitKey(a)).toBe(rateLimitKey(b));
  });

  it('falls back to the raw token when there is no parseable sub', () => {
    expect(rateLimitKey('Bearer not-a-jwt')).toBe('tok:not-a-jwt');
    expect(rateLimitKey(`Bearer ${jwt({ foo: 'bar' })}`)).toMatch(/^tok:/);
  });

  it('buckets missing/empty auth under a shared anon key', () => {
    expect(rateLimitKey(null)).toBe('anon');
    expect(rateLimitKey('')).toBe('anon');
    expect(rateLimitKey('Bearer    ')).toBe('anon');
  });
});
