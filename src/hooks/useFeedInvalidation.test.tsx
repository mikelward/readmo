import { act, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { vi } from 'vitest';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemList } from '../components/ItemList';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { FeedItem } from '../lib/types';
import type { FetchPage } from './useFeedItems';

/**
 * Regression: after a persisted-cache restore, preexisting Done/Hidden item
 * state must cause the feed to refetch so stale rows disappear immediately.
 *
 * The fix is in main.tsx: PersistQueryClientProvider.onSuccess calls
 * queryClient.invalidateQueries({ queryKey: ['feed'] }) after hydration.
 * This test verifies the observable behaviour: a Done item that appears in a
 * restored feed must disappear once invalidateQueries triggers a refetch.
 */
describe('boot-time feed invalidation after persist restore', () => {
  it('refetches and removes a Done item after invalidateQueries fires', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const firstPage = await source.getHomeItems();
    const allItems: FeedItem[] = firstPage.items;
    expect(allItems.length).toBeGreaterThan(1);

    const doneItem = allItems[0];

    // Mark the item Done before rendering, simulating boot-time localStorage
    // hydration that happens before the React tree mounts.
    source.stateStore.set(doneItem.item.id, 'done', true);

    // fetchPage: first call returns ALL items (including Done) — simulating a
    // persisted snapshot. Subsequent calls are held behind a gate so we can
    // assert the Done item is visible from the first result before the
    // refetch resolves and filters it out.
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

    // First fetch lands — Done item is visible because the restored snapshot
    // included it and staleTime prevents an automatic refetch.
    await waitFor(() => expect(hasDoneTitle()).toBe(true));

    // Simulate PersistQueryClientProvider.onSuccess: invalidate feed caches
    // after the persisted snapshot is fully hydrated.
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
    });

    // The refetch is now in flight. Release it so it can resolve.
    await waitFor(() => expect(releaseRefetch).not.toBeNull());
    act(() => { releaseRefetch!(); });

    // After the refetch resolves, the real source filters out Done items.
    await waitFor(() => expect(hasDoneTitle()).toBe(false));

    // Sanity: fetchPage was called exactly twice (initial + post-invalidation).
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
