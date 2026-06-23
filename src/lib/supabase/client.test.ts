import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabaseFetch } from './client';
import { _resetNetworkStatusForTests, getOnline } from '../networkStatus';

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

    await vi.advanceTimersByTimeAsync(15_000);

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

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(getOnline()).toBe(false);
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
            // A long-running poller/discover call: well past the 15s read cap.
            setTimeout(() => resolve(new Response('{}', { status: 200 })), 40_000);
          }),
      ),
    );

    const promise = supabaseFetch('https://x.supabase.co/functions/v1/refresh');
    // The read cap would have aborted at 15s; the function call keeps running.
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
});
