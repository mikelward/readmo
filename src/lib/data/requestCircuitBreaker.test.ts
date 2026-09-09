import { describe, it, expect } from 'vitest';
import { RequestCircuitBreaker } from './requestCircuitBreaker';

/** A breaker with a controllable clock for deterministic tests. */
function makeBreaker(overrides = {}) {
  const clock = { t: 0 };
  const breaker = new RequestCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 5_000,
    now: () => clock.t,
    ...overrides,
  });
  return { breaker, clock };
}

/** Admit a request and assert it wasn't shed; return its ticket. */
function admit(breaker: RequestCircuitBreaker): number {
  const ticket = breaker.shouldAllow();
  expect(ticket).not.toBeNull();
  return ticket as number;
}

describe('RequestCircuitBreaker — normal operation', () => {
  it('allows healthy requests indefinitely and stays closed (no rate ceiling)', () => {
    const { breaker } = makeBreaker();
    // Far more than any rate ceiling would have allowed — a legitimate bulk
    // burst (e.g. offline warmup) must never trip the breaker.
    for (let i = 0; i < 500; i++) breaker.settle(admit(breaker), true);
    expect(breaker.getState()).toBe('closed');
  });
});

describe('RequestCircuitBreaker — failure trip + recovery', () => {
  it('opens after N consecutive failures and sheds while cooling down', () => {
    const { breaker } = makeBreaker(); // failureThreshold 3
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    expect(breaker.getState()).toBe('open');
    expect(breaker.shouldAllow()).toBeNull();
  });

  it('a success resets the consecutive-failure count', () => {
    const { breaker } = makeBreaker();
    breaker.settle(admit(breaker), false);
    breaker.settle(admit(breaker), false);
    breaker.settle(admit(breaker), true); // reset
    breaker.settle(admit(breaker), false);
    expect(breaker.getState()).toBe('closed'); // only 1 failure since the reset
  });

  it('admits one half-open probe after cooldown and closes on success', () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    expect(breaker.shouldAllow()).toBeNull(); // still cooling down

    clock.t += 5_000; // cooldown elapses
    const probe = admit(breaker); // the single probe
    expect(breaker.getState()).toBe('half-open');
    expect(breaker.shouldAllow()).toBeNull(); // only one probe at a time
    breaker.settle(probe, true); // probe succeeds → closed
    expect(breaker.getState()).toBe('closed');
    expect(breaker.shouldAllow()).not.toBeNull();
  });

  it('half-open probe re-opens on failure', () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    clock.t += 5_000;
    breaker.settle(admit(breaker), false); // probe fails → re-open
    expect(breaker.getState()).toBe('open');
    expect(breaker.shouldAllow()).toBeNull();
  });
});

describe('RequestCircuitBreaker — stale in-flight requests (generations)', () => {
  it('a stale request resolving during half-open does NOT flip the breaker', () => {
    const { breaker, clock } = makeBreaker();
    // A long uncapped request admitted while closed, still in flight…
    const stale = admit(breaker);
    // …the breaker trips from other failures…
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    expect(breaker.getState()).toBe('open');
    // …cooldown elapses and a real probe is admitted…
    clock.t += 5_000;
    const probe = admit(breaker);
    expect(breaker.getState()).toBe('half-open');

    // The stale request finally resolves SUCCESS — not the probe, must not close.
    breaker.settle(stale, true);
    expect(breaker.getState()).toBe('half-open');

    breaker.settle(probe, true); // only the real probe drives the transition
    expect(breaker.getState()).toBe('closed');
  });

  it('stale failures after recovery do NOT re-open the closed breaker', () => {
    const { breaker, clock } = makeBreaker(); // failureThreshold 3
    // Several long uncapped requests admitted before the outage, still in flight.
    const staleA = admit(breaker);
    const staleB = admit(breaker);
    const staleC = admit(breaker);
    // The breaker trips, cools down, and a probe recovers it to closed.
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    clock.t += 5_000;
    breaker.settle(admit(breaker), true); // probe succeeds → closed
    expect(breaker.getState()).toBe('closed');

    // The pre-outage requests now all FAIL after recovery. With generations they
    // are stale (admitted before the transitions) and ignored — they must not
    // re-open the circuit and shed healthy new reads.
    breaker.settle(staleA, false);
    breaker.settle(staleB, false);
    breaker.settle(staleC, false);
    expect(breaker.getState()).toBe('closed');
  });
});

