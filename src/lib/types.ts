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
  /** Display-safe feed URL (no embedded secret). */
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
