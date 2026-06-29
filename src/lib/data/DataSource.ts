import type {
  Feed,
  FeedId,
  FeedItem,
  Folder,
  Item,
  ItemId,
  OpenMode,
  Subscription,
} from '../types';
import type { FullTextResult } from '../fullText';
import type { ItemStateStore } from './itemState';

/** Per-user capability flags, resolved from the server (`get_capabilities` RPC).
 * Drives the FAMILY chip, the `/admin` gate, and the reader's "should I even
 * call the gated full-text function?" short-circuit. */
export interface Capabilities {
  /** The caller is explicitly on the trusted-user allowlist — i.e. the allowlist
   * is armed AND lists them. False for everyone when the allowlist is empty. */
  family: boolean;
  /** The caller may reach `/admin` and edit the allowlist. */
  admin: boolean;
  /** The allowlist has at least one entry, so the gates are enforced. When
   * false the gates are open to all; `canUseFullText = !allowlistArmed || family`. */
  allowlistArmed: boolean;
  /** The backend has migration 0030's user-management RPCs (block / delete /
   * disable-signups) deployed. The frontend auto-deploys ahead of migrations,
   * so a new client can hit a backend that predates 0030; this is absent there,
   * letting `/admin` hide those controls until their RPCs exist rather than
   * offer buttons that only error. Optional so the default (undefined → falsy)
   * is the safe "not available yet" state. */
  canManageUsers?: boolean;
}

/** One allowlist entry as shown on `/admin` (admin-only read). */
export interface AllowlistEntry {
  email: string;
  addedBy: string | null;
  createdAt: string;
}

/** A registered account as shown on the `/admin` users list (admin-only read of
 * `auth.users`), annotated with its trusted-user and operator status. */
export interface RegisteredUser {
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
  /** On the trusted-user allowlist (reading mode + Google News + FAMILY chip). */
  family: boolean;
  /** An operator (in `admin_users`; may reach `/admin`). */
  admin: boolean;
  /** Suspended — `auth.users.banned_until` is in the future, so the account
   * can't sign in until unblocked. Distinct from deleted (the row is gone). */
  blocked: boolean;
}

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
 *   - `blocked`     — adding this feed isn't allowed for this account (e.g. a
 *     Google News feed when the caller isn't on the trusted-user allowlist).
 */
export type AddFeedErrorKind =
  | 'signed-out'
  | 'feed-auth'
  | 'no-feed' // reachable, but neither a feed nor advertising one
  | 'not-found' // the URL 404/410'd
  | 'unreachable' // network/DNS/timeout/SSRF-blocked/5xx
  | 'blocked' // disallowed for this account (e.g. Google News, off-allowlist)
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
  /** Per-feed "open original": when true, the feed's article rows open the
   * original article on the source website directly (new tab) instead of the
   * in-app reader. */
  setOpenOriginal(feedId: FeedId, openOriginal: boolean): Promise<void>;
  /** Whether the backend supports the "open original" preference (the
   * `open_original` column exists). False against a backend that predates the
   * migration, so the UI can hide the control rather than offer a write the old
   * backend rejects. Omitted sources are assumed to support it. */
  supportsOpenOriginal?(): boolean;
  /** Set a feed's open mode — the mutually-exclusive choice of where its article
   * rows open: the in-app `reader` (default), the `original` source website, or
   * the item's Hacker News discussion on `newshacker`. Writes the `open_original`
   * and `open_newshacker` booleans **atomically in one update**, so a feed can
   * never be left with both set (which an old client that only knows
   * `open_original` would misread). `newshacker` is offered for Hacker News feeds
   * only. */
  setOpenMode(feedId: FeedId, mode: OpenMode): Promise<void>;
  /** Whether the backend supports the "open on newshacker" preference (the
   * `open_newshacker` column, 0034, exists). False against a backend that
   * predates the migration, so the UI hides the newshacker option rather than
   * offer a write the old backend rejects. Omitted sources are assumed to
   * support it. */
  supportsOpenNewshacker?(): boolean;
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
  /** Epoch ms of the last successful server `item_state` pull (boot hydration or
   * a cross-device resync), or null if none has completed this session. Surfaced
   * on `/debug` as "Last sync". Optional: sources with no server to reconcile
   * against (the in-memory mock) omit it, and `/debug` then shows it as N/A. */
  getLastSyncedAt?(): number | null;

  // --- OPML -----------------------------------------------------------------
  importOpml(xml: string): Promise<{ added: number; skipped: number }>;
  exportOpml(): Promise<string>;

  // --- Capabilities & admin -------------------------------------------------
  /** The signed-in user's capability flags (FAMILY chip, `/admin` gate, full-text
   * short-circuit). Implementations **feature-detect** a backend that predates
   * the RPC and return all-false rather than throwing, so an old backend just
   * behaves like today (guardrail #11). */
  getCapabilities(): Promise<Capabilities>;
  /** Admin-only: the current allowlist. Rejects for non-admins (the server is
   * the boundary; the UI also hides `/admin`). */
  listAllowlist(): Promise<AllowlistEntry[]>;
  /** Admin-only: add / remove an allowlist email. Doubles as promote/demote
   * family for a registered user (the user list calls these by email). */
  addToAllowlist(email: string): Promise<void>;
  removeFromAllowlist(email: string): Promise<void>;
  /** Admin-only: registered accounts, annotated with family/admin status.
   * Feature-detects a backend that predates the RPC and returns `[]` so an old
   * backend just shows an empty list rather than crashing (guardrail #11). */
  listUsers(): Promise<RegisteredUser[]>;
  /** Admin-only: permanently delete an account by email (cascades the user's
   * reader data; drops them from the allowlist + admin list). The server
   * refuses to delete the calling admin. */
  deleteUser(email: string): Promise<void>;
  /** Admin-only: suspend (`blocked = true`) or restore an account by email.
   * The server refuses to block the calling admin. */
  setUserBlocked(email: string, blocked: boolean): Promise<void>;
  /** Admin-only: whether new sign-ups are currently allowed. Feature-detects a
   * backend that predates the switch and returns `true` (the default-open
   * state) so an old backend just reports sign-ups on (guardrail #11). */
  getSignupsEnabled(): Promise<boolean>;
  /** Admin-only: turn new account creation on or off globally. */
  setSignupsEnabled(enabled: boolean): Promise<void>;
}

/** Items already cached on this device (offline view); resolved from the
 * persisted query cache rather than the network. The mock returns pinned +
 * favorited items, which are the always-offline buckets. */
export type OfflineReader = () => Promise<Item[]>;
