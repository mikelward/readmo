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

/** Chronological order of the *body* of a feed view. Pinned items always stay
 * oldest-pinned-first at the top regardless (SPEC.md *Feed views → Pinned*); this
 * only flips the un-pinned body. Per-device, defaults to `newest`. */
export type ItemSort = 'newest' | 'oldest';

export interface FeedListOptions {
  /** Page cursor from a previous `Page.nextCursor`; omit for the first page. */
  cursor?: string | null;
  /** Page size; defaults to PAGE_SIZE (30). */
  limit?: number;
  /** Body order, newest- or oldest-first. Defaults to `newest`. */
  sort?: ItemSort;
  /** Group the body by feed (feed-title sections, A→Z), instead of one flat
   * chronological river. Pinned items stay in the global top section, ungrouped.
   * No effect on a single-feed view. Defaults to `false`. */
  groupByFeed?: boolean;
  /** Group-by-feed only: cap each feed's section to its newest this-many
   * listable items so a busy feed doesn't dump its whole window into the river.
   * The view's per-section "More" then pages deeper into that one feed (via a
   * single-feed read), independent of the other sections. Ignored when not
   * grouping (the flat river pages globally instead) and on a single-feed view.
   * Threaded to the `feed_items` RPC as `p_per_feed_limit`. */
  perFeedLimit?: number;
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
  /** Per-feed **unread / to-do** count for the given feeds: items in the feed's
   * listable set (freshness window ∪ per-feed floor ∪ pinned) that are **not**
   * Done or active Hidden, and either **pinned** or not Opened. A pinned item
   * always counts — a pin is a to-do, read or not — while any other item drops
   * out once Opened. Keyed by feed id; a feed with nothing outstanding is 0.
   * Surfaced on the group-by-feed section headers so a collapsed feed still
   * shows how much it holds, and reusable wherever a per-feed badge is wanted.
   * Bounded by the same window/floor the list is, so it's cheap. */
  getFeedUnreadCounts(feedIds: FeedId[]): Promise<Record<FeedId, number>>;
  /** Item ids with a still-unsynced local state write. `getFeedUnreadCounts` is
   * a server-only read that lags local triage by a round-trip, so the per-feed
   * badge discounts the pending Sweep/Done rows it still counts to update
   * immediately. Sources with no outbox (the in-memory mock) omit this — their
   * count is never stale, so there's nothing to correct. */
  pendingItemIds?(): ReadonlySet<ItemId>;
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
  /** Persist a new manual feed order (drag-to-reorder in Settings). Pass every
   * subscribed feed id in the desired order; each row's `sort` is reassigned to
   * its index. This drives the drawer/Settings list order and the group-by-feed
   * section order. RLS scopes the writes to the caller's own subscriptions. */
  reorderSubscriptions(orderedFeedIds: FeedId[]): Promise<void>;
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

  // --- Sync -----------------------------------------------------------------
  /** Re-pull server `item_state` so pins/favorites/done changed on *another
   * device* show up here, without waiting for the next cold boot. Callers fire
   * this when the tab regains focus/visibility or the device comes back online
   * (see `useStateSync`); the store emits on any change, which the feed-
   * invalidation hook turns into a refetch and the library pages read directly.
   * Implementations coalesce overlapping calls. The mock no-ops it (its store is
   * the local source of truth — there's no server to reconcile against). */
  resyncState(): Promise<void>;

  // --- OPML -----------------------------------------------------------------
  importOpml(xml: string): Promise<{ added: number; skipped: number }>;
  exportOpml(): Promise<string>;
}

/** Items already cached on this device (offline view); resolved from the
 * persisted query cache rather than the network. The mock returns pinned +
 * favorited items, which are the always-offline buckets. */
export type OfflineReader = () => Promise<Item[]>;
