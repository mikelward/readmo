import {
  useInfiniteQuery,
} from '@tanstack/react-query';
import type { FeedItem } from '../lib/types';
import type { Page } from '../lib/data/DataSource';
import { recordFeedFetch } from '../lib/lastFetch';
import { isDeviceOffline } from '../lib/networkStatus';

/** Page fetcher for a feed view. `signal` is React Query's per-fetch abort
 * signal, threaded through so a wrapper can tell whether the fetch it observed
 * resolving was CANCELED (superseded by pagination/navigation — its result is
 * discarded by the query cache) rather than applied; implementations are free
 * to ignore it. */
export type FetchPage = (
  cursor: string | null,
  signal?: AbortSignal,
) => Promise<Page<FeedItem>>;

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
) {
  const query = useInfiniteQuery({
    queryKey: ['feed', viewKey],
    // Record every settled feed fetch for /debug's "Last fetch" row — the
    // phone-reachable answer to "did my refresh run, and what did it say?".
    // A canceled fetch (superseded by pagination/navigation) isn't an outcome.
    queryFn: async ({ pageParam, signal }) => {
      try {
        const page = await fetchPage(pageParam, signal);
        if (!signal?.aborted) recordFeedFetch(true);
        return page;
      } catch (err) {
        if (!signal?.aborted) recordFeedFetch(false, err);
        throw err;
      }
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage, allPages) =>
      adjustNextCursor
        ? adjustNextCursor(lastPage.nextCursor, allPages)
        : lastPage.nextCursor,
    // …and neither automatic trigger fires while the DEVICE reports no network.
    // `networkMode: 'offlineFirst'` (main.tsx) deliberately lets the first
    // attempt through even when React Query believes we're offline — that's what
    // makes a cache-servable read work — but for these two triggers the reader
    // asked for nothing, so all that buys is a "Refreshing" state spinning over
    // their list for as long as the read takes to fail (the primary feed read is
    // a POST RPC, which Workbox can't answer from cache at all, so it runs to
    // its 8s cap on a radio that hangs rather than refuses). The browser already
    // told us; don't spend the reader's seconds re-deriving it. Returning a
    // boolean keeps React Query's own staleness gating intact, and this is
    // evaluated at trigger time, so it reflects the radio at that moment.
    // Deliberately only the DEVICE signal, and deliberately NOT
    // refetchOnReconnect: an evidence-derived Offline can be a latch we're wrong
    // about, and reconnect is when we most want to re-read.
    refetchOnMount: () => !isDeviceOffline(),
    // refetchOnWindowFocus: true so a tab regaining focus past the freshness
    // TTL re-materializes the set. That TTL is 6h for feed queries
    // (configureFeedFreshness, main.tsx), NOT the 5-min global default: the
    // published article set is held STABLE between reads and its top
    // re-materializes only on a load/return past 6h or a pull-to-refresh — never
    // silently under the reader. (More appends older rows at the bottom; it
    // doesn't pull newer top rows in.) Within the TTL, focus/mount/back cost no
    // read.
    // Cross-device pin/done still reflect immediately via the item-state overlay
    // (in place, no reorder — see useFeedInvalidation); only the SET is frozen.
    // refetchOnMount uses the RQ default (true-when-stale), not 'always', so
    // navigating between feed views doesn't hammer the DB either.
    // See SPEC.md *Feed views → A stable set of articles*.
    refetchOnWindowFocus: () => !isDeviceOffline(),
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
