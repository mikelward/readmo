import { useCallback, useEffect, useRef } from 'react';
import { useIsRestoring, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useOnlineStatus } from './useOnlineStatus';
import { useFullTextAllowed } from './useCapabilities';
import { useAutoSummarizePinned } from './useReadingPrefs';
import { summaryQueryKey } from './useSummary';
import { isSummarySettled, summaryStaleTime, type SummaryResult } from '../lib/summary';

/**
 * Pre-warm the AI summary for pinned articles so it's ready before the reader
 * opens them — no spinner on first open. The summary sibling of
 * {@link useOfflineCacheLock}, which already warms each pinned item's `['item']`
 * + `['fulltext']` reader queries the same way; this adds `['summary']`.
 *
 * The summary itself is NOT gated on pinned — `useSummary` shows it for any
 * article an allowlisted user opens. Pinning is just a **prefetch signal**: a
 * pinned item is likely to be read, so we warm it ahead of time. Warms every
 * pinned item, whichever way it became pinned: a pin made on this device, a pin
 * **synced from another device** (hydration), or a pin already present on boot.
 * Both this and the reader's on-open `useSummary` share the `['summary', id]`
 * key and the result caches on `items.ai_summary`, so whichever fires first
 * generates and the rest are plain cache hits — never a second Gemini call.
 *
 * Cross-device warming is cheap precisely because the summary is cached
 * server-side: a warm of an already-generated summary is a **server cache hit**
 * (no Jina, no Gemini — see `summary` Edge Function's `item.ai_summary` short
 * circuit), and a never-summarized pin generates exactly **once**, shared across
 * every device and user.
 *
 * Gated **online + allowlisted + opted-in** (the family-only "Auto generate
 * summaries for pinned articles" setting, on by default — see
 * useAutoSummarizePinned), so an off-list user fires no Edge call and a family
 * user who turned it off warms nothing (the server re-checks regardless). An
 * item is
 * marked warmed only on a **settled** outcome, so a transient `unreachable`/
 * `unavailable` stays unwarmed and retries on reconnect / once the allowlist gate
 * resolves. The store subscriber warms only **newly-pinned** ids (so an
 * unrelated state emit during an outage doesn't re-fetch every unsettled pinned
 * summary); whole-set retries are left to the restore/reconnect/gate effect.
 * Warming is held off until the persisted React Query cache has **restored**
 * (like `useOfflineCacheLock`): prefetching against the not-yet-hydrated cache
 * would re-fetch every already-cached pinned summary on each boot. Mount once
 * near the app root, next to `useOfflineCacheLock`.
 */
export function useSummaryPrewarm(): void {
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const allowed = useFullTextAllowed();
  // The family-only opt-in (on by default). When off, warm nothing — the reader
  // still generates on-open for whoever opens an article; this only skips the
  // ahead-of-time prefetch.
  const { autoSummarizePinned } = useAutoSummarizePinned();
  // True while PersistQueryClientProvider is rehydrating the cache. Warming must
  // wait: running before hydration completes would see an empty cache and
  // re-fetch every persisted pinned summary on boot (defeating the cache).
  const isRestoring = useIsRestoring();

  // Connectivity / gate / restore read at warm time without re-running the
  // subscribe effect (which would re-attach the store listener) on every change.
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const allowedRef = useRef(allowed);
  allowedRef.current = allowed;
  const autoSummarizeRef = useRef(autoSummarizePinned);
  autoSummarizeRef.current = autoSummarizePinned;
  const restoringRef = useRef(isRestoring);
  restoringRef.current = isRestoring;
  const warmed = useRef(new Set<string>()).current;
  // Previous pinned id set, so the store subscriber can warm only NEWLY-pinned
  // ids. `null` until the first sync — the initial pinned set is warmed by the
  // restore/online/allowed effect below, not the subscriber, so boot/hydration
  // emits don't churn the whole set through `warm`.
  const prevPinned = useRef<Set<string> | null>(null);

  // Prefetch one item's summary (idempotent). No-op while restoring, offline,
  // gated off, or already warmed. Marks warmed only once the result is SETTLED,
  // so a transient failure is left for the reconnect / gate-resolve effect.
  const warm = useCallback(
    (id: string) => {
      if (
        restoringRef.current ||
        warmed.has(id) ||
        !onlineRef.current ||
        !allowedRef.current ||
        !autoSummarizeRef.current
      )
        return;
      void queryClient
        .prefetchQuery({
          queryKey: summaryQueryKey(id),
          queryFn: () => ds.getSummary(id),
          staleTime: summaryStaleTime,
        })
        .then(() => {
          const data = queryClient.getQueryData<SummaryResult>(summaryQueryKey(id));
          if (data && isSummarySettled(data)) warmed.add(id);
        });
    },
    [ds, queryClient, warmed],
  );

  // Warm items as they're NEWLY pinned — a pin made here, or a pin synced from
  // another device (hydrate → emit) after the baseline. Only the delta is warmed
  // (not the whole pinned set on every emit), so an unrelated favorite/done/open/
  // sync emit never re-fetches an unsettled pinned summary. The first sync seeds
  // the baseline without warming; forget unpinned ids so a later re-pin
  // re-checks.
  useEffect(() => {
    const store = ds.stateStore;
    const sync = () => {
      const pinned = new Set(
        store
          .entries()
          .filter(([, s]) => s.pinned)
          .map(([id]) => id),
      );
      const prev = prevPinned.current;
      if (prev) for (const id of pinned) if (!prev.has(id)) warm(id);
      for (const id of [...warmed]) if (!pinned.has(id)) warmed.delete(id);
      prevPinned.current = pinned;
    };
    sync();
    return store.subscribe(sync);
  }, [ds, warm, warmed]);

  // Warm the pinned set once it's both safe and useful — after the persisted
  // cache restored (so already-cached summaries are seen, not re-fetched) and
  // while online + allowed + opted-in. Also covers reconnect, the allowlist gate
  // resolving, and the setting being switched on: pins held off in those states
  // fill in here.
  useEffect(() => {
    if (isRestoring || !online || !allowed || !autoSummarizePinned) return;
    for (const [id, s] of ds.stateStore.entries()) if (s.pinned) warm(id);
  }, [isRestoring, online, allowed, autoSummarizePinned, ds, warm]);
}
