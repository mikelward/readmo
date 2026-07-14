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
import { summaryStaleTime } from '../lib/summary';
import { summaryQueryKey } from './useSummary';
import { useAutoSummarizePinned } from './useReadingPrefs';
import {
  CAPABILITIES_QUERY_KEY,
  canUseFullText,
  useCapabilitiesQuery,
} from './useCapabilities';
import type { Capabilities } from '../lib/data/DataSource';
import type { FullTextResult } from '../lib/fullText';
import type { FeedItem } from '../lib/types';
import { extractProxiedImageUrls } from '../lib/extractProxiedImageUrls';

const FULL_TEXT_WARM_RETRY_BASE_MS = 2_000;
const FULL_TEXT_WARM_RETRY_MAX_MS = 30_000;
const FULL_TEXT_WARM_MAX_RETRIES = 6;

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
 *   - `['item', id]`     — the item detail + sanitized feed body,
 *   - `['fulltext', id]` — the extracted reading body, for truncated feeds, and
 *   - `['summary', id]`  — the AI summary (the 0058 ride-along seeds it here via
 *                          `useSummary`; retaining it keeps the gist offline like
 *                          the body, rather than only in the GC-able feed cache).
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
 *
 * For an allowlisted user, a PIN's sync write also triggers the full-text
 * download (and AI summary) SERVER-side — the 0053/0054 pin trigger — so the
 * shared item usually already carries `full_content_html` by the time this
 * hook warms it; the warm here is then a cheap cache hit that just fills the
 * device cache. This hook remains the only warmer for favorites and for the
 * feed-body/image caching.
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
  // The family-only "Auto generate summaries for pinned articles" opt-out (on by
  // default). When off, the summary warm below is skipped — same gate as
  // useSummaryPrewarm, so turning it off warms no summaries ahead of time.
  const { autoSummarizePinned } = useAutoSummarizePinned();

  // Connectivity / restore state read at warm time without re-running the lock
  // effect (which would tear down every observer) on each change.
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const restoringRef = useRef(isRestoring);
  restoringRef.current = isRestoring;
  const autoSummarizeRef = useRef(autoSummarizePinned);
  autoSummarizeRef.current = autoSummarizePinned;
  // Shared across the lock effect and the reconnect effect.
  const locks = useRef(new Map<string, () => void>()).current; // id -> release
  const warmed = useRef(new Set<string>()).current; // ids whose data is cached
  // Subset of `warmed` marked warmed ONLY because reading mode was gated off for
  // this user (not a settled fetch). If membership later flips to family we
  // un-warm and re-warm these so their full-text body fills the offline bucket.
  const gateSkipped = useRef(new Set<string>()).current;
  // Ids whose AI summary has been warmed to a SETTLED result — tracked separately
  // from `warmed` (the full-text marker) so the summary warm runs independently:
  // an item whose full text has settled may still be missing its summary.
  const summaryWarmed = useRef(new Set<string>()).current;
  // Pending full-text retries for pinned items whose first warm hit a transient
  // result while the server-side pin trigger was still fetching/extracting.
  const fullTextRetryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>()).current;
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

  const cancelFullTextRetry = useCallback(
    (id: string) => {
      const timer = fullTextRetryTimers.get(id);
      if (timer !== undefined) {
        clearTimeout(timer);
        fullTextRetryTimers.delete(id);
      }
    },
    [fullTextRetryTimers],
  );

  const warmRef = useRef<(id: string, fullTextAttempt?: number) => void>(() => {});

  const scheduleFullTextRetry = useCallback(
    (id: string, attempt: number) => {
      if (attempt >= FULL_TEXT_WARM_MAX_RETRIES) return;
      if (fullTextRetryTimers.has(id)) return;
      const delay = Math.min(
        FULL_TEXT_WARM_RETRY_BASE_MS * 2 ** attempt,
        FULL_TEXT_WARM_RETRY_MAX_MS,
      );
      const timer = setTimeout(() => {
        fullTextRetryTimers.delete(id);
        if (!ds.stateStore.get(id).pinned || warmed.has(id)) return;
        warmRef.current(id, attempt + 1);
      }, delay);
      fullTextRetryTimers.set(id, timer);
    },
    [ds, warmed, fullTextRetryTimers],
  );

  // Warm a PINNED item's AI summary into `['summary', id]`, durably (gcTime
  // Infinity, like the full-text prefetch), so it's cached before the reader opens
  // — no on-open "Summarizing…". Runs on the same reliable triggers as the
  // full-text warm (pin/favorite sync, boot restore, reconnect, gate resolve),
  // which is what makes the summary as dependable as the article body; the reader
  // and useSummaryPrewarm (its fresh-pin unsettled backoff) share this key, so
  // whoever fills it first wins. Separate from `warm`'s `warmed` gate on purpose.
  const warmSummary = useCallback(
    (id: string) => {
      if (restoringRef.current || !onlineRef.current || summaryWarmed.has(id)) return;
      // Family opt-out.
      if (!autoSummarizeRef.current) return;
      // PINNED-only: a pin is what fires server-side generation (0053/0054), so
      // warming a pinned summary is a cheap cache hit. A favorite-only item has no
      // server generation, so warming it would spend a Gemini call the
      // auto-summarize design deliberately keeps to pins — skip it.
      if (!ds.stateStore.get(id).pinned) return;
      // Allowlist gate, read live from the cache (same as the full-text warm).
      // Denied → no call, no mark (a cheap re-check next trigger). Unknown (caps
      // unresolved) → hold off until the gate resolves, so an off-list user makes
      // zero Edge calls.
      const caps = queryClient.getQueryData<Capabilities>(CAPABILITIES_QUERY_KEY);
      if (caps && !canUseFullText(caps)) return;
      if (!caps && capsUnresolvedRef.current) return;
      void queryClient
        .prefetchQuery({
          queryKey: summaryQueryKey(id),
          queryFn: () => ds.getSummary(id),
          staleTime: summaryStaleTime,
          gcTime: Number.POSITIVE_INFINITY,
        })
        .then(() => {
          // Mark warmed after ONE attempt regardless of the outcome. An unsettled
          // result (transient unreachable/unavailable, or the server still
          // generating) must NOT be retried per state emit here: warmSummary runs
          // before the full-text `warmed` guard, so every bucketed-item emit would
          // otherwise re-hit the summary Edge Function during an outage. The
          // bounded retry-until-settled is useSummaryPrewarm's job, and the lock's
          // idle observer keeps this entry durable either way. (An unresolved
          // allowlist gate returns earlier without marking, so it still re-warms
          // once the gate resolves.)
          summaryWarmed.add(id);
        });
    },
    [ds, queryClient, summaryWarmed],
  );

  // Populate an item's reader queries (idempotent). No-op when offline or
  // already warmed. An id is only marked warmed once it's FULLY cached — detail
  // present, and for a truncated feed a *terminal* full-text result (ok/empty/
  // auth). A detail miss or a transient `unreachable` full-text leaves it
  // unwarmed so a later sync / reconnect retries it.
  const warm = useCallback(
    (id: string, fullTextAttempt = 0) => {
      if (restoringRef.current || !onlineRef.current) return;
      // AI summary warm — independent of the full-text `warmed` gate below (an
      // item whose full text has settled might still be missing its summary).
      warmSummary(id);
      if (warmed.has(id)) return;
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

          const pinned = ds.stateStore.get(id).pinned;
          if (!pinned && !looksTruncated(fi.item)) {
            warmed.add(id); // nothing more to fetch for favorite-only complete feeds
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
          // Pinned articles always prefetch the extracted reading body so an
          // allowlisted saved-for-later open has the full article immediately;
          // favorite-only articles do so only when the feed body looks truncated.
          // Only mark
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
          if (ft && isFullTextSettled(ft)) {
            warmed.add(id);
            cancelFullTextRetry(id);
          } else if (pinned) {
            scheduleFullTextRetry(id, fullTextAttempt);
          }
        });
    },
    [
      ds,
      queryClient,
      warmed,
      gateSkipped,
      warmSummary,
      cancelFullTextRetry,
      scheduleFullTextRetry,
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
          // Retain the AI summary too, so a pinned article's gist survives
          // offline like its body, since the feed-list cache it came from isn't
          // GC-locked — without this an offline open past the GC window would keep
          // the body and lose the summary. This observer only RETAINS (never
          // fetches — disabled); population comes from `warmSummary` above (for a
          // pinned item), the ride-along seed / reader `useSummary`, and
          // `useSummaryPrewarm` — whichever fills the shared key first. A favorite
          // that's never been opened online has nothing to retain here yet (the
          // summary warm is pinned-only); its gist lands on first open.
          new QueryObserver(queryClient, {
            queryKey: summaryQueryKey(id),
            queryFn: () => ds.getSummary(id),
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
      summaryWarmed.delete(id);
      gateSkipped.delete(id);
      cancelFullTextRetry(id);
      queryClient.removeQueries({ queryKey: summaryQueryKey(id), exact: true });
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
      for (const timer of fullTextRetryTimers.values()) clearTimeout(timer);
      fullTextRetryTimers.clear();
      locks.clear();
      warmed.clear();
      summaryWarmed.clear();
      gateSkipped.clear();
    };
  }, [
    ds,
    queryClient,
    warm,
    locks,
    warmed,
    summaryWarmed,
    gateSkipped,
    cancelFullTextRetry,
    fullTextRetryTimers,
  ]);

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
