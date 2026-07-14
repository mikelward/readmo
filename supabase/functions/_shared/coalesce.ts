// Readmo single-flight generation lease — shared, pure logic.
//
// Both the `summary` and `fulltext` Edge Functions cache an expensive per-item
// artifact on a SHARED `items` row (the AI gist on `ai_summary`; the extracted
// reading-mode body on `full_content_html`). In both, N concurrent misses for
// the same item — a device pre-warm racing a pin on another device, the same
// article open on phone + desktop, the pin trigger's server-side call racing the
// reader's on-open fetch — would otherwise each run the full expensive pass (a
// Jina + Gemini call for summaries; a publisher fetch + extract for full text).
//
// This coalesces them: the elected caller GENERATES while every other concurrent
// caller WAITS and returns the winner's cached result the instant it lands, so N
// concurrent misses cost ONE generation. The election is a durable row marker —
// a timestamp column read as "a generation is in flight" while the result column
// is still null — claimed by a single atomic conditional UPDATE. It is NOT a
// Postgres advisory lock: advisory locks are session/txn scoped and Supabase's
// pooled PostgREST connections would drop the lock the moment the claim statement
// commits, long before the Deno-side fetch/LLM awaits finish.
//
// Fail-safe by construction — a caller is never worse off than the no-lease
// behavior: a generator that FAILS (returns `cached:false`) or THROWS releases
// the marker at once so a waiter/retry proceeds without blocking on the TTL; a
// generator that DIES leaves a stale marker any caller reclaims after the TTL;
// and a waiter that hits the overall cap self-generates without a lease.
//
// Deno-global-free (the clock + sleep are injected) so the same code runs under
// vitest (node) for unit tests; the Supabase-backed lease clients live in the
// respective index.ts files.

/** Default lease TTL: how long a marker stays valid before a waiter treats it as
 * stale and reclaims it. A caller overrides this to exceed its own worst-case
 * generation time so a slow-but-alive generator isn't preempted. */
export const DEFAULT_LEASE_TTL_MS = 60_000;

/** Default poll cadence a waiter re-reads the row at while the generator works. */
export const DEFAULT_POLL_INTERVAL_MS = 750;

/** Default overall cap a waiter blocks before giving up and self-generating.
 * Kept above the lease TTL so the normal path is "wait, then read the generator's
 * result"; self-generate is only for a wedged holder. */
export const DEFAULT_MAX_WAIT_MS = 45_000;

/** The DB operations the coalescer needs, injected so it's unit-testable without
 * Deno/Supabase. `TResult` is the cached artifact the waiter returns verbatim. */
export interface GenerationLeaseClient<TResult> {
  /** Atomically claim the lease for `itemId`, stamping it `nowIso`. Wins iff the
   * result is still absent AND the existing marker is null or older than
   * `staleBeforeIso`. Returns true iff THIS caller won. */
  claimLease(itemId: string, staleBeforeIso: string, nowIso: string): Promise<boolean>;
  /** Read the current cached result (null if still absent) and marker stamp. */
  readState(itemId: string): Promise<{ result: TResult | null; leaseAt: string | null }>;
  /** Release a marker we hold after a FAILED generation (nothing persisted), so a
   * waiter/retry proceeds immediately instead of waiting out the TTL. Guarded on
   * our own `claimStamp` so it never clobbers a result or a re-claimed marker. */
  releaseLease(itemId: string, claimStamp: string): Promise<void>;
}

/** A generation's outcome. `cached: true` means the result was persisted to the
 * shared row — so waiters can read it and the marker must NOT be released.
 * `cached: false` (a soft failure, or an `ok` whose write failed) releases the
 * marker so a waiter regenerates rather than blocking on a result that never
 * landed. */
export interface GenerationOutcome<TResult> {
  result: TResult;
  cached: boolean;
}

export interface CoalesceGenerationDeps<TResult> {
  client: GenerationLeaseClient<TResult>;
  itemId: string;
  /** Runs the real expensive work + cache write. Invoked ONLY when this caller
   * holds the lease (or as the last-resort self-generate fallback). */
  generate: () => Promise<GenerationOutcome<TResult>>;
  /** Current epoch ms. Injected so tests drive a virtual clock. */
  now: () => number;
  /** Sleep `ms`. Injected so tests advance the clock deterministically. */
  sleep: (ms: number) => Promise<void>;
  leaseTtlMs?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

/**
 * Single-flight a generation across concurrent callers for one item.
 *
 * The elected generator runs {@link CoalesceGenerationDeps.generate}; every other
 * concurrent caller waits and returns the generator's result the moment it's
 * cached. Falls back to self-generating if the lease can't be won and no result
 * appears before the deadline (a wedged/dead holder), so a caller is never worse
 * off than the no-lease behavior.
 */
export async function coalesceGeneration<TResult>(
  deps: CoalesceGenerationDeps<TResult>,
): Promise<GenerationOutcome<TResult>> {
  const { client, itemId, generate, now, sleep } = deps;
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const deadline = now() + maxWaitMs;

  for (;;) {
    const nowIso = new Date(now()).toISOString();
    const staleBeforeIso = new Date(now() - leaseTtlMs).toISOString();
    const won = await client.claimLease(itemId, staleBeforeIso, nowIso);
    if (won) {
      let outcome: GenerationOutcome<TResult>;
      try {
        outcome = await generate();
      } catch (err) {
        // Generator threw before returning an outcome. Release the marker so
        // waiters/retries reclaim at once instead of blocking on the full TTL,
        // then re-throw so the handler still reports the failure.
        await client.releaseLease(itemId, nowIso);
        throw err;
      }
      if (!outcome.cached) {
        // Nothing persisted (a soft failure, or an `ok` whose write failed) —
        // release so a waiter or a later mount retries at once.
        await client.releaseLease(itemId, nowIso);
      }
      return outcome;
    }

    // Lost the claim: another caller holds a fresh marker, or the result was
    // written between our read and here. Poll for their result.
    for (;;) {
      const { result, leaseAt } = await client.readState(itemId);
      if (result != null) return { result, cached: true };
      const leaseFresh = leaseAt != null && Date.parse(leaseAt) >= now() - leaseTtlMs;
      if (!leaseFresh) break; // holder failed/died → reclaim (outer loop)
      if (now() >= deadline) return generate(); // wedged holder → self-generate
      await sleep(pollIntervalMs);
    }
    if (now() >= deadline) return generate();
  }
}
