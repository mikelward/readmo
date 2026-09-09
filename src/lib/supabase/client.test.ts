import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabaseFetch, _resetRequestBreakerForTests } from './client';
import {
  _resetNetworkStatusForTests,
  getOnline,
  setConnectivityProbeUrl,
} from '../networkStatus';
import { isRetriableError } from '../queryRetry';

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

// A fetch mock that never resolves on its own — it only settles when the
// request's signal aborts (mirroring how the platform fetch rejects with the
// signal's reason on abort). Lets us drive the timeout deterministically.
function hangingFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  );
}

describe('supabaseFetch', () => {
  beforeEach(() => {
    setNavigatorOnline(true);
    _resetNetworkStatusForTests();
    _resetRequestBreakerForTests(); // the breaker is a module singleton
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setNavigatorOnline(true);
    _resetNetworkStatusForTests();
  });

  it('passes a normal response through and reports the fetch side healthy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );

    const res = await supabaseFetch('https://x.supabase.co/rest/v1/item_state');
    expect(res.status).toBe(200);
    expect(getOnline()).toBe(true);
  });

  it('times out a hung request and flips the offline indicator', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());

    const promise = supabaseFetch(
      'https://x.supabase.co/rest/v1/item_state',
    );
    // Avoid an unhandled rejection while we advance the clock.
    promise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(8_000);

    await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(getOnline()).toBe(false);
  });

  it('caps the feed_items read RPC (a POST) — the primary feed read must not hang', async () => {
    // PostgREST sends rpc() as POST, but feed_items is a pure read and the main
    // home/folder/feed query; it must be bounded or a hung feed RPC strands the
    // view on its skeletons even when item_state is cached.
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());

    const promise = supabaseFetch(
      'https://x.supabase.co/rest/v1/rpc/feed_items',
      { method: 'POST' },
    );
    promise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(8_000);

    await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(getOnline()).toBe(false);
  });

  it('hedges a slow read with a liveness probe — a dead zone flips Offline before the 8s cap', async () => {
    // Lie-fi: the read hangs (no fast failure), so without the hedge the first
    // offline evidence waits out the full read cap plus the post-timeout probe.
    // The hedge fires the probe at 3s, in parallel with the still-hanging read.
    vi.useFakeTimers();
    const PROBE = 'https://x.supabase.co/auth/v1/health';
    setConnectivityProbeUrl(PROBE);
    const urlOf = (input: RequestInfo | URL) =>
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      // The probe fails fast (genuinely unreachable); the read hangs until abort.
      if (urlOf(input) === PROBE)
        return Promise.reject(new TypeError('Failed to fetch'));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = supabaseFetch(
      'https://x.supabase.co/rest/v1/rpc/feed_items',
      { method: 'POST' },
    );
    promise.catch(() => undefined);

    expect(getOnline()).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    // The pill flipped at hedge time — 5s before the read even times out.
    expect(getOnline()).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      PROBE,
      expect.objectContaining({ method: 'GET' }),
    );

    // The read cap is unaffected: the read itself still aborts at 8s.
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('does not hedge uncapped requests (auth) — only bounded reads adjudicate slowness', async () => {
    // Auth/Edge/writes are deliberately uncapped; they must not fire hedge
    // probes either (a long-running function invoke is normal, not lie-fi).
    vi.useFakeTimers();
    const PROBE = 'https://x.supabase.co/auth/v1/health';
    setConnectivityProbeUrl(PROBE);
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
          setTimeout(() => resolve(new Response('{}', { status: 200 })), 20_000);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const promise = supabaseFetch('https://x.supabase.co/auth/v1/token', {
      method: 'POST',
    });
    await vi.advanceTimersByTimeAsync(19_000);
    // No probe fired despite 19s in flight — only the auth request itself ran.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await promise).status).toBe(200);
    expect(getOnline()).toBe(true);
  });

  it('does not abort before the 8s ceiling — a read at 7.9s still resolves', async () => {
    // Guards the lowered cap from drifting *down* into the range a healthy-but-
    // slow mobile read lives in: a read that answers just under the ceiling must
    // pass through, not get aborted.
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal!.reason),
            );
            setTimeout(() => resolve(new Response('{}', { status: 200 })), 7_900);
          }),
      ),
    );

    const promise = supabaseFetch('https://x.supabase.co/rest/v1/item_state');
    await vi.advanceTimersByTimeAsync(7_900);

    expect((await promise).status).toBe(200);
    expect(getOnline()).toBe(true);
  });

  it('runs reads concurrently — a hung read does not block or abort another in-flight read', async () => {
    // The ceiling is per-request (each call gets its own AbortController + timer),
    // so a stuck read can't hang the rest of the app: a second read started while
    // the first is still in flight resolves on its own, and the first's eventual
    // timeout aborts only itself.
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal!.reason),
            );
            // 'fast' answers at 3s; 'slow' never resolves on its own (only its
            // own ceiling aborts it).
            if (String(input).includes('fast')) {
              setTimeout(() => resolve(new Response('{}', { status: 200 })), 3_000);
            }
          }),
      ),
    );

    const slow = supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items?slow', {
      method: 'POST',
    });
    slow.catch(() => undefined);
    // Started while `slow` is still pending.
    const fast = supabaseFetch('https://x.supabase.co/rest/v1/item_state?fast');

    // The fast read settles on its own clock, unaffected by the still-hung one.
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await fast).status).toBe(200);

    // The slow read is still pending — only its own 8s ceiling ends it.
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(slow).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('does not time out a request that resolves before the ceiling', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal!.reason),
            );
            setTimeout(() => resolve(new Response('{}', { status: 200 })), 5_000);
          }),
      ),
    );

    const promise = supabaseFetch('https://x.supabase.co/rest/v1/item_state');
    await vi.advanceTimersByTimeAsync(5_000);

    const res = await promise;
    expect(res.status).toBe(200);
    expect(getOnline()).toBe(true);
  });

  it('does not cap Edge Function invocations (/functions/v1/) that outrun the read timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal!.reason),
            );
            // A long-running poller/discover call: well past the 8s read cap.
            setTimeout(() => resolve(new Response('{}', { status: 200 })), 40_000);
          }),
      ),
    );

    const promise = supabaseFetch('https://x.supabase.co/functions/v1/refresh');
    // The read cap would have aborted at 8s; the function call keeps running.
    await vi.advanceTimersByTimeAsync(40_000);

    const res = await promise;
    expect(res.status).toBe(200);
    expect(getOnline()).toBe(true);
  });

  it('does not cap auth (/auth/v1/) requests — a hung token refresh must not be aborted into a sign-out', async () => {
    // Capping auth would turn a transient lie-fi token-refresh hang into a
    // failed getSession() → user nulled → useUserCacheScope purges the offline
    // cache and reloads. Leave auth uncapped so it runs to the platform limit.
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal!.reason),
            );
            setTimeout(() => resolve(new Response('{}', { status: 200 })), 40_000);
          }),
      ),
    );

    const promise = supabaseFetch('https://x.supabase.co/auth/v1/token');
    await vi.advanceTimersByTimeAsync(40_000);

    const res = await promise;
    expect(res.status).toBe(200);
    expect(getOnline()).toBe(true);
  });

  it('does not cap writes on /rest/v1/ — a slow-but-committing mutation must not be aborted', async () => {
    // set_item_state (outbox), DELETE/PATCH on subscriptions share the /rest/v1/
    // prefix but are writes. Aborting one mid-commit would make the outbox retry
    // on a stale base version (permanent conflict / dropped edit) or surface a
    // spurious error. Only GET reads are capped.
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(init.signal!.reason),
            );
            setTimeout(() => resolve(new Response('{}', { status: 200 })), 40_000);
          }),
      ),
    );

    // POST RPC write (item-state delivery).
    const rpc = supabaseFetch('https://x.supabase.co/rest/v1/rpc/set_item_state', {
      method: 'POST',
    });
    // DELETE on a table (unsubscribe).
    const del = supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?id=eq.1', {
      method: 'DELETE',
    });
    await vi.advanceTimersByTimeAsync(40_000);

    expect((await rpc).status).toBe(200);
    expect((await del).status).toBe(200);
    expect(getOnline()).toBe(true);
  });

  it('marks the item-state write RPC keepalive so it survives tab teardown, but not other writes', async () => {
    // A mark-done/pin fired just before the tab closes must still reach the
    // server. keepalive lets the in-flight write outlive the page unload; the
    // outbox owns its durability/retry, so no read cap applies either way.
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await supabaseFetch('https://x.supabase.co/rest/v1/rpc/set_item_state', {
      method: 'POST',
      body: '{}',
    });
    // A different write (unsubscribe) is not marked keepalive.
    await supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?id=eq.1', {
      method: 'DELETE',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://x.supabase.co/rest/v1/rpc/set_item_state',
      expect.objectContaining({ keepalive: true }),
    );
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('keepalive', true);
  });

  it('forwards a caller abort without treating it as a connectivity drop', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const controller = new AbortController();
    const promise = supabaseFetch('https://x.supabase.co/rest/v1/item_state', {
      signal: controller.signal,
    });
    controller.abort(new DOMException('superseded', 'AbortError'));

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    // A caller cancelling a superseded query says nothing about connectivity.
    expect(getOnline()).toBe(true);
  });

  it('opens the circuit after a burst of failing read RPCs and sheds further ones', async () => {
    const fetchMock = vi.fn(async () => new Response('err', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    // Default failureThreshold is 6 consecutive failures. The breaker is scoped
    // to the network-authoritative read RPCs (POSTs the SW cache never serves),
    // so trip it on feed_items rather than a cacheable GET read.
    for (let i = 0; i < 6; i++) {
      const r = await supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items', {
        method: 'POST',
        body: '{}',
      });
      expect(r.status).toBe(500);
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // The 7th is shed by the open breaker — it never reaches fetch, and the shed
    // is a RETRIABLE error (not an AbortError) so a peer read refetched alongside
    // the half-open probe recovers via React Query's retry once the probe closes
    // the circuit, instead of being stuck in an error state.
    const shed = await supabaseFetch(
      'https://x.supabase.co/rest/v1/rpc/feed_items',
      { method: 'POST', body: '{}' },
    ).catch((e) => e);
    expect(shed).toBeInstanceOf(Error);
    expect(shed.name).not.toBe('AbortError');
    expect(isRetriableError(shed)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('does not let a cache-served GET 200 close a breaker an RPC outage opened', async () => {
    // In the installed PWA, GET /rest/v1/ reads are served by Workbox NetworkFirst
    // (vite.config.ts), so a "200" can be a stale cache fallback the backend never
    // saw. Such a read IS guarded by the breaker (a failing loop on it must be
    // shed), but its SUCCESS must never be read as recovery — otherwise the cache
    // would close the circuit mid-outage and the failing RPC loop would resume.
    //
    // The sharp case is the cached read arriving as the half-open PROBE, which is
    // the only moment a single success can close the circuit. Fake Date because
    // the cooldown is Date.now()-based, and rebuild the breaker after installing
    // the clock (it captures Date.now at construction).
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    _resetRequestBreakerForTests();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input instanceof Request ? input.url : input);
      // RPCs hit the (down) backend → 500; GET reads are answered from cache → 200.
      return new Response('{}', { status: u.includes('/rpc/') ? 500 : 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Open the breaker on the failing read RPCs.
    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items', {
        method: 'POST',
        body: '{}',
      });
    }
    // Cooling down: the cacheable GET is shed too now — it no longer bypasses.
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/feeds'),
    ).rejects.toThrow(/circuit open/i);

    // Past the cooldown the GET is admitted as the probe and answers 200 from
    // cache. That DOES close the circuit — refusing to would strand a client
    // that only reads cacheable tables — but on probation.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(
      (await supabaseFetch('https://x.supabase.co/rest/v1/feeds')).status,
    ).toBe(200);

    // So the failing RPC loop resumes for exactly ONE request before the circuit
    // slams shut again — not the six a fresh failure run would have cost. That
    // bound is what makes trusting a cache-served 200 acceptable.
    expect(
      (
        await supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items', {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(500);
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(/circuit open/i);
  });

  it('counts a service-worker cache fallback as a failure', async () => {
    // The SW's NetworkFirst answers from cache when the network doesn't, so an
    // outage arrives at the page as a plain 200. Without the stamp the breaker
    // reads a masked outage as health and never caps the loop underneath.
    const fetchMock = vi.fn(
      async () =>
        new Response('[]', {
          status: 200,
          headers: { 'x-readmo-sw-source': 'cache-error' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*');
    }
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*'),
    ).rejects.toThrow(/circuit open/i);
  });

  it('does NOT count a cache fallback while the device is offline', async () => {
    // Shedding happens before the service worker, so tripping the breaker while
    // genuinely offline would take away the cache fallback that makes the app
    // readable offline at all. A failed network attempt with no network is not
    // evidence about the backend.
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      const fetchMock = vi.fn(
        async () =>
          new Response('[]', {
            status: 200,
            headers: { 'x-readmo-sw-source': 'cache-error' },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      for (let i = 0; i < 20; i++) {
        await supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*');
      }
      // Still serving the user their cached reads.
      expect(
        (await supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*'))
          .status,
      ).toBe(200);
    } finally {
      onLine.mockRestore();
    }
  });

  it('does NOT count a cache fallback that only outran the worker timeout', async () => {
    // NetworkFirst answers from cache after 6s while the request is STILL in
    // flight, and it may succeed a moment later where nothing can see it. A slow
    // backend is not a failing one — and counting these would let one screen
    // load's worth of concurrent slow reads open the circuit and then take away
    // the cache fallback those reads were relying on.
    const fetchMock = vi.fn(
      async () =>
        new Response('[]', {
          status: 200,
          headers: { 'x-readmo-sw-source': 'cache-timeout' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 20; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*');
    }
    expect(
      (await supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*'))
        .status,
    ).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(21);
  });

  it('does NOT count a read that fails outright while the device is offline', async () => {
    // The other half of the offline carve-out, and the half that decides whether
    // it means anything: the reads that REJECT offline are the ones that missed
    // the cache (or are NetworkOnly, like item_state). Counting those would open
    // the circuit and then shed the later reads that WOULD have hit a warm
    // cache — shedding happens before the service worker — costing the reader
    // their offline library to protect a backend the requests never reached.
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      const fetchMock = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });
      vi.stubGlobal('fetch', fetchMock);

      for (let i = 0; i < 20; i++) {
        await expect(
          supabaseFetch('https://x.supabase.co/rest/v1/item_state'),
        ).rejects.toThrow(/failed to fetch/i);
      }
      // Still closed: the 21st read reaches the network (and so would reach the
      // service worker's cache) rather than being shed.
      await expect(
        supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*'),
      ).rejects.toThrow(/failed to fetch/i);
      expect(fetchMock).toHaveBeenCalledTimes(21);
    } finally {
      onLine.mockRestore();
    }
  });

  it('treats an UNSTAMPED cacheable 200 as inconclusive (old service worker)', async () => {
    // A service worker cached before the stamp shipped marks nothing, and an old
    // SW can outlive many client deploys. Absence must read as "unknown", never
    // as "the network answered" — otherwise a masked outage closes the circuit.
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 20; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*');
    }
    // Neither tripped (it isn't failure evidence) nor treated as recovery.
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it('lets a network-stamped cacheable read end probation and restore parallelism', async () => {
    // The gap Codex found in the probation design: a reader on a screen that
    // loads only cacheable tables produced nothing authoritative, so admission
    // stayed serialized indefinitely after the backend recovered. With the SW
    // stamping the live side too, an ordinary `subscriptions` read is now proof
    // the backend itself answered.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    _resetRequestBreakerForTests();

    let phase: 'trip' | 'unstamped' | 'live' = 'trip';
    const gate: Array<() => void> = [];
    const fetchMock = vi.fn(async () => {
      if (phase === 'trip') return new Response('', { status: 503 });
      // An OLD service worker: it may well be serving this from cache, but it
      // says nothing, so the probe is inconclusive — closed, on probation. This
      // is the state the stamp exists to get a client out of.
      if (phase === 'unstamped') return new Response('[]', { status: 200 });
      // Live phase: hold the response open so concurrency is observable — a
      // serialized (probationary) peer would park instead of reaching fetch.
      await new Promise<void>((resolve) => gate.push(resolve));
      return new Response('[]', {
        status: 200,
        headers: { 'x-readmo-sw-source': 'network' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*');
    }
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*'),
    ).rejects.toThrow(/circuit open/i);

    // Cooldown, then the half-open probe comes back unstamped: closed, but on
    // probation — admission is one at a time until the backend confirms.
    await vi.advanceTimersByTimeAsync(10_000);
    phase = 'unstamped';
    expect(
      (await supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*'))
        .status,
    ).toBe(200);

    // One live read, stamped `network`: the backend itself answered.
    phase = 'live';
    const callsBefore = fetchMock.mock.calls.length;
    const confirming = supabaseFetch(
      'https://x.supabase.co/rest/v1/subscriptions?select=*',
    );
    await vi.advanceTimersByTimeAsync(0);
    gate.shift()!();
    await confirming;

    // Probation is over: two concurrent reads BOTH reach the network instead of
    // the second parking behind the first. Sequential admissions would pass even
    // while serialized, which is why this asserts on an overlap.
    const a = supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*');
    const b = supabaseFetch('https://x.supabase.co/rest/v1/folders?select=*');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 3);
    gate.forEach((release) => release());
    await Promise.all([a, b]);
  });

  it('counts a 401 loop on a cacheable table (expired token)', async () => {
    // The schema-probe exemption must not cover this: an expired-token loop is
    // the failure class that melted the backend in the first place.
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*');
    }
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*'),
    ).rejects.toThrow(/circuit open/i);
  });

  it('does not count a capability-probe 4xx on a cacheable read', async () => {
    // getSyncedSettings walks a projection ladder against user_settings, taking
    // an EXPECTED 4xx per rung until it finds one the deployed backend can serve
    // (guardrail 11). Counting those would let a backend that is merely older
    // than the client trip a breaker meant for one that is failing — and then
    // shed unrelated reads, including their cache fallback.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: '42703', message: 'column missing' }), {
          status: 400,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Far more probe cycles than the 6-failure threshold.
    for (let i = 0; i < 20; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/user_settings?select=a,b');
    }
    // Still closed, and an unrelated read still reaches the network.
    const other = await supabaseFetch('https://x.supabase.co/rest/v1/folders?select=*');
    expect(other.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(21);
  });

  it('counts an UNCODED 400 on a cacheable table (a malformed-query loop)', async () => {
    // The exemption is keyed on the PostgREST schema code, not the status: a
    // repeated 400 that isn't a capability probe — a malformed query, a gateway
    // error page — is an ordinary failed read, and a loop on one is exactly what
    // the breaker exists to cap. Keying on the status alone waved these through.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'PGRST100', message: 'parse error' }), {
          status: 400,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/folders?select=*');
    }
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/folders?select=*'),
    ).rejects.toThrow(/circuit open/i);
  });

  it('counts a 4xx whose body is not a PostgREST error at all', async () => {
    // The exemption must be EARNED. An unreadable or non-JSON body cannot
    // identify a probe, so it stays a failure — the direction that can only
    // over-protect the backend.
    const fetchMock = vi.fn(
      async () => new Response('<html>Bad Request</html>', { status: 400 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/folders?select=*');
    }
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/folders?select=*'),
    ).rejects.toThrow(/circuit open/i);
  });

  it('settles a 4xx whose body never finishes, instead of parking forever', async () => {
    // The read cap is gone by now — boundedReadFetch resolves on HEADERS and
    // clears its 8s timer — so a body that stalls mid-stream would leave the
    // schema-code check awaiting forever, and the breaker ticket unsettled. An
    // unsettled probationary/half-open ticket parks every later bounded read
    // behind it permanently, which is the deadlock class this whole file guards.
    vi.useFakeTimers();
    _resetRequestBreakerForTests();
    const stalling = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"code":'));
            // …and never closes.
          },
        }),
        { status: 400 },
      );
    const fetchMock = vi.fn(async () => stalling());
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      const read = supabaseFetch('https://x.supabase.co/rest/v1/folders?select=*');
      await vi.advanceTimersByTimeAsync(1_000); // the bounded body wait elapses
      expect((await read).status).toBe(400);
    }

    // Settled as failures rather than hanging: the circuit is open and the next
    // read is shed, which is only reachable if all six tickets settled.
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/folders?select=*'),
    ).rejects.toThrow(/circuit open/i);
  });

  it('counts a permission-denied 4xx even though it names the table', async () => {
    // 42501 (insufficient_privilege) is grouped with the missing-table codes in
    // supabaseMappers, but it is a real failed read here: an RLS/permission loop
    // must still trip.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: '42501', message: 'permission denied' }), {
          status: 400,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*');
    }
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*'),
    ).rejects.toThrow(/circuit open/i);
  });

  it('still counts a 4xx on an authoritative read (a stale backend missing the RPC)', async () => {
    // The other half: the 4xx-is-a-failure rule was argued for the read RPCs,
    // where a PostgREST 404 means the function itself is missing and a refetch
    // loop repeats forever. Nothing capability-probes those.
    const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items', {
        method: 'POST',
        body: '{}',
      });
    }
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(/circuit open/i);
  });

  it('caps a failing loop on a cacheable read (subscriptions / user_settings)', async () => {
    // The Aug 14 outage: PostgREST unreachable, so /subscriptions and
    // /user_settings 503 on every attempt. Neither is a read RPC nor item_state,
    // so before this they were guarded by nothing at all — the breaker watched
    // three paths and these were not among them. A loop here could run unbounded.
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*');
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // Shed — and shed before the network, which is the point: a shed costs the
    // backend nothing.
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/subscriptions?select=*'),
    ).rejects.toThrow(/circuit open/i);
    expect(fetchMock).toHaveBeenCalledTimes(6);

    // The breaker is one circuit, not one per path: user_settings failures counted
    // toward the same run and it is shed on the same evidence.
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/user_settings?select=*'),
    ).rejects.toThrow(/circuit open/i);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('lets a cacheable read fail the circuit open even when it never succeeds authoritatively', async () => {
    // A user sitting on a screen that only reads cacheable tables (no feed read,
    // so no item_state hydration and no read RPC) must still be capped. This is
    // the case the inconclusive-success rule could have deadlocked: nothing
    // authoritative ever arrives to close the circuit, so the cooldown has to be
    // what lets traffic through again.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    _resetRequestBreakerForTests();
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/folders?select=*');
    }
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/folders?select=*'),
    ).rejects.toThrow(/circuit open/i);

    // One probe per cooldown window, not none: the loop is throttled, not stopped
    // forever, so recovery needs no authoritative read to happen by luck.
    await vi.advanceTimersByTimeAsync(10_000);
    const probe = await supabaseFetch(
      'https://x.supabase.co/rest/v1/folders?select=*',
    );
    expect(probe.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('bounds a hung half-open probe by the 8s read cap and releases parked peers (no indefinite strand)', async () => {
    // The half-open probe is an admitted breaker-scoped read, so it goes through
    // boundedReadFetch and inherits the 8s REQUEST_TIMEOUT_MS cap — it cannot hang
    // forever. When a probe never answers, the cap aborts it (TimeoutError → trip),
    // which releases any peers parked on probeWait() instead of stranding them.
    // Fake Date too: the breaker's cooldown is Date.now()-based, so the clock must
    // advance for the circuit to leave `open` and admit the probe. The breaker
    // captures Date.now at construction, so rebuild it AFTER the fake clock is
    // installed (beforeEach reset ran against the real clock).
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    _resetRequestBreakerForTests();
    let phase: 'trip' | 'probe' = 'trip';
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (phase === 'trip') {
        return Promise.resolve(new Response('err', { status: 500 }));
      }
      // Probe phase: hang until the read cap aborts the request.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Open the breaker on 6 failing reads.
    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/item_state');
    }
    // Advance past the 10s cooldown so the next read is admitted as the probe.
    await vi.advanceTimersByTimeAsync(10_000);

    phase = 'probe';
    const probe = supabaseFetch('https://x.supabase.co/rest/v1/item_state'); // hangs
    probe.catch(() => undefined);
    // A peer arrives while the probe is in flight → parks on probeWait().
    const peer = supabaseFetch('https://x.supabase.co/rest/v1/item_state');
    peer.catch(() => undefined);

    // The 8s read cap fires: the probe times out → trips the breaker → the parked
    // peer is released and re-decides (breaker now open + cooling → shed), rather
    // than waiting on a promise that never resolves.
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(probe).rejects.toMatchObject({ name: 'TimeoutError' });
    const peerResult = await peer.catch((e) => e);
    expect(peerResult).toBeInstanceOf(Error);
    expect(peerResult.name).not.toBe('AbortError'); // released + shed, not left hanging
    expect(isRetriableError(peerResult)).toBe(true); // retriable shed → recovers on retry
  });

  it('guards the NetworkOnly item_state hydration read (it precedes every feed read)', async () => {
    // item_state is served by the SW's NetworkOnly route (vite.config.ts) — never
    // cache-served, so it's network-authoritative like the read RPCs, NOT a
    // NetworkFirst-cached GET. ensureHydratedForRead issues it before every
    // feed_items read, so a failing loop's hydration GET must be shed by the
    // breaker too, not bypass it (or one PostgREST read per iteration escapes the
    // backstop).
    const fetchMock = vi.fn(async () => new Response('err', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/item_state?select=*');
    }
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/item_state?select=*'),
    ).rejects.toThrow(/circuit open/i);
    expect(fetchMock).toHaveBeenCalledTimes(6); // the 7th was shed before fetch
  });

  it('counts a non-2xx read-RPC response (e.g. PostgREST 404) as a breaker failure', async () => {
    // A read RPC normally returns 200 with data; a 404 means the function is
    // missing (a stale / schema-cache-mismatched backend), a genuinely failed
    // read. It must trip the breaker — otherwise a refetch loop hitting a 404 RPC
    // would repeat forever without ever opening the circuit.
    const fetchMock = vi.fn(
      async () => new Response('{"message":"Not Found"}', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items', {
        method: 'POST',
        body: '{}',
      });
    }
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(/circuit open/i);
  });

  it('treats the feed_unread_counts RPC as a bounded read (guarded by the breaker)', async () => {
    const fetchMock = vi.fn(async () => new Response('err', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    // A failing grouped-view refetch loop hits feed_unread_counts; it must trip
    // and then be shed by the breaker just like feed_items, not bypass it.
    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_unread_counts', {
        method: 'POST',
        body: '{}',
      });
    }
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_unread_counts', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(/circuit open/i);
  });

  it('keeps auth (/auth/v1/) reachable even when the data-plane breaker is open', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const ok = String(input instanceof Request ? input.url : input).includes('/auth/v1/');
      return new Response('{}', { status: ok ? 200 : 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Trip the data-plane breaker on failing read RPCs (its scoped set).
    for (let i = 0; i < 6; i++) {
      await supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items', {
        method: 'POST',
        body: '{}',
      });
    }
    // A data-plane read RPC is now shed…
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(/circuit open/i);

    // …but auth still goes through — recovering an expired token / signing out
    // must not be blocked by the data-plane flood guard.
    const auth = await supabaseFetch(
      'https://x.supabase.co/auth/v1/token?grant_type=refresh_token',
    );
    expect(auth.status).toBe(200);
  });

  it('does not shed WRITES when the read breaker is open (the outbox owns writes)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 6; i++) {
      // trip on failing read RPCs (the breaker's scoped set)
      await supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items', {
        method: 'POST',
        body: '{}',
      });
    }
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(/circuit open/i); // a read RPC is now shed
    const callsBeforeWrites = fetchMock.mock.calls.length;

    // A write RPC and a subscription mutation both still reach the network — the
    // breaker guards reads only; writes are owned by the item-state outbox.
    const rpc = await supabaseFetch(
      'https://x.supabase.co/rest/v1/rpc/set_item_state',
      { method: 'POST', body: '{}' },
    );
    const patch = await supabaseFetch(
      'https://x.supabase.co/rest/v1/subscriptions?id=eq.1',
      { method: 'PATCH', body: '{}' },
    );
    expect(rpc.status).toBe(500); // reached fetch (not shed locally)
    expect(patch.status).toBe(500);
    expect(fetchMock.mock.calls.length).toBe(callsBeforeWrites + 2);
  });
});
