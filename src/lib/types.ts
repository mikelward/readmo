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
  /** The item's comments/discussion page (RSS `<comments>` / Atom
   * `rel="replies"`), or null. Distinct from `url` (the article); for aggregator
   * feeds (Hacker News) this is the thread. List rows carry it (the `feed_items`
   * RPC returns the whole item row); ITEM_COLS direct reads (library/search/
   * reader) omit it, so consumers must tolerate null there. */
  commentsUrl: string | null;
  title: string;
  /** A spoiler-free rewrite of `title` for sports-result headlines, e.g.
   * "EPL MNU v ARS spoiler" / "F1 Qualifying spoiler" — the short competition
   * name first, no scoreline/winner. Generated server-side (Gemini) at poll time
   * for allowlisted-subscriber feeds and cached on the shared item; null when the
   * headline isn't a sports-result spoiler, when it hasn't been processed, or
   * against a backend predating the column. The original always stays in `title`,
   * so display is reversible — see `lib/spoilerHeadline.ts`. */
  spoilerFreeTitle: string | null;
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
  /** The cached AI summary (markdown), delivered ON the list row for an
   * allowlisted caller so the reader shows it instantly and offline without a
   * separate `summary` Edge call. Null when there's none cached yet, when the
   * caller isn't allowlisted (the server NULLs it — `feed_items` gates it on
   * `email_is_allowlisted`, 0058), or against a backend predating the gate (it
   * NULLs the column for everyone). The reader falls back to the `summary` Edge
   * call in all those cases, so this is a fast path, not the only path. */
  aiSummary: string | null;
  enclosures: Enclosure[];
  /** The item's categories/tags/sections as the publisher labeled them (RSS/RDF
   * `<category>`, Atom `<category>`, or JSON Feed `tags`), publisher order.
   * `categories[0]` is shown in list-view meta rows in place of the author (see
   * `lib/itemMeta.ts`). Empty array, never null/undefined, when the feed
   * carries none or against a backend predating the column. */
  categories: string[];
}

/** An item joined with its source feed — the shape feed/library lists render. */
export interface FeedItem {
  item: Item;
  feed: Feed;
  /** True when this was resolved via a shared /item/:id link the caller can't
   * otherwise see (a public feed they don't subscribe to — `get_shared_item`,
   * 0068), rather than their own subscription/state. The reader renders such an
   * item read-only: `item_state` writes (pin/favorite/done/opened) would be
   * rejected by RLS for a non-subscriber, so those controls are hidden. Absent
   * (falsy) for a normal, owned read. */
  shared?: boolean;
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

/** How much of each of a feed's articles a row shows — the "card style". 'title'
 * is the compact title-only row; 'thumbnail-small' adds a small right thumbnail;
 * 'thumbnail' is a larger card with a large right thumbnail; 'excerpt' shows a
 * preview of the feed body. Used both app-wide (the per-device `readmo:list-layout`
 * default, see hooks/useReadingPrefs) and as a per-feed override on
 * {@link Subscription.listLayout}. */
export type ListLayout = 'title' | 'thumbnail-small' | 'thumbnail' | 'excerpt';

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
  /** When true, opening one of this feed's items on the original source website
   * (open-original mode or the reader's Open-original button) or the newshacker
   * discussion (newshacker mode) also marks it Done. Deliberately does NOT fire
   * for an in-app reader (article view) open — the setting is scoped to the
   * outbound open actions. Independent of the open mode above; per-user, synced
   * (SPEC.md *Mark done when opening*). */
  markDoneOnOpen: boolean;
  /** Per-feed "card style" override — how much of this feed's articles a row
   * shows. `null` (the default) means "use the app-wide Article layout setting"
   * (`readmo:list-layout`, per-device); a non-null value overrides it for this
   * feed only. Per-user, synced (SPEC.md *Article layout → Per-feed override*). */
  listLayout: ListLayout | null;
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

/** How far back the item_state hydrate read reaches. A row older than this on
 * EVERY one of its five clocks, and neither pinned nor favorite, can no longer
 * affect what the client renders: `withRetention` collapses its Done/Hidden/
 * Opened flags to their defaults anyway, and its clocks are far too old to win
 * a last-write-wins compare against any write a client could still replay.
 * Fetching such rows only grows the read forever (item_state is never deleted —
 * every pin/favorite/done/hide/**open** adds a row that outlives its own
 * usefulness), so the hydrate filters them out server-side.
 *
 * Deliberately a day MORE than TTL_MS so the read is strictly more inclusive
 * than `withRetention`: the cutoff is computed from the client clock while the
 * stamps come from the server's, and this margin means ordinary skew can never
 * drop a row the client would still have shown. */
export const LIVE_STATE_MAX_AGE_MS = TTL_MS + DAY_MS;

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

/** Every article-load size any picker offers, smallest first (the order the
 * Settings chips take). Each preference below draws its own choices from this
 * scale — the two paging shapes want different amounts, so they share neither
 * a number nor a list. */
export const ARTICLE_LOAD_COUNTS = [5, 10, 20, 30, 40, 50] as const;

export type ArticleLoadCount = (typeof ARTICLE_LOAD_COUNTS)[number];

/** Sizes offered for *Articles per page*, spanning both sides of the default
 * (30). No 5 — the flat river's page size is a fetch, and a five-row page
 * would turn ordinary reading into a "More" drill; 10 is kept as the floor
 * even though it's small for a river, since offering it costs nothing. The
 * upper end runs to 50 for the opposite reader: one big load, then read. */
export const ARTICLES_PER_PAGE_OPTIONS = [10, 20, 30, 40, 50] as const;

/** Sizes offered for *Articles per feed section*. Includes 5, which the page
 * size doesn't: a section window costs no request, and a short one is how you
 * skim many feeds' headlines at once rather than reading one down. Stops at 30
 * — past that a single section fills the screen and grouping stops buying
 * anything over the flat river. */
export const ARTICLES_PER_SECTION_OPTIONS = [5, 10, 20, 30] as const;

/** Default *Articles per page*: how many rows the FLAT river loads per read —
 * what a fresh load lands and what each "More" appends. Sent as the read's
 * `limit`, so every step of it is a request (SPEC.md *Feed views → Articles
 * per page*). */
export const DEFAULT_ARTICLES_PER_PAGE: ArticleLoadCount = 30;

/** Default *Articles per feed section*: the per-feed DISPLAY window for the
 * group-by-feed view. Each section opens showing ALL of its pinned items plus
 * at most this many of its listable body items, and the section's own "More"
 * reveals the next windowful. Pinned items are exempt so pins never crowd
 * articles out of a refreshed section.
 *
 * Purely a client-side window: the grouped read fetches whatever the server
 * returns for each feed — the server decides any fetch cap, not the client
 * (SPEC.md *Per-section More + per-feed window*) — so this costs no request at
 * any size. That's why it's a separate number from the page size above, and a
 * smaller one: a section is a slice of the screen, not the whole of it. */
export const DEFAULT_ARTICLES_PER_SECTION: ArticleLoadCount = 10;
