import type { Item } from './types';

// Client-side helpers for the full-text (reading-mode) view. Pure logic so it
// can be unit-tested without React or a data source.

/** The outcome of a server full-text extraction. Mirrors the `fulltext` Edge
 * Function's `{ status, contentHtml }` envelope. */
export type FullTextStatus = 'ok' | 'empty' | 'auth' | 'unreachable';

export interface FullTextResult {
  status: FullTextStatus;
  /** Sanitized article HTML when `status === 'ok'`, otherwise null. */
  contentHtml: string | null;
}

/** staleTime policy for the `['fulltext', id]` query, shared by the reader's
 * live query and the pin-time prefetch so both behave identically: terminal
 * outcomes (ok/empty/auth) are cached forever (re-fetching can't change them),
 * but a transient `unreachable` stays stale so the next open/pin retries it. */
export function fullTextStaleTime(query: {
  state: { data?: FullTextResult };
}): number {
  const data = query.state.data;
  return data && data.status !== 'unreachable' ? Infinity : 0;
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
