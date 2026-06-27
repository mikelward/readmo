import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import {
  _resetNetworkStatusForTests,
  confirmBackendReachable,
  getConnectivityStatus,
  getOnline,
  reportFetchFailure,
  reportFetchSuccess,
  setConnectivityProbeUrl,
  subscribeConnectivityStatus,
  subscribeOnline,
  trackedFetch,
  type ConnectivityStatus,
} from './networkStatus';

function timeoutError() {
  return new DOMException('timed out', 'TimeoutError');
}

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

describe('networkStatus tracker', () => {
  beforeEach(() => {
    setNavigatorOnline(true);
    _resetNetworkStatusForTests();
  });
  afterEach(() => {
    setNavigatorOnline(true);
    _resetNetworkStatusForTests();
    vi.unstubAllGlobals();
  });

  describe('trackedFetch', () => {
    it('reports success on any response, even a 500 (reaching a server proves connectivity)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('oops', { status: 500 })),
      );
      await trackedFetch('/x');
      expect(getOnline()).toBe(true);
    });

    it('flips offline when fetch throws a TypeError, then back online on next success', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(trackedFetch('/x')).rejects.toBeInstanceOf(TypeError);
      expect(getOnline()).toBe(false);

      await trackedFetch('/y');
      expect(getOnline()).toBe(true);
    });

    it('flips offline for non-TypeError fetch failures used by browsers and native shells', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(
          new DOMException('The network connection was lost.', 'NetworkError'),
        )
        .mockRejectedValueOnce(new Error('Network request failed'));
      vi.stubGlobal('fetch', fetchMock);

      await expect(trackedFetch('/dom')).rejects.toBeInstanceOf(DOMException);
      expect(getOnline()).toBe(false);

      reportFetchSuccess();
      expect(getOnline()).toBe(true);

      await expect(trackedFetch('/native')).rejects.toThrow(
        /network request failed/i,
      );
      expect(getOnline()).toBe(false);
    });

    it('treats a timeout as offline when no reachability probe is configured', async () => {
      // Mock/unconfigured mode: no probe target, so a read timeout falls back
      // to the conservative legacy behavior.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw timeoutError();
        }),
      );

      await expect(trackedFetch('/x')).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      expect(getOnline()).toBe(false);
    });

    it('ignores AbortError — a superseded request is not a connectivity signal', async () => {
      const err = new DOMException('aborted', 'AbortError');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw err;
        }),
      );

      await expect(trackedFetch('/x')).rejects.toBe(err);
      expect(getOnline()).toBe(true);
    });

    it('notifies subscribers only on transitions', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const events: boolean[] = [];
      subscribeOnline((v) => events.push(v));

      await trackedFetch('/x').catch(() => undefined);
      await trackedFetch('/x').catch(() => undefined);
      await trackedFetch('/x');

      // Two identical "offline" fetches should emit one transition;
      // coming back online is the second.
      expect(events).toEqual([false, true]);
    });
  });

  describe('read-timeout reachability probe', () => {
    const PROBE = 'https://x.supabase.co/auth/v1/health';

    it('stays online when the probe reaches the backend (DB slow, not offline)', async () => {
      // The backend is up but the heavy read timed out; the lightweight probe
      // still answers, so we must NOT paint the Offline pill.
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      await reportFetchFailure(timeoutError());

      expect(getOnline()).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        PROBE,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('stays online even when the probe returns a 4xx/5xx (any response proves reachability)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
      setConnectivityProbeUrl(PROBE);

      await reportFetchFailure(timeoutError());

      expect(getOnline()).toBe(true);
    });

    it('flips offline only when the probe also fails (genuinely unreachable)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('Failed to fetch');
        }),
      );
      setConnectivityProbeUrl(PROBE);

      await reportFetchFailure(timeoutError());

      expect(getOnline()).toBe(false);
    });

    it('coalesces concurrent timeouts into a single probe', async () => {
      let resolve!: (r: Response) => void;
      const fetchMock = vi.fn(
        () => new Promise<Response>((r) => { resolve = r; }),
      );
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      const a = reportFetchFailure(timeoutError());
      const b = reportFetchFailure(timeoutError());
      resolve(new Response(null, { status: 200 }));
      await Promise.all([a, b]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getOnline()).toBe(true);
    });

    it('does not clobber a real success that lands while the probe is in flight', async () => {
      let rejectProbe!: (e: unknown) => void;
      const fetchMock = vi.fn(
        () => new Promise<Response>((_, rej) => { rejectProbe = rej; }),
      );
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      const probe = reportFetchFailure(timeoutError());
      // A different request succeeds before the probe settles.
      reportFetchSuccess();
      rejectProbe(new TypeError('Failed to fetch'));
      await probe;

      // The stale probe failure must not flip us offline.
      expect(getOnline()).toBe(true);
    });

    it('re-probes a timeout that arrives after a success while an earlier probe is in flight', async () => {
      // Probe 1 is held open. A success bumps the baseline, then a *new* timeout
      // arrives (a lie-fi outage that began after the success). When probe 1
      // ultimately fails, that post-success timeout must still flip us offline —
      // it must not be coalesced into, then suppressed by, the pre-success probe.
      let rejectProbe!: (e: unknown) => void;
      const fetchMock = vi.fn(
        () => new Promise<Response>((_, rej) => { rejectProbe = rej; }),
      );
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      const probe = reportFetchFailure(timeoutError()); // starts probe (baseline 0)
      reportFetchSuccess();                             // successSeq -> 1
      reportFetchFailure(timeoutError());               // post-success timeout, rebases to 1
      rejectProbe(new TypeError('Failed to fetch'));    // probe fails
      await probe;

      expect(fetchMock).toHaveBeenCalledTimes(1); // still a single coalesced probe
      expect(getOnline()).toBe(false);
    });

    it('recovers online when a post-offline timeout probe reaches the backend', async () => {
      // Already offline from a hard error. Connectivity returns but the DB is
      // slow, so the next read times out instead of succeeding — there's no real
      // success to fire reportFetchSuccess. The probe reaches the backend and
      // must clear the stuck Offline pill on its own.
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getOnline()).toBe(false);

      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
      await reportFetchFailure(timeoutError());

      expect(getOnline()).toBe(true);
    });

    it('does not probe for a hard network error — it flips offline immediately', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      reportFetchFailure(new TypeError('Failed to fetch'));

      expect(getOnline()).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('confirmBackendReachable (SW-bypassing liveness probe)', () => {
    const PROBE = 'https://x.supabase.co/auth/v1/health';

    it('returns true and reports success when the backend answers', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);
      // A cache-served read had (wrongly) marked us online; the probe confirms it.
      reportFetchSuccess();

      await expect(confirmBackendReachable()).resolves.toBe(true);
      expect(getOnline()).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        PROBE,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('returns true even on a 4xx/5xx — any response proves we reached the server', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
      setConnectivityProbeUrl(PROBE);

      await expect(confirmBackendReachable()).resolves.toBe(true);
      expect(getOnline()).toBe(true);
    });

    it('returns false and flips to backend-unreachable when the probe fails', async () => {
      // navigator.onLine stays true (lie-fi / backend down), so a failed probe is
      // a server problem, not the device's — status must be backend-unreachable.
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
      setConnectivityProbeUrl(PROBE);
      // Simulate the cache hit that wrongly marked us online first.
      reportFetchSuccess();
      expect(getOnline()).toBe(true);

      await expect(confirmBackendReachable()).resolves.toBe(false);
      expect(getConnectivityStatus()).toBe('backend-unreachable');
    });

    it('does not relatch when a stale probe failure settles after a newer probe succeeded', async () => {
      // Two recovery probes overlap (interval racing a focus/visibility probe).
      // Probe A is opened while the backend is still down and held pending;
      // probe B then reaches the now-recovered backend and clears the pill. A's
      // late rejection must NOT relatch "Down" over a backend that's back up.
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getConnectivityStatus()).toBe('backend-unreachable');

      let rejectA!: (e: unknown) => void;
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(
          () => new Promise<Response>((_, rej) => { rejectA = rej; }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const a = confirmBackendReachable(); // opened while down, held pending
      const b = confirmBackendReachable(); // reaches the recovered backend
      await expect(b).resolves.toBe(true);
      expect(getConnectivityStatus()).toBe('online');

      rejectA(new TypeError('Failed to fetch'));
      await expect(a).resolves.toBe(false);
      // A's failure is stale (a success landed since it started) → no relatch.
      expect(getConnectivityStatus()).toBe('online');
    });

    it('a cache-hit success does not suppress a real liveness-probe failure', async () => {
      // The probe exists precisely because a Workbox NetworkFirst cache hit can
      // lie about liveness. A general trackedFetch success (possibly cache-
      // served) landing while a liveness probe is in flight must NOT keep the
      // failed probe from flipping us offline — only a genuine SW-bypassing probe
      // success may. (Guard keys on livenessSeq, not successSeq.)
      setConnectivityProbeUrl(PROBE);
      reportFetchSuccess(); // start online
      expect(getConnectivityStatus()).toBe('online');

      let rejectProbe!: (e: unknown) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>((_, rej) => { rejectProbe = rej; })),
      );

      const probe = confirmBackendReachable(); // SW-bypassing, will fail
      // A cacheable GET resolves from the SW cache while the probe is pending —
      // a possibly-lying success, so it must not count as liveness evidence.
      reportFetchSuccess(/* cacheBypassing */ false);
      rejectProbe(new TypeError('Failed to fetch'));
      await expect(probe).resolves.toBe(false);

      // The lying cache hit must not have masked the dead backend.
      expect(getConnectivityStatus()).toBe('backend-unreachable');
    });

    it('a live cache-bypassing request success suppresses a stale probe failure', async () => {
      // The mirror of the cache-hit case: a genuine uncached request (a non-GET
      // — e.g. a set_item_state POST — which Workbox can't serve from cache) that
      // the backend accepts IS proof of reachability. If it lands while an older
      // probe is pending, that probe's late failure must not relatch "Down" over
      // a backend that just answered a live request.
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getConnectivityStatus()).toBe('backend-unreachable');

      let rejectProbe!: (e: unknown) => void;
      const fetchMock = vi
        .fn()
        // First call is the probe (held open, then rejected).
        .mockImplementationOnce(
          () => new Promise<Response>((_, rej) => { rejectProbe = rej; }),
        )
        // Second is the live write that reaches the backend.
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const probe = confirmBackendReachable(); // opened while down, held pending
      await trackedFetch('https://x.supabase.co/rest/v1/rpc/set_item_state', {
        method: 'POST',
      });
      expect(getConnectivityStatus()).toBe('online');

      rejectProbe(new TypeError('Failed to fetch'));
      await expect(probe).resolves.toBe(false);
      // The accepted live write is liveness proof → no stale relatch.
      expect(getConnectivityStatus()).toBe('online');
    });

    it('returns true without fetching when no probe URL is configured (mock mode)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      // setConnectivityProbeUrl not called → probeUrl is null after reset.

      await expect(confirmBackendReachable()).resolves.toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('combined browser + fetch signals', () => {
    it('stays offline while the browser reports offline even if fetches succeed (SW cache hit)', () => {
      // Simulate the browser going offline first.
      window.dispatchEvent(new Event('offline'));
      expect(getOnline()).toBe(false);

      // The SW serves a cached response, so trackedFetch reports success.
      reportFetchSuccess();

      // Combined should still be offline — browser hasn't agreed yet.
      expect(getOnline()).toBe(false);
    });

    it('stays offline while fetches keep failing even if the browser claims online (stuck navigator.onLine)', () => {
      // This is the tunnel case: navigator.onLine is still true but
      // real requests are failing.
      expect(getOnline()).toBe(true);
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getOnline()).toBe(false);

      // Spurious 'online' event from the browser — meaningless while
      // real fetches keep failing.
      window.dispatchEvent(new Event('online'));
      expect(getOnline()).toBe(false);
    });

    it('only returns online when both signals agree', () => {
      // Break both signals.
      window.dispatchEvent(new Event('offline'));
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getOnline()).toBe(false);

      // Browser alone coming back isn't enough.
      window.dispatchEvent(new Event('online'));
      expect(getOnline()).toBe(false);

      // Fetch recovering too — now both agree.
      reportFetchSuccess();
      expect(getOnline()).toBe(true);
    });

    it('emits only when the combined value actually changes', () => {
      const events: boolean[] = [];
      subscribeOnline((v) => events.push(v));

      // Browser goes offline: combined flips to false.
      window.dispatchEvent(new Event('offline'));
      // Fetch also fails — still offline, no emit.
      reportFetchFailure(new TypeError('Failed to fetch'));
      // Browser comes back — fetch still broken, still offline, no emit.
      window.dispatchEvent(new Event('online'));
      // Fetch recovers — combined flips to true.
      reportFetchSuccess();

      expect(events).toEqual([false, true]);
    });
  });

  describe('backend-unreachable self-healing recovery probe', () => {
    const PROBE = 'https://x.supabase.co/auth/v1/health';
    // Matches RECOVERY_PROBE_INTERVAL_MS in networkStatus.ts (not exported).
    const RECOVERY_INTERVAL_MS = 30_000;

    it('self-heals a latched backend-unreachable when a recovery probe reaches the backend', async () => {
      vi.useFakeTimers();
      try {
        setConnectivityProbeUrl(PROBE);
        // Latch to backend-unreachable via a hard failure (device stays online).
        reportFetchFailure(new TypeError('Failed to fetch'));
        expect(getConnectivityStatus()).toBe('backend-unreachable');

        // The backend recovers; the next interval probe reaches it. No app read
        // fires here — recovery must come from the timer alone.
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => new Response(null, { status: 200 })),
        );
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);

        expect(getConnectivityStatus()).toBe('online');
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops probing once recovered (the timer is cleared on the online transition)', async () => {
      vi.useFakeTimers();
      try {
        setConnectivityProbeUrl(PROBE);
        reportFetchFailure(new TypeError('Failed to fetch'));
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
        expect(getConnectivityStatus()).toBe('online');
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // No further probes once we're back online.
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS * 3);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps re-probing each interval and concludes offline after sustained probe failure', async () => {
      // The recovery probe hits the always-up health endpoint; if it keeps
      // failing (no HTTP response at all), the device — not the backend — is the
      // problem, so after enough consecutive failures we surface "Offline"
      // instead of sitting on "Down" while navigator.onLine lags.
      vi.useFakeTimers();
      try {
        setConnectivityProbeUrl(PROBE);
        reportFetchFailure(new TypeError('Failed to fetch'));
        const fetchMock = vi.fn(async () => {
          throw new TypeError('Failed to fetch');
        });
        vi.stubGlobal('fetch', fetchMock);

        // First recovery probe fails: one data point, still "Down".
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
        expect(getConnectivityStatus()).toBe('backend-unreachable');

        // Second consecutive failure: we can't reach the network → "Offline".
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
        expect(getConnectivityStatus()).toBe('offline');
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // The timer keeps running even after concluding offline (navigator still
        // claims a connection), so recovery is still noticed.
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
        expect(fetchMock).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('recovers to online when the backend comes back after being declared offline', async () => {
      vi.useFakeTimers();
      try {
        setConnectivityProbeUrl(PROBE);
        reportFetchFailure(new TypeError('Failed to fetch'));
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        // Two failures → offline.
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
        expect(getConnectivityStatus()).toBe('offline');

        // Network returns: the next probe reaches the backend and clears it,
        // without waiting on navigator.onLine.
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
        expect(getConnectivityStatus()).toBe('online');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not start a recovery timer for a device-offline state', async () => {
      vi.useFakeTimers();
      try {
        setConnectivityProbeUrl(PROBE);
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        // Device itself offline: the actionable fix is the user's, not a re-probe.
        setNavigatorOnline(false);
        window.dispatchEvent(new Event('offline'));
        expect(getConnectivityStatus()).toBe('offline');

        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS * 2);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-probes immediately on regained window focus while latched down', async () => {
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getConnectivityStatus()).toBe('backend-unreachable');

      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      window.dispatchEvent(new Event('focus'));
      await vi.waitFor(() => expect(getConnectivityStatus()).toBe('online'));
      expect(fetchMock).toHaveBeenCalledWith(
        PROBE,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('does not probe on focus when not latched down', () => {
      setConnectivityProbeUrl(PROBE);
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      // Online: a focus event must not fire a needless probe.
      window.dispatchEvent(new Event('focus'));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not let a cache hit clear the pill while down, and keeps probing', async () => {
      // A Workbox cache hit (reportFetchSuccess(false)) proves nothing about
      // liveness. While awaiting confirmation it must NOT clear the pill — that
      // was the "Down ↔ online" flap. The recovery probe keeps running and
      // re-confirms Down.
      vi.useFakeTimers();
      try {
        setConnectivityProbeUrl(PROBE);
        reportFetchFailure(new TypeError('Failed to fetch'));
        expect(getConnectivityStatus()).toBe('backend-unreachable');

        // Cache-served GET no longer flips us back online.
        reportFetchSuccess(/* cacheBypassing */ false);
        expect(getConnectivityStatus()).toBe('backend-unreachable');

        const fetchMock = vi.fn(async () => {
          throw new TypeError('Failed to fetch');
        });
        vi.stubGlobal('fetch', fetchMock);
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getConnectivityStatus()).toBe('backend-unreachable');
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops probing once a recovery probe confirms liveness', async () => {
      vi.useFakeTimers();
      try {
        setConnectivityProbeUrl(PROBE);
        reportFetchFailure(new TypeError('Failed to fetch'));
        expect(getConnectivityStatus()).toBe('backend-unreachable');

        // The backend is genuinely back: the next probe confirms liveness (a
        // cache-bypassing success) and the timer stands down.
        const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
        expect(getConnectivityStatus()).toBe('online');
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS * 3);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-probes on focus while latched down (a cache hit cannot clear it)', async () => {
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(new TypeError('Failed to fetch'));
      // A cache hit can't clear the pill anymore...
      reportFetchSuccess(/* cacheBypassing */ false);
      expect(getConnectivityStatus()).toBe('backend-unreachable');

      // ...but focus still re-probes (keys on awaiting-liveness); a reachable
      // probe recovers us.
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      window.dispatchEvent(new Event('focus'));
      await vi.waitFor(() => expect(getConnectivityStatus()).toBe('online'));
      expect(fetchMock).toHaveBeenCalledWith(
        PROBE,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('stops flapping back online on cache hits the instant we go down', async () => {
      // The user-visible bug: while genuinely offline, a Workbox cache hit
      // (reportFetchSuccess(false)) kept flipping the pill to "online", so it
      // bounced "Down" ↔ "online". The suppression keys on awaiting-liveness, so
      // it takes effect immediately on goOffline — no window before the first
      // probe. Only a cache-bypassing success may clear the down state.
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getConnectivityStatus()).toBe('backend-unreachable');

      // Cache hits cannot flap us back online — even before any probe has run.
      reportFetchSuccess(/* cacheBypassing */ false);
      reportFetchSuccess(/* cacheBypassing */ false);
      expect(getOnline()).toBe(false);
      expect(getConnectivityStatus()).toBe('backend-unreachable');

      // A genuine cache-bypassing success (e.g. an accepted non-GET) does clear it.
      reportFetchSuccess(/* cacheBypassing */ true);
      expect(getConnectivityStatus()).toBe('online');
    });

    it('counts only one offline step per instant when probes overlap on a tab return', async () => {
      // focus + visibilitychange can both fire on one tab return, and empty-read
      // confirmations can overlap. Those opportunistic probes must not each
      // advance the consecutive-failure counter, or two from one instant would
      // falsely declare "Offline" without sustained evidence. Only the serial
      // recovery-timer probe counts.
      setConnectivityProbeUrl(PROBE);
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
      reportFetchFailure(new TypeError('Failed to fetch'));

      // Two overlapping opportunistic probes both fail...
      await Promise.all([confirmBackendReachable(), confirmBackendReachable()]);
      // ...but the status is still only backend-unreachable, not offline.
      expect(getConnectivityStatus()).toBe('backend-unreachable');
    });
  });

  describe('three-way connectivity status', () => {
    it('reports backend-unreachable when a fetch fails but the device is online', () => {
      // navigator.onLine stays true (beforeEach): a hard fetch failure flips the
      // fetch signal only, so it's our backend that is down — not the device.
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getConnectivityStatus()).toBe('backend-unreachable');
      // The legacy boolean still reads "not online" so query pausing is unchanged.
      expect(getOnline()).toBe(false);
    });

    it('reports offline when the device itself has no network', () => {
      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
      expect(getConnectivityStatus()).toBe('offline');
    });

    it('lets the device-offline signal win over a fetch failure', () => {
      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
      reportFetchFailure(new TypeError('Failed to fetch'));
      // Both signals are down; "find a connection" is the actionable fix.
      expect(getConnectivityStatus()).toBe('offline');
    });

    it('notifies status subscribers on the offline <-> backend-unreachable transition the boolean hides', () => {
      const statusEvents: ConnectivityStatus[] = [];
      const boolEvents: boolean[] = [];
      subscribeConnectivityStatus((s) => statusEvents.push(s));
      subscribeOnline((v) => boolEvents.push(v));

      // online -> backend-unreachable (device still claims a connection)
      reportFetchFailure(new TypeError('Failed to fetch'));
      // backend-unreachable -> offline (the OS finally reports no network)
      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));

      // The status channel sees both edges; the boolean only the online->false one.
      expect(statusEvents).toEqual(['backend-unreachable', 'offline']);
      expect(boolEvents).toEqual([false]);
    });

    it('returns to online once both the device and backend agree', () => {
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getConnectivityStatus()).toBe('backend-unreachable');
      reportFetchSuccess();
      expect(getConnectivityStatus()).toBe('online');
    });
  });

  describe('React Query onlineManager sync', () => {
    it('does NOT toggle onlineManager on a backend-unreachable blip', () => {
      // The regression this guards: a self-imposed read timeout flips us to
      // 'backend-unreachable'; if that toggled onlineManager off then on, the
      // recovery edge would fire refetch-on-reconnect and re-issue the whole
      // boot read burst, re-saturating the DB connection pool in a ~10s loop.
      const setOnline = vi.spyOn(onlineManager, 'setOnline');

      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getConnectivityStatus()).toBe('backend-unreachable');
      expect(getOnline()).toBe(false); // pill shows "Down"…
      expect(onlineManager.isOnline()).toBe(true); // …but RQ stays online

      reportFetchSuccess();
      expect(getConnectivityStatus()).toBe('online');
      // Never toggled across the down→up cycle → no refetch-on-reconnect storm.
      expect(setOnline).not.toHaveBeenCalled();
      setOnline.mockRestore();
    });

    it('drives onlineManager offline only on genuine device offline', () => {
      const setOnline = vi.spyOn(onlineManager, 'setOnline');

      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
      expect(getConnectivityStatus()).toBe('offline');
      expect(onlineManager.isOnline()).toBe(false);
      expect(setOnline).toHaveBeenCalledWith(false);

      setNavigatorOnline(true);
      window.dispatchEvent(new Event('online'));
      expect(getConnectivityStatus()).toBe('online');
      expect(onlineManager.isOnline()).toBe(true);
      expect(setOnline).toHaveBeenLastCalledWith(true);
      setOnline.mockRestore();
    });
  });
});
