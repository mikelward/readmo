import { useCallback, useEffect, useRef } from 'react';
import { useIsRestoring, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useFullTextAllowed } from './useCapabilities';
import { summaryQueryKey } from './useSummary';
import { findCachedFeedItem } from '../lib/offlineItem';
import type { SummaryResult } from '../lib/summary';
import type { FeedItem } from '../lib/types';

/**
 * Eagerly retain **saved** items' AI summaries offline by seeding `['summary',
 * id]` from the cached feed row (the 0058 ride-along) for every pinned/favorited
 * item — the favorite-shaped sibling of {@link useSummaryPrewarm}.
 *
 * A saved item is in the offline bucket, so `useOfflineCacheLock` keeps its body,
 * full text, AND `['summary', id]` alive against GC. But nothing POPULATES a
 * favorite's summary: `useSummaryPrewarm` warms only PINNED items (via a real
 * `getSummary` fetch — a pin is the generation trigger), and the reader seeds
 * only on open. So a favorite never opened online would have its body retained
 * but its gist lost once the (GC-able) feed cache expires. This copies the gist
 * off that row while it's still cached, so the offline open shows it.
 *
 * Deliberately **cache-only — never an Edge call, never a generation**: the row
 * carries a gist only for an allowlisted caller (server-gated, 0058), so this is
 * implicitly gated, and favoriting must not spend a Gemini call (only pinning
 * triggers generation). The seed is provisional (`viaRow`): the reader
 * revalidates it against the server on the next online open (self-heals after a
 * publisher edit) and serves it as-is offline (a stale gist beats an empty card).
 * It never overwrites a real fetched summary, and seeds only once the retained
 * item detail (`['item', id]`, the body the reader shows offline) is present AND
 * the row still describes it (content-match, mirroring ItemPage) — so it can't
 * put a gist over a fresher body. Freshness beyond that is the reader's open-time
 * job (revalidation).
 *
 * Runs after the persisted cache restores, on every item-state emit (a new
 * favorite / a cross-device sync), and on feed/library/item cache updates (a
 * saved item's row GAINING a gist on a later refresh, or its detail warming after
 * it's saved — both change whether the content-match passes). Not gated on
 * connectivity (a cache read) or the
 * auto-summarize setting (that governs GENERATION for pins, not retention of an
 * already-generated gist). Mount once near the app root, next to
 * `useSummaryPrewarm`.
 */
export function useSavedSummarySeed(): void {
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const allowed = useFullTextAllowed();
  // Wait for the persisted cache to rehydrate — seeding against an empty cache
  // would find no rows and do nothing (and re-running on restore covers it).
  const isRestoring = useIsRestoring();

  const allowedRef = useRef(allowed);
  allowedRef.current = allowed;
  const restoringRef = useRef(isRestoring);
  restoringRef.current = isRestoring;

  // Seed one saved item's summary from its cached feed row. No-op while
  // restoring or gated off, when a REAL fetched summary is already cached
  // (protected), when the row carries no gist (allowlist NULL / not generated
  // yet — keep any stale seed; stale beats empty), or when it's already the
  // cached value (avoid redundant cache churn).
  const seed = useCallback(
    (id: string) => {
      if (restoringRef.current || !allowedRef.current) return;
      const cur = queryClient.getQueryData<SummaryResult>(summaryQueryKey(id));
      if (cur?.status === 'ok' && !cur.viaRow) return;
      const row = findCachedFeedItem(queryClient, id)?.item;
      if (!row?.aiSummary) return;
      // Content-match, mirroring ItemPage: seed only once the RETAINED item detail
      // (`['item', id]`, warmed by the offline lock) is present AND the row still
      // describes it — the detail is the body the reader shows offline, so a row
      // that doesn't match it would put a gist over a different body. REQUIRING
      // the detail (not just checking it when present) is what covers the case
      // where an item is saved against a stale feed page: at that instant the lock
      // hasn't warmed `['item', id]` yet, so we wait rather than seed the stale
      // gist; the `['item']` update below re-runs us once the fresh detail lands,
      // and it either matches (seed) or doesn't (skip) — so a stale row is never
      // seeded and there's no stale viaRow to drop later. Beyond that, freshness
      // is the reader's open-time job (revalidation).
      const detail = queryClient.getQueryData<FeedItem | null>(['item', id])?.item;
      if (!detail || detail.contentHtml !== row.contentHtml || detail.title !== row.title) {
        // A PRESENT detail that no longer matches the row means the row is stale
        // relative to the body the reader shows. Drop a prior viaRow seed built
        // when they DID match (e.g. the detail was later refreshed by an online
        // open whose summary revalidation failed transiently, leaving the old
        // seed) — offline `useSummary` would otherwise render that gist over the
        // fresh body. Only ever a viaRow (a real fetched summary is guarded
        // above); stale-beats-empty doesn't apply to a gist we KNOW describes a
        // different body. When the detail is merely absent (not yet warmed), keep
        // any existing seed and wait.
        if (detail && cur?.viaRow) {
          queryClient.removeQueries({ queryKey: summaryQueryKey(id), exact: true });
        }
        return;
      }
      if (row.aiSummary === cur?.summary) return;
      queryClient.setQueryData<SummaryResult>(summaryQueryKey(id), {
        status: 'ok',
        summary: row.aiSummary,
        viaRow: true,
      });
    },
    [queryClient],
  );

  const seedAll = useCallback(() => {
    for (const [id, s] of ds.stateStore.entries()) {
      if (s.pinned || s.favorite) seed(id);
    }
  }, [ds, seed]);

  useEffect(() => {
    if (isRestoring || !allowed) return;
    seedAll(); // initial pass over the restored cache
    const unsubStore = ds.stateStore.subscribe(seedAll);
    // Re-seed when the inputs change: a saved item's row can gain a gist on a
    // later feed refresh (`feed`/`library`/`offline`), and its retained detail
    // (`item`) can warm/refresh after the item is saved — both change whether the
    // content-match passes. Coalesced to one microtask so a burst of updates
    // triggers a single pass. Writing `['summary', id]` fires a 'summary' event,
    // which is filtered out — no loop.
    let queued = false;
    const unsubCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return;
      const key = event.query.queryKey[0];
      if (key !== 'feed' && key !== 'library' && key !== 'offline' && key !== 'item') return;
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        seedAll();
      });
    });
    return () => {
      unsubStore();
      unsubCache();
    };
  }, [isRestoring, allowed, ds, seedAll, queryClient]);
}
