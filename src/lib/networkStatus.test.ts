import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetNetworkStatusForTests,
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
});
