import { useEffect } from 'react';
import {
  useInfiniteQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import type { FeedItem } from '../lib/types';
import type { Page } from '../lib/data/DataSource';

export type FetchPage = (cursor: string | null) => Promise<Page<FeedItem>>;

/**
 * Drives a feed view (home / folder / single feed). Pages are fetched lazily
 * (explicit "More", no infinite scroll — SPEC.md *Feed views*). The query is
 * invalidated whenever item state changes so the Pinned-prepend ordering and
 * Done/Hidden filtering (applied inside the DataSource) stay live after a
 * swipe or toggle.
 */
export function useFeedItems(viewKey: string, fetchPage: FetchPage) {
  const ds = useDataSource();
  const queryClient = useQueryClient();

  const query = useInfiniteQuery({
    queryKey: ['feed', viewKey],
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    // For a feed view, "last time the component mounted" is the freshness
    // signal that matches user intent (newshacker's rule).
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });

  // Re-derive when local item state changes (pin/hide/done affect ordering
  // and filtering inside the DataSource).
  useEffect(() => {
    return ds.stateStore.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
    });
  }, [ds, queryClient, viewKey]);

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
