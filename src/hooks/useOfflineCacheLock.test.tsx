import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  IsRestoringProvider,
  QueryObserver,
} from '@tanstack/react-query';
import { DataSourceProvider } from '../lib/data/context';
import { MockDataSource } from '../lib/data/MockDataSource';
import { _resetNetworkStatusForTests } from '../lib/networkStatus';
import { useOfflineCacheLock } from './useOfflineCacheLock';

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
}

afterEach(() => {
  setNavigatorOnline(true);
  _resetNetworkStatusForTests();
});

function Harness() {
  useOfflineCacheLock();
  return null;
}

function setup(source: MockDataSource) {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <DataSourceProvider source={source}>
        <Harness />
      </DataSourceProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('useOfflineCacheLock', () => {
  it('caches a pinned item detail + reading body, and evicts on unpin', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    // The detail and (truncated) full-text bodies are warmed into the cache.
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    await waitFor(() => expect(qc.getQueryData(['fulltext', 'item-1'])).toBeTruthy());

    source.stateStore.set('item-1', 'pinned', false);
    // Unpinning evicts both so unpinned bodies don't linger in the cache.
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeUndefined());
    expect(qc.getQueryData(['fulltext', 'item-1'])).toBeUndefined();
  });

  it('keeps the cache when an unpinned item is still favorited', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    source.stateStore.set('item-1', 'favorite', true);
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());

    // Unpin — still favorited, so it stays in the offline bucket and cached.
    source.stateStore.set('item-1', 'pinned', false);
    await Promise.resolve();
    expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy();

    // Unfavorite too — now in no bucket, so it's evicted.
    source.stateStore.set('item-1', 'favorite', false);
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeUndefined());
  });

  it('caches a favorited (never-pinned) item', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = setup(source);
    source.stateStore.set('item-3', 'favorite', true);
    await waitFor(() => expect(qc.getQueryData(['item', 'item-3'])).toBeTruthy());
  });

  it('warms a pin made while offline once connectivity returns', async () => {
    setNavigatorOnline(false);
    _resetNetworkStatusForTests();
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    // Offline: locked but nothing fetched yet.
    await Promise.resolve();
    expect(qc.getQueryData(['item', 'item-1'])).toBeUndefined();

    // Reconnect → the lock is warmed without re-toggling the pin.
    act(() => {
      setNavigatorOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    await waitFor(() => expect(qc.getQueryData(['fulltext', 'item-1'])).toBeTruthy());
  });

  it('retries a transient full-text miss instead of getting stuck on the stub', async () => {
    class FlakyFullText extends MockDataSource {
      ftCalls = 0;
      async fetchFullText(id: string) {
        this.ftCalls += 1;
        return this.ftCalls === 1
          ? ({ status: 'unreachable', contentHtml: null } as const)
          : super.fetchFullText(id);
      }
    }
    const source = new FlakyFullText(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    // First attempt: detail cached, full text transiently unreachable (not warmed).
    await waitFor(() =>
      expect(
        (qc.getQueryData(['fulltext', 'item-1']) as { status?: string } | undefined)?.status,
      ).toBe('unreachable'),
    );

    // A later sync pass (here: also favoriting it) retries the unwarmed id.
    source.stateStore.set('item-1', 'favorite', true);
    await waitFor(() =>
      expect(
        (qc.getQueryData(['fulltext', 'item-1']) as { status?: string } | undefined)?.status,
      ).toBe('ok'),
    );
  });

  it('does not refetch the detail when a cached copy already exists (no boot burst)', async () => {
    class CountingSource extends MockDataSource {
      itemCalls: string[] = [];
      async getItem(id: string) {
        this.itemCalls.push(id);
        return super.getItem(id);
      }
    }
    const source = new CountingSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // Pre-seed a hydrated detail, then bucket the item.
    const seed = new MockDataSource(`seed-${Math.random()}`);
    queryClient.setQueryData(['item', 'item-1'], await seed.getItem('item-1'));
    source.stateStore.set('item-1', 'pinned', true);

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourceProvider source={source}>
          <Harness />
        </DataSourceProvider>
      </QueryClientProvider>,
    );

    await Promise.resolve();
    await Promise.resolve();
    // The hydrated detail is treated as fresh → no network getItem for it.
    expect(source.itemCalls).not.toContain('item-1');
  });

  it('refreshes the /offline list when it newly caches an item', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      <QueryClientProvider client={queryClient}>
        <DataSourceProvider source={source}>
          <Harness />
        </DataSourceProvider>
      </QueryClientProvider>,
    );

    source.stateStore.set('item-1', 'pinned', true);
    await waitFor(() => expect(queryClient.getQueryData(['item', 'item-1'])).toBeTruthy());
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['offline'] }),
    );
  });

  it('does not refresh the /offline list when the item was already cached', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const seed = new MockDataSource(`seed-${Math.random()}`);
    queryClient.setQueryData(['item', 'item-1'], await seed.getItem('item-1'));
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      <QueryClientProvider client={queryClient}>
        <DataSourceProvider source={source}>
          <Harness />
        </DataSourceProvider>
      </QueryClientProvider>,
    );

    source.stateStore.set('item-1', 'pinned', true);
    await Promise.resolve();
    await Promise.resolve();
    expect(invalidateSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['offline'] }),
    );
  });

  it('defers warming until the persisted cache has restored', async () => {
    class CountingSource extends MockDataSource {
      itemCalls: string[] = [];
      async getItem(id: string) {
        this.itemCalls.push(id);
        return super.getItem(id);
      }
    }
    const source = new CountingSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    source.stateStore.set('item-1', 'pinned', true);

    const tree = (restoring: boolean) => (
      <QueryClientProvider client={queryClient}>
        <IsRestoringProvider value={restoring}>
          <DataSourceProvider source={source}>
            <Harness />
          </DataSourceProvider>
        </IsRestoringProvider>
      </QueryClientProvider>
    );

    const { rerender } = render(tree(true));
    await Promise.resolve();
    await Promise.resolve();
    // While restoring, warming is deferred — no network getItem yet.
    expect(source.itemCalls).not.toContain('item-1');

    // Restore completes → the item is warmed.
    rerender(tree(false));
    await waitFor(() => expect(queryClient.getQueryData(['item', 'item-1'])).toBeTruthy());
  });

  it('retries a null detail miss instead of caching it forever', async () => {
    class FlakyDetailSource extends MockDataSource {
      calls = 0;
      async getItem(id: string) {
        this.calls += 1;
        return this.calls === 1 ? null : super.getItem(id);
      }
    }
    const source = new FlakyDetailSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <DataSourceProvider source={source}>
          <Harness />
        </DataSourceProvider>
      </QueryClientProvider>,
    );

    source.stateStore.set('item-1', 'pinned', true);
    // First warm gets null → not cached (would otherwise be pinned fresh forever).
    await waitFor(() => expect(source.calls).toBe(1));
    expect(queryClient.getQueryData(['item', 'item-1'])).toBeFalsy();

    // A later sync pass (favoriting it) retries and now caches the real detail.
    source.stateStore.set('item-1', 'favorite', true);
    await waitFor(() => expect(queryClient.getQueryData(['item', 'item-1'])).toBeTruthy());
  });

  it('re-locks already-pinned (hydrated) items on mount', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    // Pin BEFORE the hook mounts — simulates a pin restored from persistence.
    source.stateStore.set('item-2', 'pinned', true);
    const qc = setup(source);

    await waitFor(() => expect(qc.getQueryData(['item', 'item-2'])).toBeTruthy());
  });

  it('bounds warm concurrency — does not fetch every saved item at once', async () => {
    // A user with many saved items must not fire one getItem per item all at
    // once on boot/reconnect. getItem is gated so we can observe how many run
    // concurrently; the limiter must cap it at OFFLINE_WARM_CONCURRENCY (4).
    const gates: Array<() => void> = [];
    class GatedSource extends MockDataSource {
      inFlight = 0;
      maxInFlight = 0;
      getItemCalls = 0;
      async getItem(id: string) {
        this.getItemCalls += 1;
        this.inFlight += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        await new Promise<void>((res) => gates.push(res));
        this.inFlight -= 1;
        return super.getItem(id);
      }
    }
    const source = new GatedSource(`test-${Math.random()}`);
    setup(source);

    // item-1..item-10 are all seeded in the mock, so getItem returns a real
    // detail and no transient-miss retry replays to skew the count.
    const ids = Array.from({ length: 10 }, (_, i) => `item-${i + 1}`);
    for (const id of ids) source.stateStore.set(id, 'pinned', true);

    // Only 4 getItem calls go out before any resolves — the other 6 queue.
    await waitFor(() => expect(gates.length).toBe(4));
    expect(source.getItemCalls).toBe(4);
    expect(source.maxInFlight).toBe(4);

    // Drain in waves; the queue keeps feeding but concurrency never exceeds 4.
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    for (let wave = 0; wave < 20 && source.getItemCalls < 10; wave++) {
      await waitFor(() => expect(gates.length).toBeGreaterThan(0));
      const pending = gates.length;
      for (let i = 0; i < pending; i++) gates.shift()!();
      await flush();
    }
    while (gates.length) gates.shift()!();
    await flush();

    expect(source.getItemCalls).toBe(10); // every item warmed exactly once
    expect(source.maxInFlight).toBe(4); // but never more than 4 concurrently
  });

  it('does not resurrect an item unpinned while its warm was queued', async () => {
    // With the concurrency cap, a warm can sit in the queue while the item is
    // unpinned (and unlock evicts its queries). The queued task must bail when it
    // finally runs — not re-create gcTime:Infinity entries for evicted content.
    const gates: Array<() => void> = [];
    class GatedSource extends MockDataSource {
      getItemIds: string[] = [];
      async getItem(id: string) {
        this.getItemIds.push(id);
        await new Promise<void>((res) => gates.push(res));
        return super.getItem(id);
      }
    }
    const source = new GatedSource(`test-${Math.random()}`);
    const qc = setup(source);

    // 5 items (item-1..item-5, all seeded in the mock): 4 fill the concurrency
    // slots (gated on getItem); the 5th queues.
    for (let i = 1; i <= 5; i++) source.stateStore.set(`item-${i}`, 'pinned', true);
    await waitFor(() => expect(gates.length).toBe(4));
    expect(source.getItemIds).not.toContain('item-5'); // still queued, not fetched

    // Unpin the still-queued item before it gets a slot → unlock evicts it.
    source.stateStore.set('item-5', 'pinned', false);

    // Release the in-flight four; a slot frees and item-4's queued warm runs — but
    // it must bail (no longer locked), never fetching or caching it.
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    for (let i = 0; i < 20 && (gates.length || source.getItemIds.length < 4); i++) {
      while (gates.length) gates.shift()!();
      await flush();
    }

    expect(source.getItemIds).not.toContain('item-5'); // bailed before fetching
    expect(qc.getQueryData(['item', 'item-5'])).toBeUndefined(); // not resurrected
    // The four still-pinned items warmed normally.
    expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy();
  });

  it('does not let slow full-text extraction block detail warming of other items', async () => {
    // Detail (getItem) and full-text run on separate pools. If full-text shared
    // the detail pool, a few slow extractions (the Edge call can take tens of
    // seconds, uncapped) would hold every slot and starve later items' details —
    // which are what make an item show up offline. Here full-text hangs for all
    // items; every item's DETAIL must still warm.
    const ftGates: Array<() => void> = [];
    class SlowFullText extends MockDataSource {
      async fetchFullText(id: string) {
        await new Promise<void>((res) => ftGates.push(res)); // never resolves on its own
        return super.fetchFullText(id);
      }
    }
    const source = new SlowFullText(`test-${Math.random()}`);
    const qc = setup(source);

    // 6 truncated items (> the detail pool of 4): their full-text extraction hangs.
    const ids = Array.from({ length: 6 }, (_, i) => `item-${i + 1}`);
    for (const id of ids) source.stateStore.set(id, 'pinned', true);

    // Every item's detail warms despite full-text being stuck — if the two shared
    // one pool, items 5–6 would never get past the 4 stuck extractions.
    for (const id of ids) {
      await waitFor(() => expect(qc.getQueryData(['item', id])).toBeTruthy());
    }
  });

  it('keeps a concurrently-opened item detail when unpinned during its full-text warm', async () => {
    // If an item is unpinned while its full-text prefetch is in flight and the
    // user opens the article (a normal reader fetch repopulates ['item', id]),
    // the warm's cleanup must drop only the full-text key — not evict the reader's
    // freshly-fetched detail on the shared ['item', id] key.
    const ftGates: Array<() => void> = [];
    class GatedFullText extends MockDataSource {
      async fetchFullText(id: string) {
        await new Promise<void>((res) => ftGates.push(res));
        return super.fetchFullText(id);
      }
    }
    const source = new GatedFullText(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    // Detail warmed; the (truncated-feed) full-text fetch is now gated in flight.
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    await waitFor(() => expect(ftGates.length).toBe(1));

    // Unpin → unlock evicts the offline entries while full-text is still in flight…
    source.stateStore.set('item-1', 'pinned', false);
    // …and the user opens the article, repopulating ['item', id] with a reader fetch.
    qc.setQueryData(['item', 'item-1'], { reader: true });

    // Full-text resolves → the warm's cleanup runs. It must remove ['fulltext']
    // but leave the reader's ['item'] entry intact.
    ftGates.shift()!();
    await waitFor(() =>
      expect(qc.getQueryData(['fulltext', 'item-1'])).toBeUndefined(),
    );
    expect(qc.getQueryData(['item', 'item-1'])).toEqual({ reader: true });
  });

  it('does not evict a reader-observed detail when unpinned mid-detail-fetch', async () => {
    // If an item is unpinned while its detail prefetch is in flight and the user
    // has the article open (an active observer on the shared ['item', id] key),
    // the warm's unlock cleanup must NOT remove it — that would evict the detail
    // the reader is showing. Only an unobserved (orphaned) resurrection is dropped.
    const gates: Array<() => void> = [];
    class GatedDetail extends MockDataSource {
      async getItem(id: string) {
        await new Promise<void>((res) => gates.push(res));
        return super.getItem(id);
      }
    }
    const source = new GatedDetail(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    await waitFor(() => expect(gates.length).toBe(1)); // detail fetch in flight

    // Unpin (unlock evicts the offline entry) and open the article — seed the
    // reader's detail and attach a live observer on the shared ['item', id] key.
    source.stateStore.set('item-1', 'pinned', false);
    qc.setQueryData(['item', 'item-1'], { reader: true });
    const observer = new QueryObserver(qc, {
      queryKey: ['item', 'item-1'],
      enabled: false,
    });
    const unsub = observer.subscribe(() => {});

    // The detail fetch resolves; the warm's !locks cleanup runs but must leave the
    // reader-observed entry intact (only an unobserved orphan is dropped).
    gates.shift()!();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy();
    unsub();
  });

  it('replays a retry that was requested while a warm was in flight', async () => {
    // A reconnect/sync can fire warm(id) while one is already in flight; that
    // request is coalesced. If the in-flight warm then misses (null detail here),
    // it must replay once when it settles instead of waiting for a later event.
    const gates: Array<() => void> = [];
    class FlakyGatedDetail extends MockDataSource {
      calls = 0;
      async getItem(id: string) {
        this.calls += 1;
        await new Promise<void>((res) => gates.push(res));
        // First attempt misses (null), the replay succeeds.
        return this.calls === 1 ? null : super.getItem(id);
      }
    }
    const source = new FlakyGatedDetail(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    await waitFor(() => expect(gates.length).toBe(1)); // first warm in flight
    // A second trigger arrives while the first is in flight (e.g. a focus/sync) —
    // coalesced as a pending retry rather than starting a duplicate.
    source.stateStore.set('item-1', 'favorite', true);

    // First attempt settles as a null miss → the coalesced retry replays.
    gates.shift()!();
    await waitFor(() => expect(gates.length).toBe(1)); // the replay's fetch is in flight
    gates.shift()!();
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    expect(source.calls).toBe(2); // missed once, replayed once
  });

  it('re-warms the detail if it was evicted by an unpin+repin during the full-text phase', async () => {
    // If a truncated item is unpinned (evicting ['item', id]) then re-pinned while
    // its full-text fetch is still in flight, the full-text phase sees the item
    // locked again. It must NOT mark the item `warmed` while the detail is missing
    // — that would suppress the replay and leave the bucketed item out of /offline.
    const ftGates: Array<() => void> = [];
    let getItemCalls = 0;
    class GatedFullText extends MockDataSource {
      async getItem(id: string) {
        getItemCalls += 1;
        return super.getItem(id);
      }
      async fetchFullText(id: string) {
        await new Promise<void>((res) => ftGates.push(res));
        return super.fetchFullText(id);
      }
    }
    const source = new GatedFullText(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    await waitFor(() => expect(ftGates.length).toBe(1)); // full-text in flight
    expect(getItemCalls).toBe(1);

    // Unpin (unlock evicts the detail) then re-pin — all while full-text is still
    // in flight, so the re-pin's warm is coalesced into a pending retry.
    source.stateStore.set('item-1', 'pinned', false);
    expect(qc.getQueryData(['item', 'item-1'])).toBeUndefined(); // evicted
    source.stateStore.set('item-1', 'pinned', true);

    // Full-text settles. The detail is missing, so the warm must replay and
    // re-fetch it rather than marking the item warmed and dropping the retry.
    ftGates.shift()!();
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    expect(getItemCalls).toBe(2); // detail re-fetched by the replay
  });

  it('does not fetch the full body for an item whose feed body is complete', async () => {
    class LongBodySource extends MockDataSource {
      async getItem(id: string) {
        const fi = await super.getItem(id);
        if (fi) {
          fi.item = { ...fi.item, contentHtml: `<p>${'plenty of words '.repeat(60)}</p>` };
        }
        return fi;
      }
    }
    const source = new LongBodySource(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeTruthy());
    // Body is long enough → not truncated → no full-text fetch.
    expect(qc.getQueryData(['fulltext', 'item-1'])).toBeUndefined();
  });
});