describe('RequestCircuitBreaker — canceled requests', () => {
  it('settleCanceled is a no-op when closed (not a failure)', () => {
    const { breaker } = makeBreaker(); // failureThreshold 3
    breaker.settle(admit(breaker), false); // 1 failure
    breaker.settleCanceled(admit(breaker)); // neither success nor failure
    breaker.settle(admit(breaker), false); // 2 failures — still under threshold
    expect(breaker.getState()).toBe('closed');
  });

  it('a canceled half-open probe re-arms instead of getting stuck (deadlock fix)', () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    expect(breaker.getState()).toBe('open');
    clock.t += 5_000; // cooldown elapses
    const probe = admit(breaker);
    expect(breaker.getState()).toBe('half-open');

    breaker.settleCanceled(probe); // probe canceled before it could report
    // Must NOT be stuck half-open shedding everything — the next request probes.
    const probe2 = admit(breaker);
    expect(breaker.getState()).toBe('half-open');
    breaker.settle(probe2, true); // a real success finally closes it
    expect(breaker.getState()).toBe('closed');
    expect(breaker.shouldAllow()).not.toBeNull();
  });

  it('releases parked peers when the probe is canceled (they re-decide, not hang)', async () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    clock.t += 5_000;
    const probe = admit(breaker);
    const wait = breaker.probeWait();
    expect(wait).not.toBeNull();
    breaker.settleCanceled(probe); // probe canceled → re-arm
    await wait; // must resolve so a parked peer doesn't hang forever
    expect(breaker.probeWait()).toBeNull(); // re-armed to open, no probe in flight
  });

  it('a canceled stale request does not re-arm the probe', () => {
    const { breaker, clock } = makeBreaker();
    const stale = admit(breaker);
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    clock.t += 5_000;
    admit(breaker); // probe in flight (half-open)
    breaker.settleCanceled(stale); // stale cancel — not the current generation
    expect(breaker.shouldAllow()).toBeNull(); // probe slot still occupied
    expect(breaker.getState()).toBe('half-open');
  });
});

describe('RequestCircuitBreaker — half-open peers wait for the probe', () => {
  it('probeWait is null unless a probe is in flight', () => {
    const { breaker } = makeBreaker();
    expect(breaker.probeWait()).toBeNull(); // closed
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    expect(breaker.probeWait()).toBeNull(); // open (cooling down)
  });

  it('parks a peer on probeWait() and releases it once the probe closes the circuit', async () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    clock.t += 5_000;
    const probe = admit(breaker); // half-open
    expect(breaker.shouldAllow()).toBeNull(); // a peer is not admitted…
    const wait = breaker.probeWait();
    expect(wait).not.toBeNull(); // …but gets a wait handle instead of failing

    let released = false;
    void wait!.then(() => {
      released = true;
    });
    breaker.settle(probe, true); // probe succeeds → close
    await wait;
    expect(released).toBe(true);
    expect(breaker.getState()).toBe('closed');
    expect(breaker.shouldAllow()).not.toBeNull(); // the parked peer can now proceed
  });

  it('releases parked peers when the probe re-opens the circuit', async () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    clock.t += 5_000;
    const probe = admit(breaker);
    const wait = breaker.probeWait();
    breaker.settle(probe, false); // probe fails → re-open
    await wait; // resolves so peers don't hang
    expect(breaker.getState()).toBe('open');
    expect(breaker.probeWait()).toBeNull(); // a peer would now be shed, not parked
  });
});

