import { act, screen, waitFor } from '@testing-library/react';
import { QueryClient, useQuery } from '@tanstack/react-query';
import { vi } from 'vitest';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemList } from '../components/ItemList';
import { MockDataSource } from '../lib/data/MockDataSource';
import { DEFAULT_ITEM_STATE, type FeedItem } from '../lib/types';
import type { FetchPage } from './useFeedItems';

/**
 * Regression: after a persisted-cache restore, preexisting Done/Hidden item
 * state must cause the feed to refetch so stale rows disappear from the
 * cache (not just the rendered list).
 *
 * The fix has two layers:
 *   1. main.tsx: PersistQueryClientProvider.onSuccess calls
 *      queryClient.invalidateQueries({ queryKey: ['feed'] }) after hydration.
 *   2. ItemList: the client-side visibleItems filter drops Done/Hidden rows
 *      from the rendered list immediately, regardless of cache freshness, so
 *      a Done row never reaches the screen even before the refetch lands.
 *
 * This test verifies BOTH layers: the Done item is never rendered (layer 2),
 * AND `invalidateQueries` triggers a real refetch so the cache gets cleaned
 * up too (layer 1) — without it, the cached snapshot would still carry the
 * Done row for the next session.
 */
describe('boot-time feed invalidation after persist restore', () => {
  it('refetches the feed (and the rendered list never shows the Done item)', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const firstPage = await source.getHomeItems();
    const allItems: FeedItem[] = firstPage.items;
    expect(allItems.length).toBeGreaterThan(1);

    const doneItem = allItems[0];

    // Mark the item Done before rendering, simulating boot-time localStorage
    // hydration that happens before the React tree mounts.
    source.stateStore.set(doneItem.item.id, 'done', true);

    // fetchPage: first call returns ALL items (including Done) — simulating a
    // persisted snapshot whose cached page hasn't been re-filtered yet.
    // Subsequent calls are held behind a gate so the test can verify the
    // post-invalidation refetch actually fires before resolving it.
    let releaseRefetch: (() => void) | null = null;
    let callCount = 0;

    const fetchPage = vi.fn((cursor: string | null) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ items: allItems, nextCursor: null });
      }
      return new Promise((resolve) => {
        releaseRefetch = () => source.getHomeItems({ cursor }).then(resolve);
      });
    });

    // High staleTime mirrors production (5 min) so no automatic refetch fires;
    // the only refetch is the one we trigger via invalidateQueries.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000, staleTime: 60_000 } },
    });

    renderWithProviders(
      <ItemList viewKey="home-all" fetchPage={fetchPage as FetchPage} emptyLabel="All caught up." />,
      { source, queryClient },
    );

    // item-title elements contain the full "title + source + time + author" as
    // one textContent string — use startsWith to match just the title portion.
    const hasDoneTitle = () =>
      screen.getAllByTestId('item-title').some((n) => n.textContent?.startsWith(doneItem.item.title));

    // Wait for the first fetch to complete and rows to render. Layer 2:
    // the Done row was in the cached page but the client-side filter
    // never lets it through to the DOM.
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryAllByTestId('item-title').length).toBeGreaterThan(0));
    expect(hasDoneTitle()).toBe(false);

    // Simulate PersistQueryClientProvider.onSuccess: invalidate feed caches
    // after the persisted snapshot is fully hydrated. Layer 1: this must
    // actually fire a refetch so the cache itself is freshened.
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
    });

    // The refetch is now in flight. Release it and confirm the rendered
    // list stays clean (the source's own filter drops the Done id too).
    await waitFor(() => expect(releaseRefetch).not.toBeNull());
    act(() => { releaseRefetch!(); });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(hasDoneTitle()).toBe(false);
  });
});

describe('useFeedInvalidation query scoping', () => {
  it('refetches the unread-count query on a mutation but leaves feed-items fresh', async () => {
    // Codex P2 on #375: the unread-count query key (['feed','unread-counts',…])
    // shares the ['feed'] prefix, so it must be invalidated explicitly — after an
    // outbox write syncs and clears the local pending adjustment, the badge would
    // otherwise read a stale server count and jump back up. The count is a cheap
    // number that never reflows the list, so it must keep refetching.
    //
    // The feed-ITEMS query, by contrast, is left ENTIRELY alone: not refetched
    // (no reflow under the reader) and — the TTL fix — not even force-marked
    // stale. Force-staling it made refetchOnMount fire a full refetch every time
    // the reader navigated back to the feed, defeating the staleTime TTL. Leaving
    // it fresh means the back/remount refetch is gated by staleTime instead.
    const source = new MockDataSource(`test-${Math.random()}`);
    const itemsFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const countsFetch = vi.fn().mockResolvedValue({ 'feed-a': 3 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    // renderWithProviders mounts useFeedInvalidation; these two observers make
    // both queries "active" so an invalidation's default refetchType can refetch.
    function Probe() {
      useQuery({ queryKey: ['feed', 'home-all'], queryFn: itemsFetch });
      useQuery({ queryKey: ['feed', 'unread-counts', 'feed-a'], queryFn: countsFetch });
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(1));

    act(() => {
      source.stateStore.set('item-1', 'done', true);
    });

    // The count query refetches (a number, no list reflow)…
    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(2));
    // …but the feed-items query is untouched: no refetch under the reader…
    expect(itemsFetch).toHaveBeenCalledTimes(1);
    // …and left FRESH, not force-staled — so a remount within staleTime (the
    // back-navigation path) stays TTL-gated and won't refetch.
    const feedItemsQuery = queryClient
      .getQueryCache()
      .find({ queryKey: ['feed', 'home-all'] });
    expect(feedItemsQuery?.isStale()).toBe(false);
  });

  it('refetches feed-items on a cross-device hydration (not just a local mutation)', async () => {
    // The other half of the split: a hydrate that changes the store — a
    // cross-device resync (useStateSync → resyncState → hydrate) or a boot
    // restore — CAN add/reorder rows the local overlay can't express (e.g.
    // another device pinning an article not in the loaded window). That path
    // must refetch the feed-items query so the new row shows up without a manual
    // pull-to-refresh, and promptly — not after staleTime (Codex P2 on #408).
    const source = new MockDataSource(`test-${Math.random()}`);
    const itemsFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    function Probe() {
      useQuery({ queryKey: ['feed', 'home-all'], queryFn: itemsFetch });
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(1));

    // A hydration that actually changes the map (a pin arriving from the server).
    act(() => {
      source.stateStore.hydrate([
        ['cross-device-item', { ...DEFAULT_ITEM_STATE, pinned: true, pinnedAt: 1 }],
      ]);
    });

    // The active feed-items query refetches immediately — default refetchType,
    // gated by nothing (invalidate marks it stale first), so the cross-device
    // pin reconciles now rather than at the next TTL boundary.
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(2));
  });

  it('does not fire the feed-items refetch on a no-op hydration', async () => {
    // subscribeHydrated only fires when the map actually changed, so a resync
    // that returns identical state (the common case on a routine focus) must not
    // churn a feed read.
    const source = new MockDataSource(`test-${Math.random()}`);
    const itemsFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    function Probe() {
      useQuery({ queryKey: ['feed', 'home-all'], queryFn: itemsFetch });
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(1));

    // Hydrating the empty store with no rows is a no-op — no map change.
    act(() => {
      source.stateStore.hydrate([]);
    });

    // Give any (unwanted) refetch a chance to fire before asserting it didn't.
    await Promise.resolve();
    expect(itemsFetch).toHaveBeenCalledTimes(1);
  });
});
