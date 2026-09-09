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
  /** Closed, but recovered only on weak evidence — admission stays SERIALIZED
   *  (one request at a time) until an authoritative success confirms health.
   *  See settleInconclusive. */
  private probation = false;
  /** A probationary request is in flight, so peers park instead of piling on. */
  private probationInFlight = false;

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
      this.armProbeWait();
      return this.generation;
    }
    if (this.state === 'half-open') {
      // One probe at a time; shed the rest until it resolves.
      return null;
    }
    // Closed. Normally admit everything; on probation admit ONE at a time, so a
    // recovery believed on weak evidence can't be the cue for a parked crowd to
    // hit a still-failing backend all at once.
    if (this.probation) {
      if (this.probationInFlight) return null; // peer parks on probeWait()
      this.probationInFlight = true;
      this.armProbeWait();
    }
    return this.generation;
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
      // An AUTHORITATIVE success — the only thing that ends probation, because
      // it's the only evidence the backend itself is actually serving.
      this.consecutiveFailures = 0;
      this.probation = false;
      this.endProbationaryRequest();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) this.trip();
    else this.endProbationaryRequest();
  }

  /**
   * A ticketed request finished, and its outcome says the backend ANSWERED but
   * says nothing about whether it is healthy. Two callers (see supabase/client.ts):
   * a cacheable read that succeeded — a service-worker cache fallback can answer
   * one with a `200` the backend never saw — and a cacheable read that returned
   * 4xx, which this app produces deliberately when feature-detecting an older
   * backend. Neither may clear the failure run.
   *
   * What DOES count as failure (through `settle`) is a 5xx or a thrown error on
   * such a read: the cache can manufacture a success and never those. That
   * asymmetry is the point — count what a cache cannot fake, ignore what it can.
   *
   * As the half-open PROBE it CLOSES the circuit, but on probation: the failure
   * run is left one short of the threshold, so a single failure re-opens it
   * immediately instead of needing another full burst.
   *
   * Closing on evidence this weak looks wrong, and the alternative is worse. If
   * an inconclusive probe left the circuit open, a client sitting on a screen
   * that reads only cacheable tables (Feeds: subscriptions, folders) would never
   * produce the authoritative success needed to close it — every probe would be
   * inconclusive, and it would stay throttled to one request per cooldown long
   * after the backend recovered, with concurrent reads shed. That is a permanent
   * degradation caused by recovery, which is worse than the thing being guarded
   * against.
   *
   * Probation is what makes it safe. The risk of trusting a cache-served `200`
   * is that it closes the circuit mid-outage and lets the loop resume; with the
   * run pre-loaded, resuming costs exactly ONE request before the circuit slams
   * shut again, not another six. A cached success reopens the door a crack, and
   * any real failure closes it. An authoritative success clears the run properly.
   */
  settleInconclusive(ticket: RequestTicket): void {
    if (ticket !== this.generation) return; // stale — ignore
    if (this.state === 'half-open') {
      this.reset();
      // Reopen on the next failure alone, not the next burst...
      this.consecutiveFailures = this.failureThreshold - 1;
      // ...and admit one request at a time until something authoritative
      // confirms the recovery, so "one failure re-opens it" is a real bound
      // rather than one that a crowd of parked peers can outrun.
      this.probation = true;
      return;
    }
    // closed: free the slot if this was the probationary request, but leave
    // consecutiveFailures and probation untouched — a weak success is not
    // evidence, and letting one clear either would paper over a real failure run.
    this.endProbationaryRequest();
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
    // closed: a canceled request is neither a failure nor a success, so nothing
    // to record (and the generation is unchanged, so it's not invalidated here)
    // — but if it held the probationary slot it must still free it, or probation
    // would wedge with every peer parked behind a request that never reports.
    this.endProbationaryRequest();
  }

  /**
   * While a half-open probe is in flight, the promise it resolves on settlement;
   * `null` otherwise. A request shed because the probe is mid-flight awaits this
   * and re-decides afterward, so a healthy-but-slow probe doesn't leave its peer
   * reads errored (their retry budget can be shorter than the probe's latency).
   */
  probeWait(): Promise<void> | null {
    return this.state === 'half-open' || this.probationInFlight
      ? this.probeSettled
      : null;
  }

  /** Arm the gate peers park on while a serialized request is in flight. */
  private armProbeWait(): void {
    this.probeSettled = new Promise<void>((resolve) => {
      this.resolveProbeSettled = resolve;
    });
  }

  /** A serialized (probationary) request settled: free the slot and wake peers. */
  private endProbationaryRequest(): void {
    if (!this.probationInFlight) return;
    this.probationInFlight = false;
    this.releaseProbeWaiters();
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
    this.probation = false;
    this.probationInFlight = false;
    this.generation += 1; // invalidate in-flight tickets from the prior generation
    this.releaseProbeWaiters();
  }

  private reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.probation = false;
    this.probationInFlight = false;
    this.openedAt = 0;
    this.generation += 1; // post-recovery: pre-outage tickets are now stale
    this.releaseProbeWaiters();
  }
}
