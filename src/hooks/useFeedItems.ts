import {
  useInfiniteQuery,
} from '@tanstack/react-query';
import type { FeedItem } from '../lib/types';
import type { Page } from '../lib/data/DataSource';

export type FetchPage = (cursor: string | null) => Promise<Page<FeedItem>>;

/** Flatten query pages into the rendered list, keeping the first occurrence of
 * each item id. The server pages by offset over a newest-first list, so items
 * inserted by the poller between page fetches shift the offsets and a "More"
 * page can re-serve the tail of the previous page — without this, the flat
 * list renders the same item twice (duplicate React keys). The
 * grouped-windowed path dedupes on its own (ItemList's baseById/extrasById
 * merge). Exported so ItemList's pager measures progress on the same deduped
 * view the list renders. */
export function dedupeFeedPages(pages: Array<Page<FeedItem>>): FeedItem[] {
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const fi of page.items) {
      if (seen.has(fi.item.id)) continue;
      seen.add(fi.item.id);
      items.push(fi);
    }
  }
  return items;
}

/**
 * Drives a feed view (home / folder / single feed). Pages are fetched lazily
 * (explicit "More", no infinite scroll — SPEC.md *Feed views*). Feed query
 * invalidation on state changes is handled globally by useFeedInvalidation
 * (mounted in App) so mutations on the reader page take effect even while
 * this hook is unmounted.
 */
export function useFeedItems(
  viewKey: string,
  fetchPage: FetchPage,
  /**
   * Optional hook to correct the next-page offset before it's fetched. Because a
   * mutation no longer refetches (see useFeedInvalidation), the loaded pages can
   * carry locally Done/Hidden rows the server has already dropped from its
   * sequence — so the server's offset-based `nextCursor` would skip rows on the
   * next "More". The caller (ItemList) subtracts the distinct dismissed rows it
   * has loaded. React Query evaluates `getNextPageParam` at `fetchNextPage` time,
   * so this reads the store fresh at the moment the reader taps "More".
   * (Codex P1 on #375.)
   */
  adjustNextCursor?: (
    rawCursor: string | null,
    pages: Array<Page<FeedItem>>,
  ) => string | null,
  /**
   * `refetchOnMount` for the underlying query. Omit for the React Query default
   * (true-when-stale). The caller (ItemList) passes `false` when the user
   * navigates Back into a feed from the reader, so returning never fires a fetch
   * under the reader's next tap — fresh data still arrives via prefetch-on-open,
   * focus, pull-to-refresh, and cross-device sync. A mount with no cached data
   * still does its initial fetch regardless (refetchOnMount only governs
   * *re*fetching data already in cache).
   */
  refetchOnMount?: boolean | 'always',
) {
  const query = useInfiniteQuery({
    queryKey: ['feed', viewKey],
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage, allPages) =>
      adjustNextCursor
        ? adjustNextCursor(lastPage.nextCursor, allPages)
        : lastPage.nextCursor,
    // refetchOnWindowFocus: true so a tab that regains focus after >5 min
    // picks up new items (SPEC.md "refetch-on-focus + PTR"). The global
    // staleTime (5 min, main.tsx) gates this — no request fires if the data
    // is still fresh, so switching tabs rapidly is cheap.
    refetchOnWindowFocus: true,
    // Whether a remount refetches stale cached data. Undefined → RQ default
    // (true-when-stale); ItemList passes false on a POP (Back) so returning to
    // a feed doesn't refetch. Never 'always' — that would hammer the DB.
    refetchOnMount,
  });

  const items: FeedItem[] = dedupeFeedPages(query.data?.pages ?? []);

  return {
    items,
    isLoading: query.isLoading,
    isError: query.isError,
    // The underlying read failure (initial or background refetch). Surfaced so
    // the view can show the *actual* error rather than a generic connectivity
    // line, and log it to the console. `query.error` covers both isError and the
    // background-refresh-failure case (where isError stays false).
    error: query.error ?? null,
    // Any fetch in flight (initial, refetch, or next-page). Callers that need to
    // avoid starting a *second* fetch — e.g. the reconnect confirm in ItemList —
    // gate on this so they treat an in-flight request as the confirming one
    // instead of cancelling/duplicating it.
    isFetching: query.isFetching,
    hasMore: query.hasNextPage ?? false,
    // Pages currently loaded — the pager's baseline for "did that fetch append
    // a page", which the deduped `items` length can't answer (an appended page
    // of re-served items adds nothing to it).
    pageCount: query.data?.pages.length ?? 0,
    isFetchingMore: query.isFetchingNextPage,
    fetchMore: query.fetchNextPage,
    refetch: query.refetch,
    // Background refresh: data already present and a refetch is in flight.
    isRefreshing: !!query.data && query.isFetching && !query.isFetchingNextPage,
    // In React Query v5, a background refetch failure keeps status='success'
    // and isError=false; only query.error is set. Use that directly.
    refreshFailed: !!query.data && !!query.error,
  };
}
