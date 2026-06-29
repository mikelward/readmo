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
}

/**
 * Fetch (and cache) the AI summary for the article being read.
 *
 * Gated to match the server: it issues the call for **any** article an
 * **allowed** caller opens — the shared trusted-user allowlist is the only gate
 * (the same one as reading mode; `useFullTextAllowed` holds off while a signed-in
 * user's capabilities are still loading, so an off-list user fires no Edge call).
 * Pinning is NOT required: the summary is a feature of every article an
 * allowlisted user reads, and `useSummaryPrewarm` separately warms pinned items
 * early as an optimization (both share this query key, so whichever runs first
 * generates and the rest hit cache). When `online` is false we don't call —
 * there's no offline summary to serve. The server enforces the allowlist
 * regardless; the client gate just avoids a pointless request.
 *
 * The summary function fetches the article text itself (via Jina), so — unlike
 * an earlier design — the reader does NOT have to wait for reading-mode
 * extraction to populate `full_content_html` first; there's no stored-content
 * sequencing to race.
 */
export function useSummary(id: ItemId, opts: { online: boolean }): UseSummary {
  const ds = useDataSource();
  const allowed = useFullTextAllowed();
  const enabled = opts.online && allowed;

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
  const data: SummaryResult | undefined = query.data;
  return {
    summary: allowed && data?.status === 'ok' ? data.summary : null,
    loading: enabled && !data && (query.isLoading || query.isFetching),
    unavailable: allowed && !!data && data.status !== 'ok',
  };
}
