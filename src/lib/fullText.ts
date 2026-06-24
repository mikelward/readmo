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

/** Version of the full-text extraction pipeline the client is built against.
 * MUST stay in sync with `FULLTEXT_VERSION` in
 * supabase/functions/_shared/fulltext.ts (separate runtimes can't share the
 * constant, so keep them in lockstep — cf. `PARKED_ERROR_THRESHOLD`). It gates
 * three client surfaces so a bump invalidates ALL of them at once, matching the
 * server/DB gate:
 *   - `mapItem` only surfaces a cached `full_content_html` stamped with this
 *     version (older/NULL → dropped, reader re-fetches);
 *   - the `['fulltext', id, version]` React Query key (below) — terminal
 *     full-text results are persisted with `staleTime: Infinity`, so without the
 *     version in the key a body extracted by old code would be served from the
 *     persisted cache forever without re-invoking `fetchFullText`.
 * Bump this (and the edge constant) whenever extraction output changes. */
export const FULLTEXT_VERSION = 2;

/** React Query key for an item's full-text body, scoped to the extractor
 * version so a version bump invalidates the persisted cache (a stale terminal
 * result lives under the old key and is never read). The reader and the
 * offline-prefetch lock MUST use this same key, or the warmed/persisted body
 * won't match what the reader reads. */
export function fullTextQueryKey(id: string): readonly [string, string, number] {
  return ['fulltext', id, FULLTEXT_VERSION] as const;
}

/** Version-agnostic PREFIX for an item's full-text queries — matches every
 * `['fulltext', id, *]` entry (current and any legacy/older-version key) under
 * React Query's partial key matching. Used to evict on unlock: the persisted
 * cache has `maxAge: Infinity`, so a body warmed under a prior version's key
 * would otherwise linger forever after the item leaves the offline bucket. */
export function fullTextQueryKeyPrefix(id: string): readonly [string, string] {
  return ['fulltext', id] as const;
}

/** staleTime policy for the `['fulltext', id, version]` query, shared by the
 * reader's live query and the pin-time prefetch so both behave identically:
 * terminal outcomes (ok/empty/auth) are cached forever (re-fetching can't change
 * them), but a transient `unreachable` stays stale so the next open/pin retries
 * it. */
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
