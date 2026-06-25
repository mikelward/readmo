import { useEffect, useMemo, useState } from 'react';
import { useIsRestoring, useQueryClient } from '@tanstack/react-query';
import { useStateBucket } from '../hooks/useItemState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { ItemRows } from '../components/ItemRows';
import { ListPage } from '../components/ListPage';
import { findCachedFeedItem } from '../lib/offlineItem';
import type { FeedItem } from '../lib/types';

/** `/offline` — the saved items (pinned or favorited) this device can render
 * without the network. The list is assembled *entirely from the persisted query
 * cache* — it never issues a fetch — so it works regardless of whether
 * connectivity detection (networkStatus) has flipped us to Offline/Down yet.
 * Trying a network read here was the bug: a request that hangs or is mislabeled
 * left the saved set looking empty exactly when the user needed it offline.
 *
 * `useOfflineCacheLock` warms each saved item's `['item', id]` detail at
 * pin/favorite time; we read those first, then fall back to any copy of the item
 * still sitting in a cached feed/library list (`findCachedFeedItem`) so an item
 * loaded into a list — but whose detail warm hasn't landed — still shows. */
export function OfflinePage() {
  const queryClient = useQueryClient();
  const pinned = useStateBucket('pinned');
  const favorite = useStateBucket('favorite');
  // The list reads the persisted query cache, which PersistQueryClientProvider
  // only fills after first paint. Until that completes the cache looks empty —
  // without this guard the "Nothing saved offline yet" copy flashes for users
  // who do have saved items cached.
  const isRestoring = useIsRestoring();
  useDocumentTitle('Offline · readmo');

  // Re-derive on any cache mutation: the offline-cache lock warming a
  // just-pinned item, or hydration landing the persisted entries, both surface
  // here. Reading the cache (below) never emits, so this can't loop.
  const [cacheVersion, setCacheVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      setCacheVersion((v) => v + 1);
    });
    // Recompute once now: an item warmed in the gap between the initial render's
    // cache read and this subscription would otherwise be missed — a
    // non-truncated item's warm is a single prefetch that emits no later event,
    // so without this the page could stay on the empty state with the item
    // already cached.
    setCacheVersion((v) => v + 1);
    return unsubscribe;
  }, [queryClient]);

  // Pinned first, then favorited; both buckets are already newest-first.
  const ids = useMemo(
    () => Array.from(new Set([...pinned, ...favorite])),
    [pinned, favorite],
  );

  const items = useMemo<FeedItem[]>(() => {
    void cacheVersion; // recompute whenever the cache changes
    return ids
      .map(
        (id) =>
          queryClient.getQueryData<FeedItem | null>(['item', id]) ??
          findCachedFeedItem(queryClient, id),
      )
      .filter((fi): fi is FeedItem => fi != null);
  }, [ids, cacheVersion, queryClient]);

  return (
    <ListPage header={<h1 className="page-header__title">Offline</h1>}>
      <ItemRows
        items={items}
        isLoading={isRestoring && items.length === 0}
        emptyLabel="Nothing saved offline yet. Pin or favorite items to keep a copy."
      />
    </ListPage>
  );
}