describe('RequestCircuitBreaker — inconclusive success (cache-served reads)', () => {
  it('does not clear a failure run while closed', () => {
    // A NetworkFirst read answered from the service-worker cache returns 200
    // without the backend being involved, so it is not evidence of health. If it
    // cleared the run, a cached read interleaved with real failures would hold
    // the circuit closed through an entire outage.
    const { breaker } = makeBreaker(); // failureThreshold 3
    breaker.settle(admit(breaker), false);
    breaker.settle(admit(breaker), false);
    breaker.settleInconclusive(admit(breaker)); // must NOT reset the run
    breaker.settle(admit(breaker), false); // third real failure
    expect(breaker.getState()).toBe('open');
  });

  it('closes as the half-open probe, but on probation', () => {
    // It closes on weak evidence deliberately (see the method comment): refusing
    // to would strand a client that only reads cacheable tables. Probation is the
    // safety — the failure run is left one short, so if the backend is in fact
    // still down, the loop resumes for exactly ONE request.
    const { breaker, clock } = makeBreaker(); // failureThreshold 3
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    clock.t += 5_000;
    breaker.settleInconclusive(admit(breaker)); // probe, cache-served 200
    expect(breaker.getState()).toBe('closed');

    // One failure — not another burst of three — puts it straight back.
    breaker.settle(admit(breaker), false);
    expect(breaker.getState()).toBe('open');
  });

  it('lets an authoritative success clear the probation', () => {
    // The other half: if the backend really did recover, the next real read
    // proves it and the breaker returns to a full failure budget rather than
    // sitting one failure away from tripping forever.
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    clock.t += 5_000;
    breaker.settleInconclusive(admit(breaker)); // closed, on probation
    breaker.settle(admit(breaker), true); // authoritative success clears the run

    // Back to a full budget: two failures no longer suffice.
    breaker.settle(admit(breaker), false);
    breaker.settle(admit(breaker), false);
    expect(breaker.getState()).toBe('closed');
  });

  it('serializes admission while on probation', () => {
    // Closing the circuit is what releases the peers parked on probeWait(). If
    // probation merely pre-loaded the failure count, they would ALL be admitted
    // in the same tick and reach a still-failing backend together — only the
    // first returning failure re-opens, and the rest are already in flight. So
    // "one failure re-opens it" has to be backed by "one request at a time".
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    clock.t += 5_000;
    breaker.settleInconclusive(admit(breaker)); // closed, on probation
    expect(breaker.getState()).toBe('closed');

    admit(breaker); // the one probationary request…
    expect(breaker.shouldAllow()).toBeNull(); // …and the crowd waits behind it
    expect(breaker.probeWait()).not.toBeNull(); // parked, not failed
  });

  it('frees the probationary slot when its request is canceled', () => {
    // Otherwise probation wedges: every peer parked behind a request that will
    // never report, which is the deadlock settleCanceled already exists to stop.
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    clock.t += 5_000;
    breaker.settleInconclusive(admit(breaker));
    const inFlight = admit(breaker);
    expect(breaker.shouldAllow()).toBeNull();

    breaker.settleCanceled(inFlight);
    expect(breaker.shouldAllow()).not.toBeNull(); // slot freed, traffic moves
  });

  it('releases parked peers as each probationary request settles', async () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    clock.t += 5_000;
    breaker.settleInconclusive(admit(breaker));
    const inFlight = admit(breaker);
    const wait = breaker.probeWait();
    expect(wait).not.toBeNull();

    breaker.settleInconclusive(inFlight); // another weak success
    await wait; // must resolve, or a parked peer hangs forever
    expect(breaker.getState()).toBe('closed');
  });

  it('an authoritative success ends probation and restores parallelism', () => {
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    clock.t += 5_000;
    breaker.settleInconclusive(admit(breaker));
    breaker.settle(admit(breaker), true); // the backend itself answered

    // No longer serialized — concurrent reads are admitted together again.
    admit(breaker);
    expect(breaker.shouldAllow()).not.toBeNull();
  });

  it('recovers a client that only ever sees cacheable reads', () => {
    // The failure Codex caught in review: with nothing authoritative ever
    // arriving, an inconclusive probe that left the circuit open would throttle
    // this client to one request per cooldown FOREVER, long after the backend
    // came back — a permanent degradation caused by recovery.
    const { breaker, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false);
    clock.t += 5_000;
    breaker.settleInconclusive(admit(breaker)); // the backend is back
    expect(breaker.getState()).toBe('closed');

    // And it STAYS closed under continuing cache-served traffic — no
    // re-throttling, no shedding of concurrent reads.
    for (let i = 0; i < 20; i++) breaker.settleInconclusive(admit(breaker));
    expect(breaker.getState()).toBe('closed');
  });

  it('is ignored when its ticket is stale', () => {
    const { breaker, clock } = makeBreaker();
    const stale = admit(breaker); // admitted in the closed generation
    for (let i = 0; i < 3; i++) breaker.settle(admit(breaker), false); // trips
    clock.t += 5_000;
    const probe = admit(breaker);
    breaker.settleInconclusive(stale); // pre-outage read landing late
    // The stale settle must not have returned the probe slot: the probe is still
    // the one in flight, and settling IT is what moves the breaker.
    breaker.settle(probe, true);
    expect(breaker.getState()).toBe('closed');
  });
});
