import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabaseFetch, _resetRequestBreakerForTests } from './client';
import { _resetNetworkStatusForTests, getOnline } from '../networkStatus';
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
    // saw. The read RPCs are POSTs the GET-only cache never serves, so the breaker
    // is scoped to them. Here the backend is down: every RPC fails, but a GET read
    // returns the cache-fallback 200. The breaker must NOT treat that cached 200
    // as recovery, or the failing RPC loop would resume.
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
    // A GET read goes straight through (it bypasses the open breaker — never shed)…
    expect(
      (await supabaseFetch('https://x.supabase.co/rest/v1/feeds')).status,
    ).toBe(200);
    // …and crucially its cache-served 200 did NOT close the breaker: the next RPC
    // is still shed while the backend is still down.
    await expect(
      supabaseFetch('https://x.supabase.co/rest/v1/rpc/feed_items', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(/circuit open/i);
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
