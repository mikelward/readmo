import { useCallback, useEffect, useRef } from 'react';
import {
  QueryObserver,
  useIsRestoring,
  useQueryClient,
} from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useOnlineStatus } from './useOnlineStatus';
import { fullTextStaleTime, looksTruncated } from '../lib/fullText';
import type { FullTextResult } from '../lib/fullText';
import type { FeedItem } from '../lib/types';
import { extractProxiedImageUrls } from '../lib/extractProxiedImageUrls';

/** Fire-and-forget fetch for each proxied image URL so the SW caches them. */
function prefetchImages(html: string): void {
  for (const url of extractProxiedImageUrls(html)) {
    fetch(url).catch(() => {});
  }
}

/**
 * Durable offline cache for the offline buckets — **pinned or favorited** items
 * (SPEC.md *Prefetch on Pin/Favorite*; these are exactly the items `/offline`
 * lists). While an item is in either bucket we keep its reader queries alive in
 * the persisted React Query cache so it reads offline:
 *   - `['item', id]`     — the item detail + sanitized feed body, and
 *   - `['fulltext', id]` — the extracted reading body, for truncated feeds.
 *
 * An idle (`enabled: false`) observer per query blocks garbage collection while
 * the item stays bucketed — including across a reload, since on mount we re-lock
 * from the hydrated state. An entry is evicted only once the item is in NO
 * offline bucket (so unpinning an item that's still favorited keeps its cache).
 *
 * Warming the data is gated on connectivity: bucketing an item while offline
 * still locks it (protecting any hydrated copy), and the prefetch is retried on
 * the offline→online transition, so a pin made offline fills in on reconnect.
 *
 * Mount once near the app root. It subscribes to the shared item-state store, so
 * it reacts to every pin/favorite path centrally.
 */
