import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useFullTextAllowed, useCapabilities, canUseFullText } from './useCapabilities';
import { summaryStaleTime, type SummaryResult } from '../lib/summary';
import type { ItemId } from '../lib/types';

/** React Query key for an item's AI summary. */
export function summaryQueryKey(id: ItemId): readonly [string, ItemId] {
  return ['summary', id];
}

export interface UseSummary {
  /** The summary markdown text, or null until it resolves to `ok`. */
  summary: string | null;
  /** True while the first generation is in flight (the card shows a spinner). */
  loading: boolean;
  /** True once the query settled on a non-`ok` outcome (so the card hides). The
   * reader stays silent on any soft failure — allowlist denial, nothing to
   * summarize, Gemini unconfigured/unreachable — exactly like reading mode. */
  unavailable: boolean;
  /** True when the reader should offer a "Generate summary" button instead of
   * generating automatically — an allowlisted, online reader of an article that
   * wasn't pinned before opening, with nothing cached to show yet. */
  canGenerate: boolean;
  /** Kick off generation on demand (the button's onClick). No-op unless online
   * + allowed; enables the query and flips the card into its loading state. */
  generate: () => void;
  /** True when a requested generation (pinned auto-run or the button) settled
   * on a transient `unreachable` — the summary service couldn't be reached.
   * Unlike the other soft failures this one was explicitly asked for, so the
   * card shows "could not summarize" + Retry instead of vanishing. */
  failed: boolean;
  /** Re-run a failed generation (the Retry button's onClick). */
  retry: () => void;
  /** True when the reader is offline with no `ok` summary cached for an
   * article that would auto-generate (pinned before opening — the case where
   * the prewarm promised a summary). The card explains instead of silently
   * missing. */
  offlineWithoutCache: boolean;
}

/**
 * Fetch (and cache) the AI summary for the article being read.
 *
 * Gated to match the server: it issues the call for an **allowed** caller — the
 * shared trusted-user allowlist is the only access gate (the same one as reading
 * mode; `useFullTextAllowed` holds off while a signed-in user's capabilities are
 * still loading, so an off-list user fires no Edge call). The server enforces the
 * allowlist regardless; the client gate just avoids a pointless request.
 *
 * Generation is NOT automatic for every open. It fires on its own only when the
 * article was **pinned before opening** (`autoGenerate`) — the "I'll read this"
 * signal `useSummaryPrewarm` already warms on. For an unpinned article the reader
 * offers a **"Generate summary"** button instead (`canGenerate` / `generate`), so
 * a casual glance doesn't spend a Gemini/Jina call. A summary already cached
 * (warmed from a pin, or generated on an earlier open) still shows immediately
 * either way — the gate is on *fetching*, not on *displaying*. When `online` is
 * false we don't call and offer no button — there's no offline summary to serve.
 *
 * The summary function fetches the article text itself (via Jina), so — unlike
 * an earlier design — the reader does NOT have to wait for reading-mode
 * extraction to populate `full_content_html` first; there's no stored-content
 * sequencing to race.
 */
