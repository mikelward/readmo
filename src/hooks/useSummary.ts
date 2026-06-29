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
 * Fetch (and cache) the AI summary for a pinned article.
 *
 * Gated to match the server: it only issues the call when the item is **pinned**
 * (pinned is the gate — SPEC "AI article summaries"; opening the reader is one
 * trigger, the other being `useSummaryPrewarm`, which warms the summary for any
 * pinned item — pinned here or synced from another device — both sharing this
 * query key so the first to run generates and the rest hit cache)
 * AND the caller is
 * **allowed** by the shared trusted-user allowlist (the same gate as reading
 * mode; `useFullTextAllowed` holds off while a signed-in user's capabilities are
 * still loading, so an off-list user fires no Edge call). When `online` is false
 * we don't call either — there's no offline summary to serve. The server
 * enforces the allowlist regardless; the client gate just avoids a pointless
 * request.
 *
 * The summary function fetches the article text itself (via Jina), so — unlike
 * an earlier design — the reader does NOT have to wait for reading-mode
 * extraction to populate `full_content_html` first; there's no stored-content
 * sequencing to race.
 */
export function useSummary(
  id: ItemId,
  opts: { pinned: boolean; online: boolean },
): UseSummary {
  const ds = useDataSource();
  const allowed = useFullTextAllowed();
  const enabled = opts.pinned && opts.online && allowed;

  const query = useQuery({
    queryKey: summaryQueryKey(id),
    queryFn: () => ds.getSummary(id),
    enabled,
    // Terminal outcomes (ok/empty) are cached forever; a transient
    // unreachable/unavailable — or a retryable allowlist denial — stays stale so
    // the next pin/open retries it.
    staleTime: summaryStaleTime,
  });

  // Display gate (separate from the query `enabled`): a summary already cached in
  // React Query must STOP being shown the moment the caller loses access — when
  // the operator removes a now-armed allowlist member, `enabled` halts new calls
  // but the persisted `ok` data would otherwise keep rendering the gated card.
  // So drop cached data unless the caller is currently allowed + still pinned,
  // mirroring how ItemPage ignores cached full-text when `allowFull` is false.
  // Gated on `allowed`/`pinned` only (NOT `online`/`contentReady`), so a summary
  // already on screen survives going offline — there's just nothing new to fetch.
  const displayAllowed = allowed && opts.pinned;
  const data: SummaryResult | undefined = query.data;
  return {
    summary: displayAllowed && data?.status === 'ok' ? data.summary : null,
    loading: enabled && !data && (query.isLoading || query.isFetching),
    unavailable: displayAllowed && !!data && data.status !== 'ok',
  };
}
