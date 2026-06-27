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
