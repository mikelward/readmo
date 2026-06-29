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
}

/** staleTime policy for the `['summary', id]` query: terminal outcomes (`ok`,
 * `empty`) are cached forever, but a transient `unreachable`/`unavailable` — or
 * any result flagged {@link SummaryResult.retryable} (e.g. an allowlist denial a
 * later change could flip) — stays stale so the next pin/open retries it. */
export function summaryStaleTime(query: {
  state: { data?: SummaryResult };
}): number {
  const data = query.state.data;
  if (!data) return 0;
  if (data.status === 'unreachable' || data.status === 'unavailable') return 0;
  return data.retryable ? 0 : Infinity;
}
