import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useFullTextAllowed } from './useCapabilities';
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
  opts: { online: boolean; autoGenerate: boolean },
): UseSummary {
  const ds = useDataSource();
  const allowed = useFullTextAllowed();
  // The item the user explicitly asked to summarize via the button. Stored as an
  // id (not a boolean + reset effect) so the trigger is keyed to *this* article:
  // `triggered` is derived and becomes false the instant `id` changes, in the
  // same render. A boolean would linger true for the first render after SPA
  // navigation reuses this component for a new item — long enough for `useQuery`
  // to fire `getSummary` for the next (unpinned) article before any reset effect
  // ran, leaking a fetch past the gate.
  const [triggeredId, setTriggeredId] = useState<ItemId | null>(null);
  const triggered = triggeredId === id;

  const enabled = opts.online && allowed && (opts.autoGenerate || triggered);

  const query = useQuery({
    queryKey: summaryQueryKey(id),
    queryFn: () => ds.getSummary(id),
    enabled,
    // Terminal outcomes (ok/empty) are cached forever; a transient
    // unreachable/unavailable — or a retryable allowlist denial — stays stale so
    // the next open retries it.
    staleTime: summaryStaleTime,
  });

  // Display gate (separate from the query `enabled`): a summary already cached in
  // React Query must STOP being shown the moment the caller loses access — when
  // the operator removes a now-armed allowlist member, `enabled` halts new calls
  // but the persisted `ok` data would otherwise keep rendering the gated card.
  // So drop cached data unless the caller is currently allowed, mirroring how
  // ItemPage ignores cached full-text when `allowFull` is false. Gated on
  // `allowed` only (NOT `online`), so a summary already on screen survives going
  // offline — there's just nothing new to fetch.
  const data: SummaryResult | undefined = allowed ? query.data : undefined;
  const loading = enabled && !data && (query.isLoading || query.isFetching);
  return {
    summary: data?.status === 'ok' ? data.summary : null,
    loading,
    unavailable: !!data && data.status !== 'ok',
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
