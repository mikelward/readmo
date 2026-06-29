import { useCallback, useEffect, useRef } from 'react';
import { useIsRestoring, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useOnlineStatus } from './useOnlineStatus';
import { useFullTextAllowed } from './useCapabilities';
import { summaryQueryKey } from './useSummary';
import { isSummarySettled, summaryStaleTime, type SummaryResult } from '../lib/summary';

/**
 * Pre-warm the AI summary for pinned articles so it's ready before the reader
 * opens them — no spinner on first open. The summary sibling of
 * {@link useOfflineCacheLock}, which already warms each pinned item's `['item']`
 * + `['fulltext']` reader queries the same way; this adds `['summary']`.
 *
 * Warms every **pinned** item, whichever way it became pinned: a pin made on
 * this device, a pin **synced from another device** (hydration), or a pin
 * already present on boot. The reader's `useSummary` still generates on open;
 * both share the `['summary', id]` key and the result caches on
 * `items.ai_summary`, so whichever fires first generates and the rest are plain
 * cache hits — never a second Gemini call.
 *
 * Cross-device warming is cheap precisely because the summary is cached
 * server-side: a warm of an already-generated summary is a **server cache hit**
 * (no Jina, no Gemini — see `summary` Edge Function's `item.ai_summary` short
 * circuit), and a never-summarized pin generates exactly **once**, shared across
 * every device and user.
 *
 * Gated like `useSummary` — pinned **+ online + allowlisted** — so an off-list
 * user fires no Edge call (the server re-checks regardless). An item is marked
 * warmed only on a **settled** outcome, so a transient `unreachable`/
 * `unavailable` stays unwarmed and retries on reconnect / once the allowlist
 * gate resolves. Warming is also held off until the persisted React Query cache
 * has **restored** (like `useOfflineCacheLock`): prefetching against the not-yet-
 * hydrated cache would re-fetch every already-cached pinned summary on each boot.
 * Mount once near the app root, next to `useOfflineCacheLock`.
 */
export function useSummaryPrewarm(): void {
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const allowed = useFullTextAllowed();
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
  const restoringRef = useRef(isRestoring);
  restoringRef.current = isRestoring;
  const warmed = useRef(new Set<string>()).current;

  // Prefetch one item's summary (idempotent). No-op while restoring, offline,
  // gated off, or already warmed. Marks warmed only once the result is SETTLED,
  // so a transient failure is left for the reconnect / gate-resolve effect.
  const warm = useCallback(
    (id: string) => {
      if (
        restoringRef.current ||
        warmed.has(id) ||
        !onlineRef.current ||
        !allowedRef.current
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

  // Warm pinned items as they enter the bucket — a pin made here, a pin synced
  // from another device (hydrate → emit), or the pinned set restored on boot —
  // and forget unpinned ones so a later re-pin re-checks.
  useEffect(() => {
    const store = ds.stateStore;
    const sync = () => {
      const pinned = new Set(
        store
          .entries()
          .filter(([, s]) => s.pinned)
          .map(([id]) => id),
      );
      for (const id of pinned) warm(id);
      for (const id of [...warmed]) if (!pinned.has(id)) warmed.delete(id);
    };
    sync();
    return store.subscribe(sync);
  }, [ds, warm, warmed]);

  // Warm the pinned set once it's both safe and useful — after the persisted
  // cache restored (so already-cached summaries are seen, not re-fetched) and
  // while online + allowed. Also covers reconnect and the allowlist gate
  // resolving: pins held off in those states fill in here.
  useEffect(() => {
    if (isRestoring || !online || !allowed) return;
    for (const [id, s] of ds.stateStore.entries()) if (s.pinned) warm(id);
  }, [isRestoring, online, allowed, ds, warm]);
}