export function useOfflineCacheLock(): void {
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  // True while PersistQueryClientProvider is restoring the cache. Warming must
  // wait for it: running before hydration completes would see an empty cache and
  // refetch every saved item on boot (the `hadDetail` check + staleTime guard
  // only help once the persisted entries are actually back).
  const isRestoring = useIsRestoring();

  // Connectivity / restore state read at warm time without re-running the lock
  // effect (which would tear down every observer) on each change.
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const restoringRef = useRef(isRestoring);
  restoringRef.current = isRestoring;
  // Shared across the lock effect and the reconnect effect.
  const locks = useRef(new Map<string, () => void>()).current; // id -> release
  const warmed = useRef(new Set<string>()).current; // ids whose data is cached

  // Populate an item's reader queries (idempotent). No-op when offline or
  // already warmed. An id is only marked warmed once it's FULLY cached — detail
  // present, and for a truncated feed a *terminal* full-text result (ok/empty/
  // auth). A detail miss or a transient `unreachable` full-text leaves it
  // unwarmed so a later sync / reconnect retries it.
  const warm = useCallback(
    (id: string) => {
      if (restoringRef.current || !onlineRef.current || warmed.has(id)) return;
      // Was the detail already cached before this warm? If not, a successful
      // fetch newly makes the item renderable, so the /offline list (which can
      // assemble from per-item caches) should refresh.
      const hadDetail = queryClient.getQueryData(['item', id]) != null;
      void queryClient
        .prefetchQuery({
          queryKey: ['item', id],
          queryFn: () => ds.getItem(id),
          gcTime: Number.POSITIVE_INFINITY,
          // Offline-retention prefetch: only fetch when there's NO cached copy.
          // Treat an existing (hydrated) detail as fresh so re-locking the saved
          // set on boot/reconnect doesn't refetch getItem for every saved id —
          // the reader refreshes with its own default-staleTime query on open.
          staleTime: Number.POSITIVE_INFINITY,
        })
        .then(async () => {
          const fi = queryClient.getQueryData<FeedItem | null>(['item', id]);
          if (!fi) {
            // getItem returned null (offline, or RLS not yet exposing a
            // just-pinned item before its item_state row flushes). Don't let
            // staleTime:Infinity pin that miss as fresh — drop it so a later
            // sync/reconnect warm actually retries getItem.
            queryClient.removeQueries({ queryKey: ['item', id], exact: true });
            return;
          }
          // Newly cached → refresh any saved-list view (/offline, /pinned,
          // /favorites) showing a stale partial set. Skipped when the detail was
          // already cached, so boot doesn't churn.
          if (!hadDetail) {
            void queryClient.invalidateQueries({ queryKey: ['offline'] });
            void queryClient.invalidateQueries({ queryKey: ['library'] });
          }
          // Prefetch images from feed body so the SW caches them for offline.
          prefetchImages(fi.item.contentHtml);
          // fullContentHtml may already be populated (e.g. fetched on a prior
          // open or by another device); scan it now before the truncation check
          // so its images are cached even when looksTruncated returns false.
          if (fi.item.fullContentHtml) prefetchImages(fi.item.fullContentHtml);

          if (!looksTruncated(fi.item)) {
            warmed.add(id); // nothing more to fetch
            return;
          }
          // Truncated feed: also need the extracted reading body. Only mark
          // warmed on a terminal result — a transient `unreachable` stays
          // retryable so we don't get stuck on the feed stub.
          await queryClient.prefetchQuery({
            queryKey: ['fulltext', id],
            queryFn: () => ds.fetchFullText(id),
            staleTime: fullTextStaleTime,
            gcTime: Number.POSITIVE_INFINITY,
          });
          const ft = queryClient.getQueryData<FullTextResult>(['fulltext', id]);
          if (ft?.contentHtml) prefetchImages(ft.contentHtml);
          if (ft && ft.status !== 'unreachable') warmed.add(id);
        });
    },
    [ds, queryClient, warmed],
  );

  // Lock/unlock cache entries as items enter/leave the offline buckets.
  useEffect(() => {
    const store = ds.stateStore;

    const lock = (id: string) => {
      if (!locks.has(id)) {
        // Idle observers hold the entries in cache (an observer — even disabled
        // — prevents GC); they never fetch.
        const observers = [
          new QueryObserver(queryClient, {
            queryKey: ['item', id],
            queryFn: () => ds.getItem(id),
            enabled: false,
          }),
          new QueryObserver(queryClient, {
            queryKey: ['fulltext', id],
            queryFn: () => ds.fetchFullText(id),
            enabled: false,
          }),
        ];
        const unsubscribers = observers.map((obs) => obs.subscribe(() => {}));
        locks.set(id, () => unsubscribers.forEach((un) => un()));
      }
      warm(id);
    };

    const unlock = (id: string) => {
      const release = locks.get(id);
      if (!release) return;
      release();
      locks.delete(id);
      warmed.delete(id);
      queryClient.removeQueries({ queryKey: ['fulltext', id], exact: true });
      queryClient.removeQueries({ queryKey: ['item', id], exact: true });
    };

    const sync = () => {
      // Pinned OR favorited = the offline bucket (matches /offline). Locking on
      // either keeps an item cached while it's still favorited after an unpin.
      const bucketed = new Set(
        store
          .entries()
          .filter(([, s]) => s.pinned || s.favorite)
          .map(([id]) => id),
      );
      for (const id of bucketed) lock(id);
      for (const id of [...locks.keys()]) if (!bucketed.has(id)) unlock(id);
    };

    sync(); // initial pass re-locks already-bucketed (hydrated) items
    const unsubscribe = store.subscribe(sync);
    return () => {
      unsubscribe();
      for (const release of locks.values()) release();
      locks.clear();
      warmed.clear();
    };
  }, [ds, queryClient, warm, locks, warmed]);

  // Warm locked items once it's both safe and useful: after the persisted cache
  // has been restored (so hydrated copies are seen, not refetched) and while
  // online. Also covers the reconnect case — an item bucketed while offline is
  // locked but unwarmed, and fills in when connectivity returns.
  useEffect(() => {
    if (isRestoring || !online) return;
    for (const id of locks.keys()) warm(id);
  }, [online, isRestoring, warm, locks]);
}
