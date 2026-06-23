import type { QueryClient } from '@tanstack/react-query';
import type { DataSource } from './data/DataSource';
import type { FeedItem, ItemId } from './types';

/**
 * Resolve the saved-library / offline rows for `ids`, falling back to the
 * per-item `['item', id]` caches that `useOfflineCacheLock` warms for the
 * pinned/favorited buckets when the batch fetch fails offline. So `/offline`,
 * `/pinned`, and `/favorites` still list their items without connectivity
 * instead of showing an empty/error state, even on a first visit to the route.
 * Online behavior is unchanged — the batch fetch is used whenever it succeeds.
 */
export async function resolveSavedItems(
  ds: DataSource,
  queryClient: QueryClient,
  ids: ItemId[],
): Promise<FeedItem[]> {
  try {
    return await ds.getItemsByIds(ids);
  } catch {
    return ids
      .map((id) => queryClient.getQueryData<FeedItem | null>(['item', id]) ?? null)
      .filter((fi): fi is FeedItem => fi !== null);
  }
}
