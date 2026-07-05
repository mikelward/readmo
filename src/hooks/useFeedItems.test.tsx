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

// Mirrors ItemList's adjustNextCursor: when any loaded row is locally dismissed,
// the next offset is the count of distinct live rows loaded so far (an absolute
// count, stable across successive More taps), else defer to the server cursor.
function makeAdjustNextCursor(source: MockDataSource) {
  return (raw: string | null, pages: Array<Page<FeedItem>>): string | null => {
    if (raw == null) return raw;
    const offset = Number.parseInt(raw, 10);
    if (!Number.isFinite(offset)) return raw;
    let dismissed = 0;
    const live = new Set<string>();
    for (const p of pages)
      for (const fi of p.items) {
        const st = source.stateStore.get(fi.item.id);
        if (st.done || st.hidden) dismissed += 1;
        else live.add(fi.item.id);
      }
    return dismissed > 0 ? String(live.size) : raw;
  };
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

  it('shrinks the next-page offset by locally-dismissed rows so More does not skip a row (Codex P1 #375)', async () => {
    // A mutation no longer refetches, so loaded pages keep locally Done/Hidden
    // rows the server has already dropped from its offset sequence. The server's
    // nextCursor ('3' here) then points past the row that shifted up, and a plain
    // More would skip it. `adjustNextCursor` maps to the count of distinct live
    // loaded rows — AND this test pins down that React Query evaluates it at
    // fetchNextPage time (reading the store AFTER the dismiss), not at fetch time.
    const source = new MockDataSource(`test-${Math.random()}`);
    const all: FeedItem[] = (await source.getHomeItems()).items;
    expect(all.length).toBeGreaterThanOrEqual(3);
    const page1: Page<FeedItem> = { items: all.slice(0, 3), nextCursor: '3' };
    const fetchPage = vi.fn((cursor: string | null) =>
      Promise.resolve(
        cursor === null ? page1 : { items: [], nextCursor: null },
      ),
    );
    // Mirrors ItemList's adjuster.
    const adjustNextCursor = makeAdjustNextCursor(source);

    const { result } = renderHook(
      () => useFeedItems('home-all', fetchPage as FetchPage, adjustNextCursor),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(3));

    // Dismiss one loaded row; the server drops it, shrinking its sequence by one.
    source.stateStore.hide(all[0].item.id);

    result.current.fetchMore();
    await waitFor(() => expect(result.current.isFetchingMore).toBe(false));

    // The next page was fetched at offset '2' (3 loaded − 1 dismissed), NOT the
    // stale '3' that would skip the row that slid into offset 2.
    expect(fetchPage).toHaveBeenLastCalledWith('2');
  });

  it('advances past a fully-dismissed page instead of re-fetching it forever (Codex P2 #376)', async () => {
    // The offset adjustment must be an absolute count of live loaded rows, not a
    // decrement of the incoming cursor. If it decremented, dismissing a whole page
    // and tapping More twice would compute the same offset each time (cursor −
    // dismissed = 0 → 0 → 0), re-fetching the same page forever and leaving older
    // items unreachable. This walks two More taps across a fully-dismissed first
    // page and asserts the second one advances instead of looping.
    const source = new MockDataSource(`test-${Math.random()}`);
    const all: FeedItem[] = (await source.getHomeItems()).items;
    expect(all.length).toBeGreaterThanOrEqual(9);
    // Model an offset server paging over the *live* (non-dismissed) sequence.
    const fetchPage = vi.fn((cursor: string | null) => {
      if (cursor === null)
        return Promise.resolve({ items: all.slice(0, 3), nextCursor: '3' });
      if (cursor === '0')
        return Promise.resolve({ items: all.slice(3, 6), nextCursor: '3' });
      if (cursor === '3')
        return Promise.resolve({ items: all.slice(6, 9), nextCursor: null });
      return Promise.resolve({ items: [], nextCursor: null });
    });
    const adjustNextCursor = makeAdjustNextCursor(source);

    const { result } = renderHook(
      () => useFeedItems('home-all', fetchPage as FetchPage, adjustNextCursor),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(3));

    // Dismiss the entire first page; the server drops all three from its sequence.
    source.stateStore.hide(all[0].item.id);
    source.stateStore.hide(all[1].item.id);
    source.stateStore.hide(all[2].item.id);

    // First More: 0 live loaded → offset '0' (the server's new first live row).
    result.current.fetchMore();
    await waitFor(() => expect(result.current.isFetchingMore).toBe(false));
    expect(fetchPage).toHaveBeenLastCalledWith('0');

    // Second More: 3 live loaded (page 2) → offset '3', NOT '0' again. The buggy
    // decrement formula would recompute '3' − 3 = '0' here and loop.
    result.current.fetchMore();
    await waitFor(() => expect(result.current.isFetchingMore).toBe(false));
    expect(fetchPage).toHaveBeenLastCalledWith('3');

    // All three real pages are reachable — the tail was not stranded.
    const ids = new Set(result.current.items.map((fi) => fi.item.id));
    for (const fi of all.slice(6, 9)) expect(ids.has(fi.item.id)).toBe(true);
  });
});
