// Client-side helpers for the AI article-summary view. Pure logic so it can be
// unit-tested without React or a data source. Mirrors `fullText.ts` in shape.

/** The outcome of a server summary request. Mirrors the `summary` Edge
 * Function's `{ status, summary, retryable? }` envelope. */
export type SummaryStatus = 'ok' | 'empty' | 'unavailable' | 'unreachable';

export interface SummaryResult {
  status: SummaryStatus;
  /** The one-sentence summary when `status === 'ok'`, otherwise null. */
  summary: string | null;
  /**
   * A normally-terminal outcome that should nonetheless be re-checked later
   * because a server-side condition could flip — the allowlist denial (an
   * `empty` the operator could un-stick by adding the caller) and the
   * not-configured `unavailable` (which clears once GOOGLE_API_KEY is set). Kept
   * as an additive flag rather than a new status so a service-worker-cached older
   * client still treats the result as its plain status (guardrail #11).
   */
  retryable?: boolean;
  /**
   * Provisional `ok` seeded from the list-row ride-along (`useSummary`), NOT a
   * value fetched from the `summary` Edge Function. It's shown immediately and
   * kept alive offline (`useOfflineCacheLock` retains `['summary', id]`), but is
   * deliberately treated as **unsettled/stale** so that once the query actually
   * runs — the feed row that fed it has been GC'd — it revalidates against the
   * server and graduates to a durable fetched summary. Offline it's served as-is
   * (a stale gist beats an empty card). Cleared when a real fetch overwrites it.
   */
  viaRow?: boolean;
}

/** Whether a summary result is terminal — safe to treat as the final answer and
 * stop retrying. A transient `unreachable`/`unavailable`, or any result flagged
 * {@link SummaryResult.retryable} (e.g. an allowlist denial a later change could
 * flip), is NOT settled, so a reconnect / gate-resolve should re-check it. */
export function isSummarySettled(data: SummaryResult): boolean {
  // A row seed is provisional — the real fetch is still wanted (so the prewarm
  // keeps warming it, and `summaryStaleTime` treats it as stale → revalidate).
  if (data.viaRow) return false;
  if (data.status === 'unreachable' || data.status === 'unavailable') return false;
  return !data.retryable;
}

/** staleTime policy for the `['summary', id]` query: terminal outcomes (`ok`,
 * `empty`) are cached forever, but a transient `unreachable`/`unavailable`, a
 * result flagged {@link SummaryResult.retryable} (e.g. an allowlist denial a
 * later change could flip), or a provisional {@link SummaryResult.viaRow} seed —
 * stays stale so the next pin/open revalidates it. */
export function summaryStaleTime(query: {
  state: { data?: SummaryResult };
}): number {
  const data = query.state.data;
  if (!data) return 0;
  return isSummarySettled(data) ? Infinity : 0;
}
