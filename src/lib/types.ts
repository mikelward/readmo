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
  /** Poller's measured verdict on whether the favicon is a dark monochrome
   * mark that should be inverted in dark mode (see `lib/faviconInvert.ts` and
   * the `summary`-style `faviconDarkness` decoder). Tri-state: true = invert,
   * false = measured-not-dark, null/absent = not yet measured / undecodable
   * (the client falls back to its manual domain list). Optional: absent against
   * a pre-0037 backend or the mock source. */
  faviconInvertDark?: boolean | null;
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
  /** The item's comments/discussion page (RSS `<comments>` / Atom
   * `rel="replies"`), or null. Distinct from `url` (the article); for aggregator
   * feeds (Hacker News) this is the thread. List rows carry it (the `feed_items`
   * RPC returns the whole item row); ITEM_COLS direct reads (library/search/
   * reader) omit it, so consumers must tolerate null there. */
  commentsUrl: string | null;
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
 * (everything false) — see SPEC.md *Data model* (sparse item_state).
 *
 * Each `*At` is the wall-clock time the field last changed value — both the
 * ordering/TTL key (read only while the flag is true) AND the per-field
 * last-write-wins clock the sync path compares (SPEC.md *Sync*). */
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
}

export interface Subscription {
  feedId: FeedId;
  folder: string | null;
  titleOverride: string | null;
  muted: boolean;
  /** When true, this feed's article rows open the original article on the source
   * website directly (new tab) instead of the in-app reader. Per-user, synced
   * (SPEC.md *Open original*). */
  openOriginal: boolean;
  /** When true, this feed's article rows open the item's Hacker News discussion
   * on newshacker.app instead of the in-app reader. Offered for Hacker News feeds
   * only; mutually exclusive with `openOriginal` in the UI (see {@link OpenMode}),
   * but stored independently so an older client that only knows `openOriginal`
   * still works. Per-user, synced (SPEC.md *Open original / Open on newshacker*). */
  openNewshacker: boolean;
  sort: number;
}

/** Where a feed's article rows open on tap — the per-feed "open mode" shown as a
 * single mutually-exclusive choice in Settings. `reader` (default) is the in-app
 * reader; `original` opens the source website; `newshacker` opens the item's
 * Hacker News discussion on newshacker.app (Hacker News feeds only). Derived from
 * the `openOriginal` / `openNewshacker` booleans on {@link Subscription}. */
export type OpenMode = 'reader' | 'original' | 'newshacker';

/** The {@link OpenMode} for a subscription. `original` takes precedence over
 * `newshacker` when both flags are set. A current client never writes that
 * both-true state (`setOpenMode` flips both columns atomically — newshacker mode
 * clears `open_original`), so the only way to reach it is a service-worker-cached
 * **legacy** client that knows only `open_original` writing `open_original=true`
 * on a feed a newer client had set to newshacker. That write *is* an explicit
 * "open original" choice, so resolving both-true to `original` honors the legacy
 * client's intent rather than letting the stale `open_newshacker` flag override
 * it. Mirrored by the row's open-target precedence in {@link ItemRow}. */
export function openModeOf(sub: {
  openOriginal: boolean;
  openNewshacker: boolean;
}): OpenMode {
  if (sub.openOriginal) return 'original';
  if (sub.openNewshacker) return 'newshacker';
  return 'reader';
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

/** Per-feed floor: each feed always contributes its newest `FEED_FLOOR` items
 * *by date* to list views even when they're older than the freshness window, so
 * an infrequently-updated feed still shows something instead of going blank
 * (SPEC.md *Feed freshness window*). The floor ranks by date irrespective of
 * state — Done/Hidden still occupy their slot and are filtered afterward — so
 * dismissing a recent item shrinks the feed rather than backfilling an older
 * one. The window and the floor are unioned: an item shows if it's pinned, OR
 * younger than the window, OR among its feed's newest `FEED_FLOOR`. Mirrored by
 * the `feed_items` RPC. */
export const FEED_FLOOR = 10;

/** Per-feed window for the group-by-feed view: each feed section opens showing
 * at most this many of its listable items, with a per-section "More" button to
 * reveal the next `PER_FEED_WINDOW` (and so on) without paging the whole river.
 * Only applies when grouping by feed; the flat river pages globally instead.
 * Threaded into the `feed_items` RPC as `p_per_feed_limit` and mirrored by the
 * client merge in {@link ItemList}. */
export const PER_FEED_WINDOW = 10;