export function useSummary(
  id: ItemId,
  opts: { online: boolean; autoGenerate: boolean; initialSummary?: string | null },
): UseSummary {
  const ds = useDataSource();
  const queryClient = useQueryClient();
  // TWO gates, deliberately different (mirrors the spoiler-headline split in
  // ItemPage): the FETCH gate is conservative and the DISPLAY gate is optimistic.
  //  - `allowed` (conservative — `useFullTextAllowed`): closed until we KNOW the
  //    caller is allowlisted. Gates whether we issue an Edge `getSummary` call, so
  //    a not-yet-known / off-list user fires nothing (the "zero Edge calls"
  //    promise). Also gates the generate button.
  //  - `allowedDisplay` (optimistic — `canUseFullText(useCapabilities())`): open
  //    while capabilities are still loading, closed only once we KNOW the caller is
  //    denied. Gates whether an ALREADY-cached/seeded summary is shown. Using the
  //    conservative gate here would blank a cached summary until caps resolve on a
  //    cold boot — the 500 ms–1 s "Summarizing…" flash over a summary that's
  //    actually already in hand. The summary is derived from an article the caller
  //    can already read, so showing a cached one during the brief caps-load window
  //    is safe; a resolved denial still drops it.
  const allowed = useFullTextAllowed();
  const allowedDisplay = canUseFullText(useCapabilities());
  // A summary already delivered ON the item row (the allowlisted ride-along from
  // `feed_items`, 0058) — show it immediately with no Edge round-trip and no
  // spinner, and don't fire the query at all. Gated on the OPTIMISTIC display gate
  // so it paints instantly on a cold boot too (a resolved de-list still drops it).
  // Null → fall through to the normal on-demand `getSummary` flow below
  // (just-pinned / old backend / non-cacheable), so this is a fast path, never the
  // only one.
  const rowSummary = allowedDisplay ? (opts.initialSummary ?? null) : null;
  // The item the user explicitly asked to summarize via the button. Stored as an
  // id (not a boolean + reset effect) so the trigger is keyed to *this* article:
  // `triggered` is derived and becomes false the instant `id` changes, in the
  // same render. A boolean would linger true for the first render after SPA
  // navigation reuses this component for a new item — long enough for `useQuery`
  // to fire `getSummary` for the next (unpinned) article before any reset effect
  // ran, leaking a fetch past the gate.
  const [triggeredId, setTriggeredId] = useState<ItemId | null>(null);
  const triggered = triggeredId === id;

  // A retained viaRow seed (from the reader or the offline lock) is provisional —
  // enable the query so it REVALIDATES and graduates to a durable fetched summary
  // even on a saved-but-unpinned open (`autoGenerate` false). Without this a
  // favorite would show the seed forever without re-checking the server, so a
  // publisher edit would never self-heal. (Offline the query is still disabled
  // via `opts.online`, so the seed is served as-is.)
  const seededViaRow =
    queryClient.getQueryData<SummaryResult>(summaryQueryKey(id))?.viaRow === true;
  // Never fetch when the row already carries the summary — the query hook still
  // mounts below (stable hook order), it just stays disabled.
  const enabled =
    !rowSummary &&
    opts.online &&
    allowed &&
    (opts.autoGenerate || triggered || seededViaRow);

  const query = useQuery({
    queryKey: summaryQueryKey(id),
    // React Query's per-fetch signal is threaded into the invoke, so cancelling
    // this query (superseded navigation, the prewarm's foreground-resume cancel)
    // aborts the actual request instead of leaving an orphaned transport.
    queryFn: async ({ signal }) => {
      const result = await ds.getSummary(id, { signal });
      // Don't let a TRANSIENT failure replace a gist we're already showing (a
      // viaRow seed, or an earlier ok being revalidated) with a "Could not
      // summarize" card — stale beats empty. A real `ok` graduates the seed; a
      // terminal `empty`/`unavailable` still passes through (the server
      // genuinely has nothing, or isn't configured).
      if (result.status === 'unreachable') {
        const cur = queryClient.getQueryData<SummaryResult>(summaryQueryKey(id));
        if (cur?.status === 'ok') return cur;
      }
      return result;
    },
    enabled,
    // Terminal outcomes (ok/empty) are cached forever; a transient
    // unreachable/unavailable, a retryable allowlist denial, or a provisional
    // viaRow seed — stays stale so the next open revalidates it.
    staleTime: summaryStaleTime,
  });

  // Durably seed the row summary into `['summary', id]`, the key
  // `useOfflineCacheLock` retains for pinned/favorited items. The reader displays
  // the row summary directly (below), but the feed-list cache it comes from isn't
  // GC-locked — so without this, an offline open after that cache is evicted would
  // find the body retained but the summary gone. The seed is flagged `viaRow`
  // (provisional): once the query actually runs — the row is gone, so `rowSummary`
  // is null and `enabled` can be true — it revalidates and graduates to a durable
  // fetched summary; offline it's served as the stale-but-present gist. Never
  // overwrites a real fetched summary (only an absent or prior `viaRow` entry).
  useEffect(() => {
    if (!rowSummary) return;
    const cur = queryClient.getQueryData<SummaryResult>(summaryQueryKey(id));
    // Protect only a real, SETTLED fetched summary. An absent entry, a prior
    // viaRow seed, OR a non-ok result (a transient unreachable/unavailable, or a
    // retryable/terminal empty from an earlier attempt) all get replaced by the
    // gist we're currently showing — otherwise a later offline open would serve
    // that stale failure instead of the summary the reader already delivered.
    const hasRealSummary = cur?.status === 'ok' && !cur.viaRow;
    if (!hasRealSummary) {
      queryClient.setQueryData<SummaryResult>(summaryQueryKey(id), {
        status: 'ok',
        summary: rowSummary,
        viaRow: true,
      });
    }
  }, [rowSummary, id, queryClient]);

  // Row fast path: the item carries the summary, so show it now — no spinner, no
  // failure/offline states (there was no fetch to fail), no generate button.
  if (rowSummary) {
    return {
      summary: rowSummary,
      loading: false,
      unavailable: false,
      canGenerate: false,
      generate: () => setTriggeredId(id),
      failed: false,
      retry: () => {
        void query.refetch();
      },
      offlineWithoutCache: false,
    };
  }

  // Display gate (separate from the query `enabled`): a summary already cached in
  // React Query must STOP being shown the moment the caller is KNOWN to have lost
  // access — when the operator removes a now-armed allowlist member, `enabled`
  // halts new calls but the persisted `ok` data would otherwise keep rendering the
  // gated card. Uses the OPTIMISTIC gate (open while caps load, closed only on a
  // resolved denial): a cached summary paints instantly on a cold boot instead of
  // flashing "Summarizing…" until caps resolve, while a confirmed de-list still
  // drops it — mirroring the spoiler headline. Gated on `allowedDisplay` only (NOT
  // `online`), so a summary already on screen survives going offline.
  const data: SummaryResult | undefined = allowedDisplay ? query.data : undefined;
  const fetching = query.isLoading || query.isFetching;
  // Loading covers the first generation AND a Retry after a transient failure
  // (the stale `unreachable` result is still cached while the refetch is in
  // flight). A background refetch of an `ok` summary must not flip the card
  // back to its spinner.
  const loading =
    enabled && fetching && (!data || data.status === 'unreachable');
  return {
    summary: data?.status === 'ok' ? data.summary : null,
    loading,
    unavailable: !!data && data.status !== 'ok',
    // Only `unreachable` earns the error card: it's transient (the service or
    // network hiccuped on a generation the user asked for). The other soft
    // failures (`empty`, `unavailable`) stay silent by design — same
    // philosophy as reading mode.
    failed: opts.online && !loading && data?.status === 'unreachable',
    retry: () => {
      void query.refetch();
    },
    // Pinned articles promise a prewarmed summary; when the device is offline
    // with no `ok` summary cached, say so instead of silently showing nothing.
    // Unpinned opens never promised one, so they stay silent offline.
    offlineWithoutCache:
      allowed && !opts.online && opts.autoGenerate && data?.status !== 'ok',
    // Offer the button when we're allowed + online, weren't asked to
    // auto-generate (not pinned before opening), the user hasn't asked yet, and
    // there's nothing cached or in flight to show. The moment anything caches —
    // an `ok` summary warmed by a later pin, or a soft-failure result — or a
    // generation starts, the button drops.
    canGenerate:
      allowed &&
      opts.online &&
      !opts.autoGenerate &&
      !triggered &&
      query.data === undefined &&
      !loading,
    generate: () => setTriggeredId(id),
  };
}
