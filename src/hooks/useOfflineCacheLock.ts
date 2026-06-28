import { useCallback, useEffect, useRef } from 'react';
import {
  QueryObserver,
  useIsRestoring,
  useQueryClient,
} from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useOnlineStatus } from './useOnlineStatus';
import { useAuth } from './useAuth';
import { fullTextStaleTime, isFullTextSettled, looksTruncated } from '../lib/fullText';
import {
  CAPABILITIES_QUERY_KEY,
  canUseFullText,
  useCapabilitiesQuery,
} from './useCapabilities';
import type { Capabilities } from '../lib/data/DataSource';
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
  // Subset of `warmed` marked warmed ONLY because reading mode was gated off for
  // this user (not a settled fetch). If membership later flips to family we
  // un-warm and re-warm these so their full-text body fills the offline bucket.
  const gateSkipped = useRef(new Set<string>()).current;
  // Tri-state reading-mode gate for the fulltext prefetch, derived from the
  // capabilities query:
  //   'allowed' — issue the fulltext call.
  //   'denied'  — armed allowlist, off-list → gate-skip (mark warmed+gateSkipped).
  //   'unknown' — signed-in with no resolved capabilities yet (loading OR
  //               errored) → HOLD OFF (don't fetch, don't mark) so an off-list
  //               user makes zero Edge calls until we know the gate; re-warmed
  //               once it resolves.
  // The "unknown" condition keys off the user (the query is enabled iff signed
  // in), NOT fetchStatus — a transient `get_capabilities` failure ends 'idle'
  // with no data, which must still hold off rather than read as open. Signed out
  // → the query is disabled, no gate to wait on → allowed.
  // `fullTextGate` is the reactive value that drives the re-warm effect below.
  // warm() itself reads the capability VALUE synchronously from the cache (so a
  // just-written membership change is honored without waiting for a render); the
  // only thing it needs from React state is whether the gate is unresolved, via
  // `capsUnresolvedRef`.
  const { user } = useAuth();
  const capsQuery = useCapabilitiesQuery();
  const capsUnresolved = !!user && !capsQuery.data;
  const capsUnresolvedRef = useRef(capsUnresolved);
  capsUnresolvedRef.current = capsUnresolved;
  const fullTextGate: 'allowed' | 'denied' | 'unknown' = capsQuery.data
    ? canUseFullText(capsQuery.data)
      ? 'allowed'
      : 'denied'
    : capsUnresolved
      ? 'unknown'
      : 'allowed'; // disabled (signed out, old backend) → no gate to wait on

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
          // Reading mode is allowlist-gated. Read the capability VALUE live from
          // the cache so a just-written membership change is honored immediately.
          //  - DENIED (armed allowlist, off-list): the fulltext call would only
          //    ever return the silent `retryable` denial, and since that's never
          //    "settled" the item would be re-prefetched on EVERY store emit (the
          //    off-list amplification the reviewer flagged). Mark it warmed so the
          //    emits stop, but record it in `gateSkipped` too — it's a capability
          //    skip, not a settled fetch — so the gate effect below un-warms and
          //    re-warms it the moment membership flips to family (without it the
          //    top-of-warm `warmed.has(id)` guard would strand it on the stub).
          //  - UNKNOWN (signed-in, caps unresolved → no cached value yet, loading
          //    OR errored): HOLD OFF — don't fetch, don't mark — so an off-list
          //    user makes zero `fulltext` calls until the gate is known. A later
          //    resolve re-warms (the gate effect below); the next store emit also
          //    retries it.
          const caps = queryClient.getQueryData<Capabilities>(CAPABILITIES_QUERY_KEY);
          if (caps && !canUseFullText(caps)) {
            warmed.add(id);
            gateSkipped.add(id);
            return;
          }
          if (!caps && capsUnresolvedRef.current) return;
          // Allowed → this id is no longer a gated skip.
          gateSkipped.delete(id);
          // Truncated feed: also need the extracted reading body. Only mark
          // warmed on a SETTLED result — a transient `unreachable`, or a
          // retryable allowlist denial that a later allowlist change could flip,
          // stays unwarmed so a later reconnect/state-sync re-prefetches it
          // instead of leaving the offline cache stuck on the feed stub.
          await queryClient.prefetchQuery({
            queryKey: ['fulltext', id],
            queryFn: () => ds.fetchFullText(id),
            staleTime: fullTextStaleTime,
            gcTime: Number.POSITIVE_INFINITY,
          });
          const ft = queryClient.getQueryData<FullTextResult>(['fulltext', id]);
          if (ft?.contentHtml) prefetchImages(ft.contentHtml);
          if (ft && isFullTextSettled(ft)) warmed.add(id);
        });
    },
    [ds, queryClient, warmed, gateSkipped],
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

  // The reading-mode gate changed: capabilities resolved (unknown → allowed/
  // denied) or membership flipped to family (denied → allowed). Re-warm locked
  // items so the ones held off while 'unknown', or gate-skipped while 'denied',
  // fetch their full body now. When the gate is 'allowed' we first clear the
  // gate-skip marks so the top-of-warm `warmed.has` guard doesn't strand them.
  useEffect(() => {
    if (restoringRef.current || !onlineRef.current) return;
    if (fullTextGate === 'allowed' && gateSkipped.size > 0) {
      for (const id of gateSkipped) warmed.delete(id);
      gateSkipped.clear();
    }
    for (const id of locks.keys()) warm(id);
  }, [fullTextGate, warm, locks, warmed, gateSkipped]);
}
