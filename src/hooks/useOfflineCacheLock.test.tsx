import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, IsRestoringProvider } from '@tanstack/react-query';
import { DataSourceProvider } from '../lib/data/context';
import { MockDataSource } from '../lib/data/MockDataSource';
import { _resetNetworkStatusForTests } from '../lib/networkStatus';
import { useOfflineCacheLock } from './useOfflineCacheLock';
import { fullTextQueryKey } from '../lib/fullText';

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
    await waitFor(() => expect(qc.getQueryData(fullTextQueryKey('item-1'))).toBeTruthy());

    source.stateStore.set('item-1', 'pinned', false);
    // Unpinning evicts both so unpinned bodies don't linger in the cache.
    await waitFor(() => expect(qc.getQueryData(['item', 'item-1'])).toBeUndefined());
    expect(qc.getQueryData(fullTextQueryKey('item-1'))).toBeUndefined();
  });

  it('evicts a legacy (older-version) full-text body on unpin too', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = setup(source);

    source.stateStore.set('item-1', 'pinned', true);
    await waitFor(() => expect(qc.getQueryData(fullTextQueryKey('item-1'))).toBeTruthy());
    // Simulate a body warmed by a prior build under the un-versioned key. The
    // persisted cache is maxAge: Infinity, so this must be evicted on unpin or
    // it lingers forever even after the item leaves the offline bucket.
    qc.setQueryData(['fulltext', 'item-1'], { status: 'ok', contentHtml: '<p>old</p>' });

    source.stateStore.set('item-1', 'pinned', false);
    await waitFor(() => expect(qc.getQueryData(fullTextQueryKey('item-1'))).toBeUndefined());
    // The legacy-key body is gone too (prefix removal, not exact).
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
    await waitFor(() => expect(qc.getQueryData(fullTextQueryKey('item-1'))).toBeTruthy());
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
        (qc.getQueryData(fullTextQueryKey('item-1')) as { status?: string } | undefined)?.status,
      ).toBe('unreachable'),
    );

    // A later sync pass (here: also favoriting it) retries the unwarmed id.
    source.stateStore.set('item-1', 'favorite', true);
    await waitFor(() =>
      expect(
        (qc.getQueryData(fullTextQueryKey('item-1')) as { status?: string } | undefined)?.status,
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
    expect(qc.getQueryData(fullTextQueryKey('item-1'))).toBeUndefined();
  });
});
