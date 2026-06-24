import {
  useInfiniteQuery,
} from '@tanstack/react-query';
import type { FeedItem } from '../lib/types';
import type { Page } from '../lib/data/DataSource';

export type FetchPage = (cursor: string | null) => Promise<Page<FeedItem>>;

/**
 * Drives a feed view (home / folder / single feed). Pages are fetched lazily
 * (explicit "More", no infinite scroll — SPEC.md *Feed views*). Feed query
 * invalidation on state changes is handled globally by useFeedInvalidation
 * (mounted in App) so mutations on the reader page take effect even while
 * this hook is unmounted.
 */
export function useFeedItems(viewKey: string, fetchPage: FetchPage) {
  const query = useInfiniteQuery({
    queryKey: ['feed', viewKey],
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // refetchOnWindowFocus: true so a tab that regains focus after >5 min
    // picks up new items (SPEC.md "refetch-on-focus + PTR"). The global
    // staleTime (5 min, main.tsx) gates this — no request fires if the data
    // is still fresh, so switching tabs rapidly is cheap.
    // refetchOnMount uses the RQ default (true-when-stale), not 'always',
    // so navigating between feed views doesn't hammer the DB either.
    refetchOnWindowFocus: true,
  });

  const items: FeedItem[] = query.data?.pages.flatMap((p) => p.items) ?? [];

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
