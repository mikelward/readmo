import type { QueryClient } from '@tanstack/react-query';
import type { DataSource } from './data/DataSource';
import type { FeedItem, ItemId } from './types';

/**
 * Resolve the saved-library / offline rows for `ids`, falling back to the
 * per-item `['item', id]` caches that `useOfflineCacheLock` warms for the
 * pinned/favorited buckets when the batch fetch fails offline. So `/offline`,
 * `/pinned`, and `/favorites` still list their items without connectivity, even
 * on a first visit to the route. Online behavior is unchanged — the batch fetch
 * is used whenever it succeeds.
 *
 * Failure vs. genuinely-empty: a *successful* empty fetch (`getItemsByIds`
 * resolves `[]` — e.g. the ids reference items no longer visible) is a real
 * empty and is returned as-is. But if the batch fetch *throws* and the cache
 * recovers NOTHING, we re-throw rather than masquerading the failure as an empty
 * library: the caller's query goes to `isError`, so a view with persisted ids
 * but no loadable rows shows the LoadError miss-state (naming the cause) instead
 * of a misleading "nothing here". A partial cache hit is still returned (better
 * to show what we have than to error). `/offline` ignores the error and keeps
 * its own "Nothing saved offline yet." copy.
 */
export async function resolveSavedItems(
  ds: DataSource,
  queryClient: QueryClient,
  ids: ItemId[],
): Promise<FeedItem[]> {
  try {
    return await ds.getItemsByIds(ids);
  } catch (err) {
    const cached = ids
      .map((id) => queryClient.getQueryData<FeedItem | null>(['item', id]) ?? null)
      .filter((fi): fi is FeedItem => fi !== null);
    if (cached.length === 0) throw err;
    return cached;
  }
}
