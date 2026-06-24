import type {
  Feed,
  FeedId,
  FeedItem,
  Folder,
  Item,
  ItemId,
  Subscription,
} from '../types';
import type { FullTextResult } from '../fullText';
import type { ItemStateStore } from './itemState';

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null when exhausted. A non-null
   * cursor means the last page came back full, so another page *may* exist —
   * we don't carry a grand total (the feed never shows "X of Y", and a
   * window count over the whole filtered set is expensive at scale). */
  nextCursor: string | null;
}

export interface FeedListOptions {
  /** Page cursor from a previous `Page.nextCursor`; omit for the first page. */
  cursor?: string | null;
  /** Page size; defaults to PAGE_SIZE (30). */
  limit?: number;
}

export interface DiscoveredFeed {
  url: string;
  title: string;
  siteUrl: string | null;
  /** A few recent item titles, so the user can confirm before subscribing. */
  sampleTitles: string[];
}

/**
 * Why "Add a feed" couldn't complete, so the UI can show a specific message
 * instead of a single opaque failure. Distinguishes the two very different
 * "auth" cases the user asked us to separate:
 *   - `signed-out`  — the caller isn't authenticated to Readmo (the discover/
 *     refresh Edge Functions verify the JWT); the fix is to sign in again.
 *   - `feed-auth`   — the *target* feed itself is gated (the publisher returned
 *     401/403); a private/login-only feed can't be added.
 */
export type AddFeedErrorKind =
  | 'signed-out'
  | 'feed-auth'
  | 'no-feed' // reachable, but neither a feed nor advertising one
  | 'not-found' // the URL 404/410'd
  | 'unreachable' // network/DNS/timeout/SSRF-blocked/5xx
  | 'unknown';

/** A classified "Add a feed" failure (discover or subscribe). `kind` drives the
 * user-facing copy; `message` carries the underlying detail for logs. */
export class AddFeedError extends Error {
  readonly kind: AddFeedErrorKind;
  constructor(kind: AddFeedErrorKind, message?: string) {
    super(message ?? kind);
    this.name = 'AddFeedError';
    this.kind = kind;
  }
}

/**
 * Everything the Readmo UI needs from a backend. PR1 ships `MockDataSource`
 * (seeded, offline, localStorage state) behind this interface; PR2 ships
 * `SupabaseDataSource` with the identical surface so no UI code changes when
 * the real backend is wired in.
 *
 * Item *state* (pinned/favorite/done/hidden/opened) is read and mutated
 * through `stateStore` rather than these methods, so an optimistic toggle
 * never waits on a list refetch.
 */
export interface DataSource {
  readonly stateStore: ItemStateStore;

  // --- Feed reads -----------------------------------------------------------
  /** Aggregate of all non-muted subscriptions, newest first. */
  getHomeItems(opts?: FeedListOptions): Promise<Page<FeedItem>>;
  getFolderItems(name: string, opts?: FeedListOptions): Promise<Page<FeedItem>>;
  getFeedItems(feedId: FeedId, opts?: FeedListOptions): Promise<Page<FeedItem>>;
  getItem(id: ItemId): Promise<FeedItem | null>;
  /** Resolve arbitrary ids (used by library views, which span feeds). */
  getItemsByIds(ids: ItemId[]): Promise<FeedItem[]>;
  search(query: string): Promise<FeedItem[]>;
  /** Fetch (or return the cached) full-article body for an item — the reader's
   * reading-mode view for feeds that publish only a truncated stub. The server
   * extracts the article from its source page, sanitizes it, and caches it on
   * the shared item. Returns a typed outcome so the reader can render the right
   * thing for a paywall/teaser/unreachable page rather than a hard failure. */
  fetchFullText(id: ItemId): Promise<FullTextResult>;

  // --- Subscriptions & organization ----------------------------------------
  getSubscriptions(): Promise<Array<{ subscription: Subscription; feed: Feed }>>;
  getFolders(): Promise<Folder[]>;
  getFeed(feedId: FeedId): Promise<Feed | null>;
  discover(url: string): Promise<DiscoveredFeed[]>;
  subscribe(feedUrl: string, folder?: string | null): Promise<Feed>;
  unsubscribe(feedId: FeedId): Promise<void>;
  setMuted(feedId: FeedId, muted: boolean): Promise<void>;
  setTitleOverride(feedId: FeedId, title: string | null): Promise<void>;
  /** Force an immediate server-side refresh of one feed (or all). */
  refresh(feedId?: FeedId): Promise<void>;
  retryParkedFeed(feedId: FeedId): Promise<void>;

  // --- OPML -----------------------------------------------------------------
  importOpml(xml: string): Promise<{ added: number; skipped: number }>;
  exportOpml(): Promise<string>;
}

/** Items already cached on this device (offline view); resolved from the
 * persisted query cache rather than the network. The mock returns pinned +
 * favorited items, which are the always-offline buckets. */
export type OfflineReader = () => Promise<Item[]>;
