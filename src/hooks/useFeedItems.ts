import {
  useInfiniteQuery,
} from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
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
  const ds = useDataSource();

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
  const total = query.data?.pages[0]?.total ?? 0;

  return {
    items,
    total,
    isLoading: query.isLoading,
    isError: query.isError,
    hasMore: query.hasNextPage ?? false,
    isFetchingMore: query.isFetchingNextPage,
    fetchMore: query.fetchNextPage,
    refetch: query.refetch,
    // Background refresh: data already present and a refetch is in flight.
    isRefreshing: !!query.data && query.isFetching && !query.isFetchingNextPage,
    refreshFailed: !!query.data && query.isError,
  };
}
