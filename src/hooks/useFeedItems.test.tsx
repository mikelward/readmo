import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { useFeedItems } from './useFeedItems';
import type { FetchPage } from './useFeedItems';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { FeedItem } from '../lib/types';
import type { Page } from '../lib/data/DataSource';

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useFeedItems', () => {
  it('dedupes items re-served across pages by offset drift', async () => {
    // Regression: the server pages by offset over a newest-first list, so
    // items inserted by the poller between page fetches shift the offsets and
    // a "More" page re-serves the tail of the previous page. The flat list
    // must not render the same item id twice (duplicate React keys).
    const source = new MockDataSource(`test-${Math.random()}`);
    const all: FeedItem[] = (await source.getHomeItems()).items;
    expect(all.length).toBeGreaterThanOrEqual(3);

    const page1: Page<FeedItem> = { items: all.slice(0, 2), nextCursor: '2' };
    // Overlaps page1's tail (all[1]) — what offset paging serves after one
    // newer item landed at the top between the two fetches.
    const page2: Page<FeedItem> = { items: all.slice(1, 3), nextCursor: null };
    const fetchPage = vi.fn((cursor: string | null) =>
      Promise.resolve(cursor === null ? page1 : page2),
    );

    const { result } = renderHook(
      () => useFeedItems('home-all', fetchPage as FetchPage),
      { wrapper },
    );

    await waitFor(() => expect(result.current.items).toHaveLength(2));

    result.current.fetchMore();
    await waitFor(() => expect(result.current.isFetchingMore).toBe(false));

    const ids = result.current.items.map((fi) => fi.item.id);
    expect(ids).toEqual([all[0], all[1], all[2]].map((fi) => fi.item.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
