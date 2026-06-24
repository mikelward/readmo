// Core domain types for Readmo. These mirror the server schema sketch in
// SPEC.md *Data model* but use camelCase client-side. IDs are strings
// (Postgres UUID/bigint serialized) so the client never does ID math.

export type FeedId = string;
export type ItemId = string;

export interface Enclosure {
  url: string;
  type: string | null;
  length: number | null;
}

/** A subscribed source. `url`/`secretUrl` distinction: the fetchable URL may
 * embed an auth token and stays server-only (SPEC.md *RLS*); the client only
 * ever sees display-safe fields. */
export interface Feed {
  id: FeedId;
  /** Display-safe URL only. The SupabaseDataSource MUST source this from the
   * feed's `site_url` (or another display field) — never the server-only
   * fetch/de-dup `url`, which can embed a per-user token (see
   * supabase/migrations 0002_rls: feeds_public omits both fetch URLs). */
  url: string;
  siteUrl: string | null;
  title: string;
  faviconUrl: string | null;
  /** Consecutive poll failures; surfaced as a feed-health badge. */
  errorCount: number;
  lastError: string | null;
  /** Circuit-breaker tripped — the poller has parked this feed. */
  parked: boolean;
}

/** A normalized feed item. `contentHtml` is already sanitized server-side. */
export interface Item {
  id: ItemId;
  feedId: FeedId;
  guid: string;
  url: string;
  title: string;
  author: string | null;
  /** Epoch milliseconds. */
  publishedAt: number;
  contentHtml: string;
  summary: string | null;
  /** Sanitized full-article HTML extracted server-side (reading mode), or null
   * until a successful extraction has been cached. Distinct from `contentHtml`
   * (the feed's own body, which is often a truncated stub). Holds ONLY a body
   * produced by the current extractor version — a stale-version cached body is
   * mapped to null (and flagged via `fullContentStale`) so the reader re-fetches
   * rather than rendering it. See `lib/fullText.ts` and the `fulltext` Edge
   * Function. */
  fullContentHtml: string | null;
  /** True when the item HAD a cached full body that was dropped because it was
   * extracted by an older `FULLTEXT_VERSION`. Lets the reader auto-trigger
   * re-extraction even when the feed body itself doesn't look truncated (e.g. a
   * body cached via a manual "Get full article" on a complete-looking feed),
   * instead of silently reverting to the feed body until the user asks again. */
  fullContentStale: boolean;
  enclosures: Enclosure[];
}

/** An item joined with its source feed — the shape feed/library lists render. */
export interface FeedItem {
  item: Item;
  feed: Feed;
}

export type ItemStateField =
  | 'pinned'
  | 'favorite'
  | 'done'
  | 'hidden'
  | 'opened';

/** Per-(user, item) state. Absence of a stored row means the default below
 * (everything false) — see SPEC.md *Data model* (sparse item_state). */
export interface ItemState {
  pinned: boolean;
  pinnedAt: number | null;
  favorite: boolean;
  favoriteAt: number | null;
  done: boolean;
  doneAt: number | null;
  hidden: boolean;
  hiddenAt: number | null;
  opened: boolean;
  openedAt: number | null;
  /** Server-assigned monotonic version (SPEC.md *Sync*). */
  version: number;
}

export interface Subscription {
  feedId: FeedId;
  folder: string | null;
  titleOverride: string | null;
  muted: boolean;
  sort: number;
}

export interface Folder {
  name: string;
  sort: number;
}

export const DEFAULT_ITEM_STATE: ItemState = {
  pinned: false,
  pinnedAt: null,
  favorite: false,
  favoriteAt: null,
  done: false,
  doneAt: null,
  hidden: false,
  hiddenAt: null,
  opened: false,
  openedAt: null,
  version: 0,
};

/** Hidden and Opened expire after 7 days (SPEC.md *Retention*). */
export const TTL_MS = 7 * 24 * 60 * 60 * 1000;
