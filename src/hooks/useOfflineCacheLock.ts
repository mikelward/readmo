import { useCallback, useEffect, useRef } from 'react';
import {
  QueryObserver,
  useIsRestoring,
  useQueryClient,
} from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useOnlineStatus } from './useOnlineStatus';
import { fullTextStaleTime, looksTruncated } from '../lib/fullText';
import type { FullTextResult } from '../lib/fullText';
import type { FeedItem } from '../lib/types';
import { extractProxiedImageUrls } from '../lib/extractProxiedImageUrls';
import { createConcurrencyLimiter } from '../lib/concurrencyLimiter';

// Bounds the boot/reconnect fan-out: a user with many saved items would otherwise
// fire one getItem (+ fetchFullText for truncated feeds) per item concurrently —
// a self-inflicted burst on the backend. Detail (getItem) and full-text
// extraction run on SEPARATE pools so the cheap, offline-visibility-critical
// detail read never waits behind a slow extraction: the full-text Edge call can
// take tens of seconds and isn't capped by the read timeout, so sharing one pool
// would let a few slow extractions head-of-line-block the rest of the saved set's
// details. Both caps stay below the request circuit breaker's failure threshold
// so a *failing* warmup never single-handedly trips the data-plane breaker.
const OFFLINE_WARM_CONCURRENCY = 4; // concurrent detail (getItem) warms
const OFFLINE_FULLTEXT_CONCURRENCY = 2; // concurrent full-text extractions (heavier)

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
  const inFlight = useRef(new Set<string>()).current; // ids being warmed right now
  // ids whose warm a reconnect/sync requested while one was already in flight —
  // replayed once when that warm finishes if it didn't fully cache the item.
  const rewarmRequested = useRef(new Set<string>()).current;
  // Two pools: detail (getItem) warms drain fast; truncated feeds then extract on
  // a separate pool so slow full-text extraction can't block other items' details.
  const detailLimiter = useRef(
    createConcurrencyLimiter(OFFLINE_WARM_CONCURRENCY),
  ).current;
  const fullTextLimiter = useRef(
    createConcurrencyLimiter(OFFLINE_FULLTEXT_CONCURRENCY),
  ).current;

  // Holds the latest `warm` so an in-flight warm can replay a coalesced retry
  // without `warm` depending on itself (an inline self-reference can't be
  // expressed in a useCallback dep list). Assigned right after `warm` is defined.
  const warmRef = useRef<(id: string) => void>(() => {});

  // Populate an item's reader queries (idempotent). No-op when offline or
  // already warmed. An id is only marked warmed once it's FULLY cached — detail
  // present, and for a truncated feed a *terminal* full-text result (ok/empty/
  // auth). A detail miss or a transient `unreachable` full-text leaves it
  // unwarmed so a later sync / reconnect retries it.
  const warm = useCallback(
    (id: string) => {
      if (restoringRef.current || !onlineRef.current || warmed.has(id)) return;
      if (inFlight.has(id)) {
        // A warm for this id is already running. Don't start a duplicate, but
        // remember that another trigger (reconnect/sync) wanted it: if the
        // in-flight attempt finishes WITHOUT fully caching (null detail / a
        // transient `unreachable` full-text), we replay it once when it settles
        // rather than waiting for some unrelated later event (a connectivity flap
        // can deliver the online event before the failing request resolves).
        rewarmRequested.add(id);
        return;
      }
      inFlight.add(id);

      // Drop an offline-retention entry this warm resurrected after an unlock —
      // but only if nothing is actively observing it. After unlock the lock's idle
      // observers are released, so a remaining observer means a reader/list opened
      // the same key; evicting it would force a needless refetch, and the reader
      // owns its own (non-Infinity gcTime) entry now.
      const dropIfUnobserved = (key: QueryKey) => {
        const q = queryClient.getQueryCache().find({ queryKey: key, exact: true });
        if (q && q.getObserversCount() > 0) return;
        queryClient.removeQueries({ queryKey: key, exact: true });
      };

      // Phase 1 — DETAIL (getItem), on the fast pool. Returns true if the feed is
      // truncated and still needs full-text extraction. A queued warm re-checks
      // restore/online/warmed/locks at start (it may have waited while the item
      // was unpinned and unlock()'d — warming it then would resurrect its
      // gcTime:Infinity entries for evicted content).
      const warmDetail = async (): Promise<boolean> => {
        if (
          restoringRef.current ||
          !onlineRef.current ||
          warmed.has(id) ||
          !locks.has(id)
        ) {
          return false;
        }
        // Was the detail already cached before this warm? If not, a successful
        // fetch newly makes the item renderable, so the /offline list (which can
        // assemble from per-item caches) should refresh.
        const hadDetail = queryClient.getQueryData(['item', id]) != null;
        await queryClient.prefetchQuery({
          queryKey: ['item', id],
          queryFn: () => ds.getItem(id),
          gcTime: Number.POSITIVE_INFINITY,
          // Offline-retention prefetch: only fetch when there's NO cached copy.
          // Treat an existing (hydrated) detail as fresh so re-locking the saved
          // set on boot/reconnect doesn't refetch getItem for every saved id —
          // the reader refreshes with its own default-staleTime query on open.
          staleTime: Number.POSITIVE_INFINITY,
        });
        if (!locks.has(id)) {
          // Unlocked while the detail was in flight — drop the resurrected entry
          // so unpinned content doesn't linger at gcTime:Infinity, unless the user
          // has opened the article (a reader now observes the same key — don't
          // evict the detail they just requested).
          dropIfUnobserved(['item', id]);
          return false;
        }
        const fi = queryClient.getQueryData<FeedItem | null>(['item', id]);
        if (!fi) {
          // getItem returned null (offline, or RLS not yet exposing a
          // just-pinned item before its item_state row flushes). Don't let
          // staleTime:Infinity pin that miss as fresh — drop it so a later
          // sync/reconnect warm actually retries getItem.
          queryClient.removeQueries({ queryKey: ['item', id], exact: true });
          return false;
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
          return false;
        }
        return true; // truncated → needs full-text extraction (phase 2)
      };

      // Phase 2 — FULL-TEXT extraction, on the separate (heavier) pool. Only mark
      // warmed on a terminal result — a transient `unreachable` stays retryable so
      // we don't get stuck on the feed stub.
      const warmFullText = async (): Promise<void> => {
        // Re-check: the item may have been unpinned while this waited for an
        // extraction slot (the full-text pool can be backed up by slow Edge calls).
        if (!onlineRef.current || warmed.has(id) || !locks.has(id)) return;
        await queryClient.prefetchQuery({
          queryKey: ['fulltext', id],
          queryFn: () => ds.fetchFullText(id),
          staleTime: fullTextStaleTime,
          gcTime: Number.POSITIVE_INFINITY,
        });
        if (!locks.has(id)) {
          // Unlocked while the reading body was in flight. Drop only what THIS
          // step resurrected — the full-text key — and only if no reader is
          // observing it (the ['item', id] entry was already evicted by unlock();
          // never touch it here, and don't evict a reading body the user is
          // actively viewing).
          dropIfUnobserved(['fulltext', id]);
          return;
        }
        const ft = queryClient.getQueryData<FullTextResult>(['fulltext', id]);
        if (ft?.contentHtml) prefetchImages(ft.contentHtml);
        // Only mark warmed if the detail is STILL cached. `warmed` means FULLY
        // cached (detail + terminal full-text). An unlock during this phase evicts
        // ['item', id]; if the item was then re-pinned (re-locking it, so the
        // !locks guard above passes), marking it warmed here would suppress the
        // replay that must re-fetch the now-missing detail — leaving a bucketed
        // item absent from /offline until a reload.
        const detailCached = queryClient.getQueryData(['item', id]) != null;
        if (ft && ft.status !== 'unreachable' && detailCached) warmed.add(id);
      };

      // Run detail first (frees its slot before extraction starts), then — only if
      // truncated — full-text on its own pool, so a slow extraction can't
      // head-of-line-block other items' details. The in-flight guard is released
      // after BOTH phases so a later sync/reconnect can retry an id that didn't
      // reach `warmed`.
      void (async () => {
        try {
          if (await detailLimiter.run(warmDetail)) {
            await fullTextLimiter.run(warmFullText);
          }
        } finally {
          inFlight.delete(id);
          // Replay a retry that was requested while this warm was in flight, if it
          // didn't fully cache and the item is still wanted and reachable.
          if (
            rewarmRequested.delete(id) &&
            !warmed.has(id) &&
            locks.has(id) &&
            onlineRef.current &&
            !restoringRef.current
          ) {
            warmRef.current?.(id);
          }
        }
      })().catch(() => {});
    },
    [
      ds,
      queryClient,
      warmed,
      inFlight,
      rewarmRequested,
      detailLimiter,
      fullTextLimiter,
      locks,
    ],
  );
  warmRef.current = warm;

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
      inFlight.clear();
      rewarmRequested.clear();
    };
  }, [ds, queryClient, warm, locks, warmed, inFlight, rewarmRequested]);

  // Warm locked items once it's both safe and useful: after the persisted cache
  // has been restored (so hydrated copies are seen, not refetched) and while
  // online. Also covers the reconnect case — an item bucketed while offline is
  // locked but unwarmed, and fills in when connectivity returns.
  useEffect(() => {
    if (isRestoring || !online) return;
    for (const id of locks.keys()) warm(id);
  }, [online, isRestoring, warm, locks]);
}
