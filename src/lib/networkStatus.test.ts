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
    it('stays online on a response below 500 (reaching a healthy server)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('ok', { status: 200 })),
      );
      await trackedFetch('/x');
      expect(getConnectivityStatus()).toBe('online');
    });

    it('treats a 4xx (e.g. auth 401) as online — the backend is serving', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('no', { status: 401 })),
      );
      await trackedFetch('/x');
      expect(getConnectivityStatus()).toBe('online');
    });

    it('reports "Down" (backend-unreachable) on a 5xx — reachable but erroring', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('oops', { status: 503 })),
      );
      await trackedFetch('/rest/v1/x');
      expect(getConnectivityStatus()).toBe('backend-unreachable');
      // Not "online", so the boolean signal reads not-online.
      expect(getOnline()).toBe(false);
    });

    it('backs off when Down: queries are paused, never retry-stormed at the failing backend', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
      setConnectivityProbeUrl('https://x.supabase.co/auth/v1/health');
      await trackedFetch('/rest/v1/x');
      expect(getConnectivityStatus()).toBe('backend-unreachable');
      // onlineManager is paused (false) so React Query stops firing reads — exactly
      // the back-off a struggling backend needs.
      expect(onlineManager.isOnline()).toBe(false);
    });

    it('recovers from Down as soon as a core read returns below 500', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await trackedFetch('/rest/v1/x');
      expect(getConnectivityStatus()).toBe('backend-unreachable');
      await trackedFetch('/rest/v1/x');
      expect(getConnectivityStatus()).toBe('online');
    });

    it('a 5xx from a non-core Edge Function does not shed the app (no global Down)', async () => {
      setConnectivityProbeUrl('https://x.supabase.co/auth/v1/health');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
      // A failing summary/full-text/discover/refresh call answers 5xx, but that's
      // the caller's to degrade — it must not pause reads app-wide.
      await trackedFetch('https://x.supabase.co/functions/v1/summary', {
        method: 'POST',
      });
      expect(getConnectivityStatus()).toBe('online');
      expect(onlineManager.isOnline()).toBe(true);
    });

    it('keeps the recovery probe alive when a non-core success lands during Down', async () => {
      vi.useFakeTimers();
      try {
        setConnectivityProbeUrl('https://x.supabase.co/auth/v1/health');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
        await trackedFetch('/rest/v1/x'); // core 5xx → Down
        expect(getConnectivityStatus()).toBe('backend-unreachable');

        // A non-core function POST succeeds: proves reachability but isn't a core
        // read recovering, so we stay Down — and the probe must keep running (a
        // cache-bypassing success clears awaitingLiveness, but backendErroring
        // keeps the probe alive).
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
        await trackedFetch('https://x.supabase.co/functions/v1/summary', {
          method: 'POST',
        });
        expect(getConnectivityStatus()).toBe('backend-unreachable');

        // The still-running probe reaches the health endpoint and recovers us.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getConnectivityStatus()).toBe('online');
      } finally {
        vi.useRealTimers();
      }
    });

    it('a stale cached GET 200 does not clear a 5xx "Down" — only a cache-bypassing success does', async () => {
      setConnectivityProbeUrl('https://x.supabase.co/auth/v1/health');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
      await trackedFetch('/rest/v1/x'); // live 5xx → Down
      expect(getConnectivityStatus()).toBe('backend-unreachable');
      expect(onlineManager.isOnline()).toBe(false); // backed off

      // A cacheable GET resolves 200 — possibly a stale Workbox cache hit, which
      // can't prove the backend recovered. It must NOT unpause us.
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      await trackedFetch('/rest/v1/x');
      expect(getConnectivityStatus()).toBe('backend-unreachable');
      expect(onlineManager.isOnline()).toBe(false);

      // A non-GET the backend accepts IS cache-bypassing proof → clears Down.
      await trackedFetch('/rest/v1/rpc/set_item_state', { method: 'POST' });
      expect(getConnectivityStatus()).toBe('online');
      expect(onlineManager.isOnline()).toBe(true);
    });

    it('flips OFFLINE (not Down) when a fetch throws a TypeError, then back online on next success', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(trackedFetch('/x')).rejects.toBeInstanceOf(TypeError);
      // A throw is no response — we can't reach our backend → Offline, immediately.
      expect(getConnectivityStatus()).toBe('offline');

      await trackedFetch('/y');
      expect(getConnectivityStatus()).toBe('online');
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
      expect(getConnectivityStatus()).toBe('offline');

      reportFetchSuccess();
      expect(getOnline()).toBe(true);

      await expect(trackedFetch('/native')).rejects.toThrow(
        /network request failed/i,
      );
      expect(getOnline()).toBe(false);
    });

    it('treats a timeout as offline when no reachability probe is configured', async () => {
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

      expect(events).toEqual([false, true]);
    });
  });

  describe('read-timeout reachability probe', () => {
    const PROBE = 'https://x.supabase.co/auth/v1/health';

    it('stays online when the probe reaches the backend (DB slow, not offline)', async () => {
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
      expect(getConnectivityStatus()).toBe('offline');
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
      reportFetchSuccess();
      rejectProbe(new TypeError('Failed to fetch'));
      await probe;

      expect(getOnline()).toBe(true);
    });

    it('re-probes a timeout that arrives after a success while an earlier probe is in flight', async () => {
      let rejectProbe!: (e: unknown) => void;
      const fetchMock = vi.fn(
        () => new Promise<Response>((_, rej) => { rejectProbe = rej; }),
      );
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      const probe = reportFetchFailure(timeoutError());
      reportFetchSuccess();
      reportFetchFailure(timeoutError());
      rejectProbe(new TypeError('Failed to fetch'));
      await probe;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getOnline()).toBe(false);
    });

    it('a 5xx landing during an in-flight timeout probe keeps us Down, not flipped Offline', async () => {
      // A timeout starts a probe (held pending). Before it rejects, another read
      // gets a 5xx → Down. The stale timeout probe's failure must NOT relabel the
      // reachable-but-erroring backend as Offline — the 5xx counts as reachability.
      setConnectivityProbeUrl(PROBE);
      let rejectProbe!: (e: unknown) => void;
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(
          () => new Promise<Response>((_, rej) => { rejectProbe = rej; }),
        ) // the timeout's probe — held open
        .mockResolvedValueOnce(new Response(null, { status: 500 })); // the 5xx read
      vi.stubGlobal('fetch', fetchMock);

      const probe = reportFetchFailure(timeoutError()); // starts probe (baseline = successSeq)
      await trackedFetch('/rest/v1/x'); // 5xx → Down (advances successSeq)
      expect(getConnectivityStatus()).toBe('backend-unreachable');

      rejectProbe(new TypeError('Failed to fetch'));
      await probe;

      expect(getConnectivityStatus()).toBe('backend-unreachable');
    });

    it('recovers online when a post-offline timeout probe reaches the backend', async () => {
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getOnline()).toBe(false);

      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
      await reportFetchFailure(timeoutError());

      expect(getOnline()).toBe(true);
    });

    it('a hard network error flips Offline immediately without a synchronous probe', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);

      reportFetchFailure(new TypeError('Failed to fetch'));

      expect(getConnectivityStatus()).toBe('offline');
      // goOffline arms the recovery timer but does not fire a probe synchronously.
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('confirmBackendReachable (SW-bypassing liveness probe)', () => {
    const PROBE = 'https://x.supabase.co/auth/v1/health';

    it('returns true and reports success when the backend answers', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      setConnectivityProbeUrl(PROBE);
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

    it('returns false and flips to Offline when the probe fails', async () => {
      // navigator.onLine stays true, but we can't even reach the always-up health
      // endpoint → we can't reach our backend at all → Offline (not Down).
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
      setConnectivityProbeUrl(PROBE);
      reportFetchSuccess();
      expect(getOnline()).toBe(true);

      await expect(confirmBackendReachable()).resolves.toBe(false);
      expect(getConnectivityStatus()).toBe('offline');
    });

    it('does not relatch when a stale probe failure settles after a newer probe succeeded', async () => {
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getConnectivityStatus()).toBe('offline');

      let rejectA!: (e: unknown) => void;
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(
          () => new Promise<Response>((_, rej) => { rejectA = rej; }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const a = confirmBackendReachable();
      const b = confirmBackendReachable();
      await expect(b).resolves.toBe(true);
      expect(getConnectivityStatus()).toBe('online');

      rejectA(new TypeError('Failed to fetch'));
      await expect(a).resolves.toBe(false);
      expect(getConnectivityStatus()).toBe('online');
    });

    it('a cache-hit success does not suppress a real liveness-probe failure', async () => {
      setConnectivityProbeUrl(PROBE);
      reportFetchSuccess();
      expect(getConnectivityStatus()).toBe('online');

      let rejectProbe!: (e: unknown) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>((_, rej) => { rejectProbe = rej; })),
      );

      const probe = confirmBackendReachable();
      reportFetchSuccess(/* cacheBypassing */ false);
      rejectProbe(new TypeError('Failed to fetch'));
      await expect(probe).resolves.toBe(false);

      // The lying cache hit must not have masked the unreachable backend.
      expect(getConnectivityStatus()).toBe('offline');
    });

    it('a live cache-bypassing request success suppresses a stale probe failure', async () => {
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getConnectivityStatus()).toBe('offline');

      let rejectProbe!: (e: unknown) => void;
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(
          () => new Promise<Response>((_, rej) => { rejectProbe = rej; }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const probe = confirmBackendReachable();
      await trackedFetch('https://x.supabase.co/rest/v1/rpc/set_item_state', {
        method: 'POST',
      });
      expect(getConnectivityStatus()).toBe('online');

      rejectProbe(new TypeError('Failed to fetch'));
      await expect(probe).resolves.toBe(false);
      expect(getConnectivityStatus()).toBe('online');
    });

    it('returns true without fetching when no probe URL is configured (mock mode)', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(confirmBackendReachable()).resolves.toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('combined browser + fetch signals', () => {
    it('stays offline while the browser reports offline even if fetches succeed (SW cache hit)', () => {
      window.dispatchEvent(new Event('offline'));
      expect(getOnline()).toBe(false);

      reportFetchSuccess();

      expect(getOnline()).toBe(false);
    });

    it('stays offline while fetches keep failing even if the browser claims online (stuck navigator.onLine)', () => {
      expect(getOnline()).toBe(true);
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getOnline()).toBe(false);

      window.dispatchEvent(new Event('online'));
      expect(getOnline()).toBe(false);
    });

    it('only returns online when both signals agree', () => {
      window.dispatchEvent(new Event('offline'));
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getOnline()).toBe(false);

      window.dispatchEvent(new Event('online'));
      expect(getOnline()).toBe(false);

      reportFetchSuccess();
      expect(getOnline()).toBe(true);
    });

    it('emits only when the combined value actually changes', () => {
      const events: boolean[] = [];
      subscribeOnline((v) => events.push(v));

      window.dispatchEvent(new Event('offline'));
      reportFetchFailure(new TypeError('Failed to fetch'));
      window.dispatchEvent(new Event('online'));
      reportFetchSuccess();

      expect(events).toEqual([false, true]);
    });
  });

  describe('self-healing recovery probe', () => {
    const PROBE = 'https://x.supabase.co/auth/v1/health';
    const RECOVERY_INTERVAL_MS = 30_000;

    it('self-heals a latched Offline when a recovery probe reaches the backend', async () => {
      vi.useFakeTimers();
      try {
        setConnectivityProbeUrl(PROBE);
        reportFetchFailure(new TypeError('Failed to fetch'));
        expect(getConnectivityStatus()).toBe('offline');

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

    it('self-heals a latched Down (5xx) when the recovery probe reaches the health endpoint', async () => {
      vi.useFakeTimers();
      try {
        setConnectivityProbeUrl(PROBE);
        const statusEvents: ConnectivityStatus[] = [];
        subscribeConnectivityStatus((s) => statusEvents.push(s));
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
        await trackedFetch('/rest/v1/x');
        expect(getConnectivityStatus()).toBe('backend-unreachable');
        // Down backs off: React Query is paused.
        expect(onlineManager.isOnline()).toBe(false);

        // The always-up health endpoint answers; the backed-off probe re-tests and
        // clears the Down state.
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);

        expect(getConnectivityStatus()).toBe('online');
        // The recovery must actually be BROADCAST — a 5xx leaves fetchOnline true,
        // so the probe-success path must still emit: subscribers notified and
        // onlineManager un-paused, not just a fresh getConnectivityStatus() read.
        expect(statusEvents.at(-1)).toBe('online');
        expect(onlineManager.isOnline()).toBe(true);
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

        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS * 3);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps re-probing each interval while the probe keeps failing (stays Offline)', async () => {
      vi.useFakeTimers();
      try {
        setConnectivityProbeUrl(PROBE);
        reportFetchFailure(new TypeError('Failed to fetch'));
        const fetchMock = vi.fn(async () => {
          throw new TypeError('Failed to fetch');
        });
        vi.stubGlobal('fetch', fetchMock);

        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
        expect(getConnectivityStatus()).toBe('offline');

        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
        expect(getConnectivityStatus()).toBe('offline');
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('recovers to online when the backend comes back after a sustained outage', async () => {
      vi.useFakeTimers();
      try {
        setConnectivityProbeUrl(PROBE);
        reportFetchFailure(new TypeError('Failed to fetch'));
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
        expect(getConnectivityStatus()).toBe('offline');

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

        setNavigatorOnline(false);
        window.dispatchEvent(new Event('offline'));
        expect(getConnectivityStatus()).toBe('offline');

        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS * 2);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-probes immediately on regained window focus while latched offline', async () => {
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getConnectivityStatus()).toBe('offline');

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

      window.dispatchEvent(new Event('focus'));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not let a cache hit clear the pill while offline, and keeps probing', async () => {
      vi.useFakeTimers();
      try {
        setConnectivityProbeUrl(PROBE);
        reportFetchFailure(new TypeError('Failed to fetch'));
        expect(getConnectivityStatus()).toBe('offline');

        reportFetchSuccess(/* cacheBypassing */ false);
        expect(getConnectivityStatus()).toBe('offline');

        const fetchMock = vi.fn(async () => {
          throw new TypeError('Failed to fetch');
        });
        vi.stubGlobal('fetch', fetchMock);
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getConnectivityStatus()).toBe('offline');
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops flapping back online on cache hits the instant we go down', async () => {
      setConnectivityProbeUrl(PROBE);
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getConnectivityStatus()).toBe('offline');

      reportFetchSuccess(/* cacheBypassing */ false);
      reportFetchSuccess(/* cacheBypassing */ false);
      expect(getOnline()).toBe(false);
      expect(getConnectivityStatus()).toBe('offline');

      reportFetchSuccess(/* cacheBypassing */ true);
      expect(getConnectivityStatus()).toBe('online');
    });
  });

  describe('three-way connectivity status', () => {
    it('reports Offline when a fetch throws but the device claims online', () => {
      // navigator.onLine stays true; a throw is no response, so we can't prove the
      // device has a connection → Offline, not Down.
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getConnectivityStatus()).toBe('offline');
      expect(getOnline()).toBe(false);
    });

    it('reports Down (backend-unreachable) on a 5xx response — reachable but erroring', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
      await trackedFetch('/rest/v1/x');
      expect(getConnectivityStatus()).toBe('backend-unreachable');
      expect(getOnline()).toBe(false);
    });

    it('reports offline when the device itself has no network', () => {
      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
      expect(getConnectivityStatus()).toBe('offline');
    });

    it('lets the device-offline signal win over a backend 5xx', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
      await trackedFetch('/rest/v1/x');
      expect(getConnectivityStatus()).toBe('backend-unreachable');

      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
      expect(getConnectivityStatus()).toBe('offline');
    });

    it('notifies status subscribers on the Down -> offline transition the boolean hides', async () => {
      const statusEvents: ConnectivityStatus[] = [];
      const boolEvents: boolean[] = [];
      subscribeConnectivityStatus((s) => statusEvents.push(s));
      subscribeOnline((v) => boolEvents.push(v));

      // online -> backend-unreachable (a 5xx response)
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
      await trackedFetch('/rest/v1/x');
      // backend-unreachable -> offline (the OS reports no network)
      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));

      expect(statusEvents).toEqual(['backend-unreachable', 'offline']);
      // The boolean only sees the online->false edge once (both are not-online).
      expect(boolEvents).toEqual([false]);
    });

    it('returns to online once the backend serves again', () => {
      reportFetchFailure(new TypeError('Failed to fetch'));
      expect(getConnectivityStatus()).toBe('offline');
      reportFetchSuccess();
      expect(getConnectivityStatus()).toBe('online');
    });
  });
});
