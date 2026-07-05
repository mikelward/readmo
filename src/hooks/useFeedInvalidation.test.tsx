import { act, screen, waitFor } from '@testing-library/react';
import { QueryClient, useQuery } from '@tanstack/react-query';
import { vi } from 'vitest';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemList } from '../components/ItemList';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { FeedItem } from '../lib/types';
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
  it('refetches the unread-count query on a mutation but only marks feed-items stale', async () => {
    // Codex P2 on #375: the unread-count query key (['feed','unread-counts',…])
    // shares the ['feed'] prefix, so a blanket refetchType:'none' would suppress
    // it too — and after an outbox write syncs and clears the local pending
    // adjustment, the badge would read a stale server count and jump back up.
    // The count is a cheap number that never reflows the list, so it must keep
    // refetching; only the feed-ITEMS query is left stale-without-refetch.
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
    // …but the feed-items query is only marked stale — no refetch under the reader.
    expect(itemsFetch).toHaveBeenCalledTimes(1);
  });
});
