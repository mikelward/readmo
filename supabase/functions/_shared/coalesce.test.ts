import { describe, expect, it, vi } from 'vitest';
import { coalesceGeneration } from './coalesce';
import type { GenerationLeaseClient, GenerationOutcome } from './coalesce';

// coalesceGeneration — the generic single-flight lease shared by the `summary`
// and `fulltext` functions. The summary suite exercises it transitively through
// coalesceSummaryGeneration; these tests pin the generic contract directly with a
// non-summary result type (a plain string), proving it isn't summary-shaped.

const ITEM = 'item-1';

/** In-memory model of the shared row's result + lease-marker columns, mirroring
 * the atomic conditional-UPDATE claim the real lease clients run against
 * Postgres. The check-and-set is synchronous (no await before the mutation),
 * exactly like a single UPDATE — so two callers can never both win. */
function makeWorld(initial?: { result?: string | null; leaseAt?: string | null; clock?: number }) {
  const state = {
    result: initial?.result ?? (null as string | null),
    leaseAt: initial?.leaseAt ?? (null as string | null),
  };
  let clock = initial?.clock ?? 1_000_000;
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const sleep = (ms: number) => {
    advance(ms);
    return Promise.resolve();
  };

  let claimCalls = 0;
  const client: GenerationLeaseClient<string> = {
    async claimLease(_itemId, staleBeforeIso, nowIso) {
      claimCalls++;
      if (state.result != null) return false;
      const stale =
        state.leaseAt == null || Date.parse(state.leaseAt) < Date.parse(staleBeforeIso);
      if (!stale) return false;
      state.leaseAt = nowIso; // atomic set — no await before this line
      return true;
    },
    async readState() {
      return { result: state.result, leaseAt: state.leaseAt };
    },
    async releaseLease(_itemId, claimStamp) {
      if (state.result == null && state.leaseAt === claimStamp) state.leaseAt = null;
    },
  };
  return {
    state,
    now,
    sleep,
    advance,
    client,
    get claimCalls() {
      return claimCalls;
    },
  };
}

describe('coalesceGeneration', () => {
  it('the elected generator runs generate() once and keeps the lease on a cached result', async () => {
    const w = makeWorld();
    const generate = vi.fn(async (): Promise<GenerationOutcome<string>> => {
      w.state.result = 'BODY';
      w.state.leaseAt = new Date(w.now()).toISOString();
      return { result: 'BODY', cached: true };
    });

    const out = await coalesceGeneration({
      client: w.client,
      itemId: ITEM,
      generate,
      now: w.now,
      sleep: w.sleep,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ result: 'BODY', cached: true });
    expect(w.state.leaseAt).not.toBeNull(); // NOT released — the result landed
  });

  it('a concurrent caller that loses the claim waits and returns the winner’s result — no second generate', async () => {
    // Seed a fresh lease held by "the winner" (still generating).
    const w = makeWorld({ leaseAt: new Date(1_000_000).toISOString() });
    // The winner finishes during our first poll sleep.
    let wrote = false;
    const sleep = (ms: number) => {
      if (!wrote) {
        wrote = true;
        w.state.result = 'FROM_WINNER';
      }
      w.advance(ms);
      return Promise.resolve();
    };
    const generate = vi.fn(async (): Promise<GenerationOutcome<string>> => {
      throw new Error('waiter must not generate');
    });

    const out = await coalesceGeneration({
      client: w.client,
      itemId: ITEM,
      generate,
      now: w.now,
      sleep,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(out).toEqual({ result: 'FROM_WINNER', cached: true });
  });

  it('a failed generator (cached:false) releases the lease so the next caller reclaims', async () => {
    const w = makeWorld();
    const failing = vi.fn(async (): Promise<GenerationOutcome<string>> => ({
      result: 'SOFT_FAIL',
      cached: false,
    }));
    const out1 = await coalesceGeneration({
      client: w.client,
      itemId: ITEM,
      generate: failing,
      now: w.now,
      sleep: w.sleep,
    });
    expect(out1).toEqual({ result: 'SOFT_FAIL', cached: false });
    expect(w.state.leaseAt).toBeNull(); // released after the soft failure

    const ok = vi.fn(async (): Promise<GenerationOutcome<string>> => {
      w.state.result = 'BODY';
      return { result: 'BODY', cached: true };
    });
    const out2 = await coalesceGeneration({
      client: w.client,
      itemId: ITEM,
      generate: ok,
      now: w.now,
      sleep: w.sleep,
    });
    expect(out2).toEqual({ result: 'BODY', cached: true });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('releases the lease (and re-throws) when the generator throws', async () => {
    const w = makeWorld();
    const boom = new Error('unexpected fetch failure');
    const generate = vi.fn(async (): Promise<GenerationOutcome<string>> => {
      throw boom;
    });

    await expect(
      coalesceGeneration({ client: w.client, itemId: ITEM, generate, now: w.now, sleep: w.sleep }),
    ).rejects.toBe(boom);

    expect(w.state.leaseAt).toBeNull(); // released despite the throw
    expect(w.state.result).toBeNull();
  });

  it('reclaims a stale lease left by a dead generator', async () => {
    // Lease stamped 2× the TTL ago, result never written (holder crashed).
    const w = makeWorld({ leaseAt: new Date(1_000_000 - 120_000).toISOString() });
    const generate = vi.fn(async (): Promise<GenerationOutcome<string>> => {
      w.state.result = 'BODY';
      return { result: 'BODY', cached: true };
    });
    const out = await coalesceGeneration({
      client: w.client,
      itemId: ITEM,
      generate,
      now: w.now,
      sleep: w.sleep,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ result: 'BODY', cached: true });
  });

  it('falls back to self-generating when a wedged holder never finishes before the deadline', async () => {
    // A fresh lease that never resolves (holder wedged): result stays null and the
    // lease stays fresh until the waiter’s deadline, so it self-generates.
    const w = makeWorld({ leaseAt: new Date(1_000_000).toISOString() });
    const generate = vi.fn(async (): Promise<GenerationOutcome<string>> => ({
      result: 'SELF',
      cached: true,
    }));
    const out = await coalesceGeneration({
      client: w.client,
      itemId: ITEM,
      generate,
      now: w.now,
      sleep: w.sleep,
      leaseTtlMs: 10_000,
      pollIntervalMs: 1_000,
      maxWaitMs: 3_000,
    });
    // Never won the claim (lease stayed fresh); generated once as the fallback.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ result: 'SELF', cached: true });
  });
});
