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
   * (the feed's own body, which is often a truncated stub). See
   * `lib/fullText.ts` and the `fulltext` Edge Function. */
  fullContentHtml: string | null;
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Done, Opened (and the legacy Hidden column) are retained for 30 days, then
 * collapse to their default on read (SPEC.md *Retention*). Pinned and Favorite
 * never expire. One shared window keeps the history views (`/done`, `/opened`)
 * and the feed's dismiss state aligned. */
export const TTL_MS = 30 * DAY_MS;

/** Home / folder / feed list views only serve items younger than this — the
 * feed freshness window (SPEC.md *Feed freshness window*). Pinned items are
 * exempt: a pin keeps an item in the list regardless of age. This is the single
 * knob; the server `feed_items` RPC applies the same interval. */
export const HOME_WINDOW_MS = 3 * DAY_MS;

/** Per-feed floor: each feed always contributes at least its newest
 * `FEED_FLOOR` (non-dismissed) items to list views even when they're older than
 * the freshness window, so an infrequently-updated feed still shows something
 * instead of going blank (SPEC.md *Feed freshness window*). The window and the
 * floor are unioned: an item shows if it's pinned, OR younger than the window,
 * OR among its feed's newest `FEED_FLOOR`. Mirrored by the `feed_items` RPC. */
export const FEED_FLOOR = 10;
