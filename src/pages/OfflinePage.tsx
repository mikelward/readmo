import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  useIsRestoring,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useStateBucket } from '../hooks/useItemState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useOfflineStorageAvailable } from '../hooks/useOfflineStorageAvailable';
import { useDataSource } from '../lib/data/context';
import { ItemRows } from '../components/ItemRows';
import { ListPage } from '../components/ListPage';
import { collectCachedFeedItems, findCachedFeedItem } from '../lib/offlineItem';
import type { ItemStateStore } from '../lib/data/itemState';
import type { FeedItem } from '../lib/types';

/** `/offline` — everything this device can render without the network: the
 * saved items (pinned or favorited) first, then every other article still in
 * the cache from recent fetches. The list is assembled *entirely from the
 * persisted query cache* — it never issues a fetch — so it works regardless of
 * whether connectivity detection (networkStatus) has flipped us to
 * Offline/Down yet. Trying a network read here was the bug: a request that
 * hangs or is mislabeled left the saved set looking empty exactly when the
 * user needed it offline.
 *
 * `useOfflineCacheLock` warms each saved item's `['item', id]` detail at
 * pin/favorite time; we read those first, then fall back to any copy of the
 * item still sitting in a cached feed/library list (`findCachedFeedItem`) so
 * an item loaded into a list — but whose detail warm hasn't landed — still
 * shows. The cached-articles tail is whatever the last successful fetches
 * left behind (feed pages persist whole, including bodies), minus rows the
 * reader dismissed (Done/Hidden), newest first. */
export function OfflinePage() {
  const queryClient = useQueryClient();
  const ds = useDataSource();
  const pinned = useStateBucket('pinned');
  const favorite = useStateBucket('favorite');
  // The list reads the persisted query cache, which PersistQueryClientProvider
  // only fills after first paint. Until that completes the cache looks empty —
  // without this guard the "Nothing saved offline yet" copy flashes for users
  // who do have saved items cached.
  const isRestoring = useIsRestoring();
  // Offline caching needs a usable IndexedDB. In a private/incognito session or
  // with site storage blocked it isn't, so nothing the user pins ever persists —
  // say so instead of showing a misleading "nothing saved" empty state.
  const storageAvailable = useOfflineStorageAvailable();
  useDocumentTitle('Offline · readmo');

  // Pinned first, then favorited; both buckets are already newest-first.
  const ids = useMemo(
    () => Array.from(new Set([...pinned, ...favorite])),
    [pinned, favorite],
  );

  // Re-derive the offline set from the persisted query cache, re-rendering only
  // when the *resolved* set actually changes (the offline-cache lock warming a
  // just-pinned item, or hydration landing persisted entries, both surface here).
  const items = useOfflineItems(queryClient, ds.stateStore, ids);

  // Pick the empty-state copy for what's actually true:
  //  - storage unavailable (private mode / blocked): caching can't work at all;
  //  - have saved items but nothing renderable here: don't claim you saved
  //    nothing (the bug report: "saying I haven't pinned anything, which is
  //    untrue");
  //  - genuinely nothing saved and nothing cached.
  const emptyLabel =
    storageAvailable === false
      ? 'Please exit incognito mode or grant database permission to use offline mode.'
      : ids.length > 0
        ? "Your saved items aren't on this device yet. Open one while online to keep a copy here."
        : 'Nothing saved offline yet. Pin or favorite items to keep a copy.';

  return (
    <ListPage header={<h1 className="page-header__title">Offline</h1>}>
      <ItemRows
        items={items}
        isLoading={isRestoring && items.length === 0}
        emptyLabel={emptyLabel}
      />
    </ListPage>
  );
}

/** Assemble the offline list from the persisted query cache and keep it
 * current as the cache and the item-state store change, without the
 * render↔event feedback loop a naive `getQueryCache().subscribe(() =>
 * bumpState())` causes here.
 *
 * The list is the saved ids' rows first (pinned ∪ favorited, resolved from
 * the warmed `['item', id]` details with a cached-list fallback), then every
 * other cached article (`collectCachedFeedItems`) that the reader hasn't
 * dismissed — Done/Hidden rows are the completion log, not offline reading
 * material.
 *
 * Two things make it loop-proof:
 *  1. We only wake on events that change query *data* (`added`/`removed`/
 *     `updated`) or the item-state store. The cache also fires
 *     `observerOptionsUpdated` etc. on every render of any descendant query
 *     observer (e.g. `ItemRows`' open-original lookup re-runs `useQuery` with
 *     a fresh options object each render) — and reacting to those is exactly
 *     what spun forever before, leaking memory until the test worker OOMed.
 *  2. The snapshot is referentially stable while the resolved set is unchanged,
 *     so `useSyncExternalStore` skips the re-render — a data event that doesn't
 *     affect our items can't trigger a child re-render and so can't feed back. */
function useOfflineItems(
  queryClient: QueryClient,
  stateStore: ItemStateStore,
  ids: string[],
): FeedItem[] {
  // Holds the last snapshot so getSnapshot can return the same reference while
  // nothing relevant changed (useSyncExternalStore's stability rule).
  const last = useRef<FeedItem[]>([]);

  const getSnapshot = useCallback((): FeedItem[] => {
    const savedIds = new Set(ids);
    const saved = ids
      .map(
        (id) =>
          queryClient.getQueryData<FeedItem | null>(['item', id]) ??
          findCachedFeedItem(queryClient, id),
      )
      .filter((fi): fi is FeedItem => fi != null);
    const cached = collectCachedFeedItems(queryClient).filter((fi) => {
      if (savedIds.has(fi.item.id)) return false;
      const st = stateStore.get(fi.item.id);
      return !st.done && !st.hidden;
    });
    const next = [...saved, ...cached];
    // Compare by element identity, not just id: React Query's structural
    // sharing hands back a new object only when the row data actually changed,
    // so this also re-renders when a row already shown from a cached feed list
    // is replaced by the warmed (preferred) `['item', id]` copy — while still
    // returning the stable previous array when nothing changed, so an unrelated
    // event can't trigger a re-render (and thus can't feed back into a loop).
    const prev = last.current;
    if (prev.length === next.length && prev.every((fi, i) => fi === next[i])) {
      return prev;
    }
    last.current = next;
    return next;
  }, [queryClient, stateStore, ids]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubCache = queryClient.getQueryCache().subscribe((event) => {
        if (
          event.type === 'added' ||
          event.type === 'removed' ||
          event.type === 'updated'
        ) {
          onStoreChange();
        }
      });
      // A dismiss (Done/Hidden) drops a cached article from the tail; an undo
      // brings it back — both arrive via the item-state store, not the cache.
      const unsubStore = stateStore.subscribe(onStoreChange);
      return () => {
        unsubCache();
        unsubStore();
      };
    },
    [queryClient, stateStore],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
