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
   * because a server-side condition could flip — e.g. the allowlist denial (an
   * `empty` the operator could un-stick by adding the caller). The server owns
   * this judgment: an outcome polling can't change — notably the not-configured
   * `unavailable` (GOOGLE_API_KEY unset) — ships WITHOUT the flag and is
   * treated as settled, so the client never polls for an operator action. Kept
   * as an additive flag rather than a new status so a service-worker-cached
   * older client still treats the result as its plain status (guardrail #11).
   * (An older *backend* that still flags `unavailable` retryable keeps its old
   * re-check behavior — additive both ways.)
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
 * stop retrying. A transient `unreachable`, or any result flagged
 * {@link SummaryResult.retryable} (e.g. an allowlist denial a later change could
 * flip, or an `unavailable` from an older backend), is NOT settled, so the
 * prewarm backoff / a reconnect / gate-resolve should re-check it. An UNFLAGGED
 * `unavailable` (the key isn't configured — the server marks it non-retryable
 * because polling can't set an API key) is settled like any terminal `empty`. */
export function isSummarySettled(data: SummaryResult): boolean {
  // A row seed is provisional — the real fetch is still wanted (so the prewarm
  // keeps warming it, and `summaryStaleTime` treats it as stale → revalidate).
  if (data.viaRow) return false;
  if (data.status === 'unreachable') return false;
  return !data.retryable;
}

/** staleTime policy for the `['summary', id]` query: terminal outcomes (`ok`,
 * `empty`) are cached forever, but a transient `unreachable`, a result flagged
 * {@link SummaryResult.retryable} (e.g. an allowlist denial a later change
 * could flip), or a provisional {@link SummaryResult.viaRow} seed — stays stale
 * so the next pin/open revalidates it.
 *
 * `unavailable` (the key isn't configured) splits the two policies: it's
 * SETTLED (isSummarySettled — the self-driving retry loop stops; polling can't
 * set an API key) but STALE here — an Infinity-fresh `unavailable` on a
 * pinned/favorited item would be retained forever by the offline cache lock
 * (gcTime Infinity, so eviction never comes) and freeze the article
 * summaryless even after the operator sets the key. Stale-but-settled means no
 * loop, while each explicit trigger (a boot warm, a pinned open, the Generate
 * button) re-checks once and recovers the moment the key exists. */
export function summaryStaleTime(query: {
  state: { data?: SummaryResult };
}): number {
  const data = query.state.data;
  if (!data) return 0;
  if (data.status === 'unavailable') return 0;
  return isSummarySettled(data) ? Infinity : 0;
}
