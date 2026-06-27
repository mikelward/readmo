// Client-side request circuit breaker for the Supabase fetch path.
//
// WHY: a runaway client (a refetch/retry loop, an expired-token request retried
// without backoff) can flood the backend with hundreds of FAILING requests per
// second from a single tab — enough to pin Postgres CPU at 100% with two users.
// The server-side `x-readmo-build` version gate can shed a *known-bad build*,
// but it can't stop a loop inside the build that's currently live. `supabaseFetch`
// routes bounded READS (GET /rest/v1/ + the feed_items RPC) through this breaker,
// so a refetch loop there fails fast instead of hammering Postgres. (Writes are
// outbox-owned; auth/Edge Functions bypass it — see supabaseFetch.) It's the
// additive second layer behind the retry discipline (src/lib/queryRetry.ts):
// retries can't amplify, and if a loop still arises some other way, the breaker
// caps it.
//
// It is a classic FAILURE-based breaker: it trips on a burst of consecutive
// failures, fails fast for a cooldown, then admits exactly ONE half-open probe;
// the probe's result closes it (recovered) or re-opens it (still failing). A
// failing loop (the incident — requests rolling back / erroring) trips it;
// healthy traffic never does. It deliberately does NOT trip on request *rate*: a
// legitimate burst (e.g. the offline-cache warm path prefetching a user's many
// pinned items) would false-positive a rate ceiling and shed that user's own
// reads. Volume-based shedding belongs at the edge (per-IP, Cloudflare).
//
// GENERATIONS: `supabaseFetch` leaves auth/functions/writes uncapped, so a long
// request admitted before an outage can resolve much later — during the
// half-open probe, OR after recovery. To stop such a stale result from flipping
// the breaker on outdated info, every state transition bumps a `generation`
// counter, `shouldAllow()` stamps each admitted request's ticket with the
// current generation, and `settle()` ignores any ticket whose generation is no
// longer current. So only requests admitted since the last transition count —
// in every state, not just during cooldown.
//
// Pure and clock-injectable so it unit-tests without timers.

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker open. */
  failureThreshold?: number;
  /** How long the breaker stays open before admitting a half-open probe. */
  cooldownMs?: number;
  /** Injectable clock (defaults to Date.now). */
  now?: () => number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export const DEFAULTS = {
  // ~6 straight failures = the backend is genuinely erroring, not a one-off blip.
  failureThreshold: 6,
  // Long enough to actually relieve the backend; short enough to recover quickly
  // once it's healthy again.
  cooldownMs: 10_000,
} as const;

/** Opaque ticket from shouldAllow(); pass it back to settle()/settleCanceled().
 *  (It's the breaker generation the request was admitted in.) */
export type RequestTicket = number;

export class RequestCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  /** Bumped on every state transition; a ticket is current iff it equals this. */
  private generation = 1;
  /** While half-open, a promise that resolves when the probe settles (success,
   *  failure, or cancel) — lets a shed peer WAIT for the probe instead of
   *  failing and burning its retry budget while a slow probe is still in flight. */
  private probeSettled: Promise<void> | null = null;
  private resolveProbeSettled: (() => void) | null = null;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? DEFAULTS.failureThreshold;
    this.cooldownMs = opts.cooldownMs ?? DEFAULTS.cooldownMs;
    this.now = opts.now ?? Date.now;
  }

  /** Current state, for logging/tests. */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Call before issuing a request. Returns a ticket to pass back to settle()
   * when it resolves, or `null` when the request should be SHED (the breaker is
   * open and still cooling down, or a half-open probe is already in flight).
   */
  shouldAllow(): RequestTicket | null {
    if (this.state === 'open') {
      if (this.now() - this.openedAt < this.cooldownMs) return null; // cooling down
      // Cooldown elapsed → admit a single probe in a fresh generation, and arm
      // the wait peers will hold on until the probe settles.
      this.state = 'half-open';
      this.generation += 1;
      this.probeSettled = new Promise<void>((resolve) => {
        this.resolveProbeSettled = resolve;
      });
      return this.generation;
    }
    if (this.state === 'half-open') {
      // One probe at a time; shed the rest until it resolves.
      return null;
    }
    return this.generation; // closed: healthy, admit everything in this generation
  }

  /** Report the outcome of a request that `shouldAllow()` ticketed. */
  settle(ticket: RequestTicket, ok: boolean): void {
    // Stale request (admitted before the last transition) — its result is about
    // a bygone state, so it can't trip/reset the breaker in ANY state.
    if (ticket !== this.generation) return;

    if (this.state === 'half-open') {
      if (ok) this.reset();
      else this.trip();
      return;
    }
    // closed (the open state admits no current-generation tickets)
    if (ok) {
      this.consecutiveFailures = 0;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) this.trip();
  }

  /**
   * A ticketed request was CANCELED by its caller before completing (an abort) —
   * it tells us nothing about backend health, so it counts as neither failure
   * nor success. If the canceled request was the half-open PROBE, the breaker
   * would otherwise stay half-open forever (every later request shed, no result
   * arriving), so re-arm an immediate re-probe rather than getting stuck.
   */
  settleCanceled(ticket: RequestTicket): void {
    if (ticket !== this.generation) return; // stale cancel — ignore
    if (this.state === 'half-open') {
      // Re-open but leave the cooldown already elapsed so the NEXT request
      // probes again (a fresh generation is minted then) — a cancel isn't
      // evidence the backend is still unhealthy.
      this.state = 'open';
      this.openedAt = this.now() - this.cooldownMs;
      this.releaseProbeWaiters(); // waiting peers re-decide (they'll re-probe)
    }
    // closed: a canceled request is neither a failure nor a success — nothing
    // to do (and the generation is unchanged, so it's not invalidated here).
  }

  /**
   * While a half-open probe is in flight, the promise it resolves on settlement;
   * `null` otherwise. A request shed because the probe is mid-flight awaits this
   * and re-decides afterward, so a healthy-but-slow probe doesn't leave its peer
   * reads errored (their retry budget can be shorter than the probe's latency).
   */
  probeWait(): Promise<void> | null {
    return this.state === 'half-open' ? this.probeSettled : null;
  }

  /** Wake any peers parked on probeWait() — call AFTER the state transition so
   * they re-decide against the new state. */
  private releaseProbeWaiters(): void {
    const resolve = this.resolveProbeSettled;
    this.probeSettled = null;
    this.resolveProbeSettled = null;
    resolve?.();
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.consecutiveFailures = 0;
    this.generation += 1; // invalidate in-flight tickets from the prior generation
    this.releaseProbeWaiters();
  }

  private reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.generation += 1; // post-recovery: pre-outage tickets are now stale
    this.releaseProbeWaiters();
  }
}
