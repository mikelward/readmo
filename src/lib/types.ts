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

/** Done, Opened, and the legacy Hidden column are retained for this long, then
 * collapse to their default on read (`withRetention`), so `/done` and `/opened`
 * auto-prune without a background sweep. Pinned and Favorite never expire.
 *
 * **This TTL is deliberately longer than `FLOOR_MAX_AGE_MS`** (the oldest a
 * non-pinned item can still appear in a feed). That ordering is what stops a
 * swept item from resurfacing: an item leaves every list once it's older than
 * `FLOOR_MAX_AGE_MS`, which happens *before* its `done` flag expires here — so by
 * the time Done collapses, the item is no longer listable anyway and can't pop
 * back into the per-feed floor. (Done used to share the 30-day window with the
 * floor's reach, so an item swept in a quiet feed reappeared the day its Done
 * expired.) Keep `TTL_MS > FLOOR_MAX_AGE_MS > HOME_WINDOW_MS`. */
export const TTL_MS = 33 * DAY_MS;

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
 * OR among its feed's newest `FEED_FLOOR` AND younger than `FLOOR_MAX_AGE_MS`.
 * Mirrored by the `feed_items` RPC. */
export const FEED_FLOOR = 10;

/** Hard age cap on the per-feed floor: the floor never lists an item older than
 * this, even to keep a feed from going blank. Two jobs:
 *  1. **Bounds the read.** Without a cap, the floor's "newest 10 non-dismissed"
 *     walks a feed's whole archive when the user has swept most of it (every Done
 *     row must be skipped before 10 survivors are found) — turning a top-N lookup
 *     into a full scan and risking statement timeouts on heavy accounts.
 *  2. **Stops swept items resurfacing.** Because this cap is *shorter* than
 *     `TTL_MS`, any item still young enough for the floor still has its Done flag
 *     active (Done outlives the floor), so a swept item is consistently excluded
 *     for its entire listable life and can't reappear when Done later expires.
 * Keep `TTL_MS > FLOOR_MAX_AGE_MS > HOME_WINDOW_MS`. Mirrored by `feed_items` /
 * `feed_unread_counts` (the `30 days` interval) — keep them in sync. */
export const FLOOR_MAX_AGE_MS = 30 * DAY_MS;

/** Per-feed window for the group-by-feed view: each feed section opens showing
 * at most this many of its listable items, with a per-section "More" button to
 * reveal the next `PER_FEED_WINDOW` (and so on) without paging the whole river.
 * Only applies when grouping by feed; the flat river pages globally instead.
 * Threaded into the `feed_items` RPC as `p_per_feed_limit` and mirrored by the
 * client merge in {@link ItemList}. */
export const PER_FEED_WINDOW = 10;
