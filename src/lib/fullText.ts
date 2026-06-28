import type { Item } from './types';

// Client-side helpers for the full-text (reading-mode) view. Pure logic so it
// can be unit-tested without React or a data source.

/** The outcome of a server full-text extraction. Mirrors the `fulltext` Edge
 * Function's `{ status, contentHtml, retryable?, viaFallback? }` envelope. */
export type FullTextStatus = 'ok' | 'empty' | 'auth' | 'unreachable';

export interface FullTextResult {
  status: FullTextStatus;
  /** Sanitized article HTML when `status === 'ok'`, otherwise null. */
  contentHtml: string | null;
  /**
   * True when the `ok` body came from the bot-block fallback fetch (r.jina.ai)
   * rather than a direct fetch — surfaced as a muted "via fallback" provenance
   * label in the reader. Additive flag, present only when true (a missing/older
   * backend simply omits it, reading as a direct fetch). Only ever true for
   * allowlisted callers, since the `fulltext` Edge Function is allowlist-gated;
   * a non-listed caller never receives any full body, fallback or not.
   */
  viaFallback?: boolean;
  /**
   * A normally-terminal outcome that should nonetheless be re-checked later
   * because a server-side condition could flip. The reading-mode allowlist
   * denial sets this on an otherwise-silent `empty` (rendered as the feed body,
   * exactly like a genuine empty), so that if the operator later adds the caller
   * to `READMO_ALLOWLIST` the next open re-checks the gate instead of staying
   * stuck on a forever-cached denial. Kept as an additive flag rather than a new
   * `status` value so a service-worker-cached older client — which only knows
   * `ok`/`empty`/`auth`/`unreachable` — still renders it silently as `empty`
   * (guardrail #11) instead of coercing an unknown status to an error.
   */
  retryable?: boolean;
}

/** staleTime policy for the `['fulltext', id]` query, shared by the reader's
 * live query and the pin-time prefetch so both behave identically: terminal
 * outcomes (ok/empty/auth) are cached forever (re-fetching can't change them),
 * but a transient `unreachable` — or any result flagged {@link
 * FullTextResult.retryable} (e.g. an allowlist denial a later change could flip)
 * — stays stale so the next open/pin retries it. */
export function fullTextStaleTime(query: {
  state: { data?: FullTextResult };
}): number {
  const data = query.state.data;
  if (!data) return 0;
  return data.status === 'unreachable' || data.retryable ? 0 : Infinity;
}

/** Whether a full-text result is settled — terminal AND not flagged retryable —
 * so the offline warmer can mark the item warmed and stop re-fetching it. The
 * inverse (transient `unreachable`, or a retryable allowlist denial) must stay
 * un-warmed so a later reconnect/state-sync re-prefetches it. Mirrors the
 * terminal test in {@link fullTextStaleTime}. */
export function isFullTextSettled(result: FullTextResult): boolean {
  return result.status !== 'unreachable' && !result.retryable;
}

/** Strip HTML tags and collapse whitespace to estimate the visible text length
 * of a feed body. */
export function htmlTextLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

/** Below this many characters of body text we assume the feed gave us a stub
 * (a teaser / "read more" excerpt) rather than the full article, and reading
 * mode is worth fetching automatically. */
export const TRUNCATION_TEXT_THRESHOLD = 600;

/**
 * Whether an item's feed body looks truncated — i.e. the feed published only a
 * short excerpt, so fetching the full article is worthwhile. True when there is
 * no body at all, or the body's visible text is under
 * {@link TRUNCATION_TEXT_THRESHOLD}. Items that already carry a cached full
 * body are never "truncated" (there's nothing left to fetch).
 */
export function looksTruncated(item: Pick<Item, 'contentHtml' | 'fullContentHtml'>): boolean {
  if (item.fullContentHtml) return false;
  return htmlTextLength(item.contentHtml ?? '') < TRUNCATION_TEXT_THRESHOLD;
}
