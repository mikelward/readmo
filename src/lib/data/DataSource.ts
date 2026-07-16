import type {
  Feed,
  FeedId,
  FeedItem,
  Folder,
  Item,
  ItemId,
  ListLayout,
  OpenMode,
  Subscription,
} from '../types';
import type { FullTextResult } from '../fullText';
import type { SummaryResult } from '../summary';
import type { MirrorPayload } from '../newshackerSync';
import type { SyncedSettings } from '../settingsSync';
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
  /** The backend has migration 0047's admin subscription-view RPCs
   * (`admin_list_user_feeds` / `admin_list_feed_subscribers`) deployed. Same
   * ahead-of-migration story as `canManageUsers`: absent on an older backend, so
   * the admin console hides the "Feeds"/"Users" drill-down menu items until the
   * RPCs exist rather than link to a page that would only error. */
  canViewSubscriptions?: boolean;
  /** The backend has migration 0068's `get_shared_item` deployed. Same
   * ahead-of-migration story: absent on an older backend, so the reader's Share
   * hands out the publisher URL until the RPC exists — a `/item/:id` link a
   * non-subscriber couldn't yet resolve would only 404 (guardrail #11). */
  sharedItems?: boolean;
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

/** One feed a given account subscribes to, as shown on the admin drill-down
 * `/admin/users/:email/feeds` (admin-only read of another user's RLS-gated
 * subscriptions). Display-safe fields only — never the feed's secret URL. */
export interface AdminUserFeed {
  feedId: FeedId;
  /** The user's own title override if set, else the feed's title (matches what
   * that user sees in-app). */
  title: string;
  siteUrl: string | null;
  /** Subscribed but muted — drops out of the aggregate for that user. */
  muted: boolean;
  /** Folder the user filed the feed under, or null at the list root. */
  folder: string | null;
  /** ISO timestamp the user subscribed. */
  subscribedAt: string;
}

/** One account subscribed to a given feed, as shown on the admin drill-down
 * `/admin/feeds/:feedId/users` (admin-only read). Carries the same
 * family/blocked status as the registered-users list. */
export interface AdminFeedSubscriber {
  email: string;
  /** On the trusted-user allowlist. */
  family: boolean;
  /** Suspended (`auth.users.banned_until` in the future). */
  blocked: boolean;
  /** This user muted the feed (still subscribed). */
  muted: boolean;
  /** ISO timestamp the user subscribed. */
  subscribedAt: string;
}

/** One system feed as shown on the admin `/admin/feeds` status console
 * (admin-only read). Pairs the feed's fetch-health fields with a single
 * representative "sample" item so the operator can see, per feed, whether the
 * last poll failed and whether the shared full-text / AI-summary caches have
 * warmed for a real article. */
export interface AdminFeedStatus {
  id: FeedId;
  title: string;
  siteUrl: string | null;
  faviconUrl: string | null;
  /** ISO timestamp of the last successful/attempted poll, or null (never
   * fetched, or an older backend that doesn't report it). */
  lastFetchedAt: string | null;
  /** Consecutive poll failures — 0 once a poll succeeds, so `> 0` means the most
   * recent fetch failed. */
  errorCount: number;
  lastError: string | null;
  /** How many users subscribe to this feed (across all accounts), or `null` when
   * the backend doesn't report it yet (a client deployed ahead of the migration
   * that added the count — shown as unknown rather than a false 0). */
  subscriberCount: number | null;
  /** The feed is paused: the poller/refresh skip it and full-text/summaries are
   * declined for its items. Stored articles stay readable. `null` when the
   * backend doesn't report it yet (a client deployed ahead of the migration that
   * added the flag) — the console then hides Pause/Unpause rather than offering a
   * control whose RPC would 404. */
  paused: boolean | null;
  /** `errorCount > 0` — the most recent poll failed. */
  fetchFailed: boolean;
  /** Circuit breaker tripped (`errorCount >= 8`); the poller has stopped
   * retrying until a manual refresh clears it. */
  parked: boolean;
  /** The most-recently-pinned article in this feed, or null when nothing in the
   * feed is pinned (→ the "no pinned" status). */
  sample: AdminFeedSampleItem | null;
}

/** The last reading-mode download outcome recorded for an article
 * (`item_fulltext_status.status`), or null when the pipeline never ran. */
export type FulltextDownloadStatus = 'ok' | 'auth' | 'unreachable' | 'empty';

/** The article in a feed with the most recent reading-mode download attempt, for
 * `/admin/feeds`. A recorded attempt only exists for an allowlisted fetch.
 * Carries the cached-body presence plus that attempt — status, the publisher's
 * HTTP code, the failure reason, and (for a robots block) the matching rule — so
 * the operator can see whether the download failed and why. Never the body. */
export interface AdminFeedSampleItem {
  id: ItemId;
  title: string | null;
  /** The shared `full_content_html` cache is populated — a definitive success,
   * even for articles fetched before attempts were recorded. */
  hasFullContent: boolean;
  /** The recorded attempt's outcome (always set for a sample — a sample exists
   * only because an attempt was recorded). */
  downloadStatus: FulltextDownloadStatus | null;
  /** The publisher's HTTP status from that attempt (e.g. 403), or null. */
  downloadHttpStatus: number | null;
  /** A short reason for a non-`ok` outcome (e.g. 'disallowed by robots.txt
   * (User-agent: *)'), or null. */
  downloadError: string | null;
  /** The exact robots.txt directive that blocked the fetch (e.g.
   * 'Disallow: /news/'), when the outcome was a robots disallow; else null. */
  downloadRobotsRule: string | null;
  /** ISO timestamp of that attempt, or null. */
  downloadAttemptedAt: string | null;
}

/** Which AI generation path an {@link AiCall} came from — the reader's article
 * summary, or the poll-time spoiler-free-headline classifier. Both run through
 * the same Gemini/`GOOGLE_API_KEY` path (0067). */
export type AiCallKind = 'summary' | 'spoiler';

/** One recorded AI generation call, as shown on the admin `/admin/ai` console
 * (admin-only read of `ai_call_log`, 0067). Operational metadata only. */
export interface AiCall {
  kind: AiCallKind;
  /** The terminal outcome. summary: `ok` | `empty` | `unavailable` (key unset) |
   * `unreachable` (transient) | `blocked` (page unreadable — no Gemini call) |
   * `accepted`; spoiler: `rewrite` | `none` | `failed`. Free text so a new
   * status needs no client change. */
  status: string;
  /** The model's HTTP status when the call reached Gemini (e.g. 200, 429, 503),
   * or null when it never did (key unset, transport failure). */
  httpStatus: number | null;
  /** The item the call was for, or null when the item has since been reaped. */
  itemId: ItemId | null;
  /** The item's title for display, or null (item reaped, or untitled). */
  itemTitle: string | null;
  /** A short reason for a non-success outcome, or null. */
  error: string | null;
  /** ISO timestamp of the call. */
  createdAt: string;
}

/** One (kind, status) tally over a recent window, for the `/admin/ai` health
 * summary (admin-only read; 0067). */
export interface AiCallCount {
  kind: AiCallKind;
  status: string;
  count: number;
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
   * No effect on a single-feed view. Defaults to `false`. The grouped read
   * carries each feed's full listable set in one deep page — the client sends
   * no per-feed fetch cap; the server decides what (and how much) to return,
   * and the view windows it client-side for display. */
  groupByFeed?: boolean;
}

/** Result of {@link DataSource.debugFeedProbe} — the `/debug` feed-read probe. */
export interface FeedProbeResult {
  /** Milliseconds the grouped read took end to end. */
  groupedMs: number;
  /** Rows the backend returned for the grouped windowed read, before any
   * client-side resolution — null when the source has no raw layer (mock). */
  groupedRawRows: number | null;
  /** Grouped rows that survived feed-metadata resolution (what the view gets). */
  groupedResolvedRows: number;
  /** Resolved grouped rows per feed, in section order. */
  perFeed: Array<{ title: string; rows: number }>;
  /** Rows the flat first page resolved to (comparison baseline). */
  flatResolvedRows: number;
  /** Error message when a read failed; the counts above cover whatever
   * completed before the failure. */
  error?: string;
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
 *   - `feed-limit`  — the account is at its per-account feed cap; an existing
 *     feed must be removed before another can be added.
 */
export type AddFeedErrorKind =
  | 'signed-out'
  | 'feed-auth'
  | 'no-feed' // reachable, but neither a feed nor advertising one
  | 'not-found' // the URL 404/410'd
  | 'unreachable' // network/DNS/timeout/SSRF-blocked/5xx
  | 'blocked' // disallowed for this account (e.g. Google News, off-allowlist)
  | 'feed-limit' // the account is at its per-account feed cap (0059)
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
   * thing for a paywall/teaser/unreachable page rather than a hard failure.
   * `opts.signal` (React Query's per-fetch signal, threaded by the queryFn)
   * aborts the underlying request — so cancelling the query (the foreground-
   * resume path in useOfflineCacheLock) frees the transport instead of leaving
   * it running to the invoke timeout. */
  fetchFullText(id: ItemId, opts?: { signal?: AbortSignal }): Promise<FullTextResult>;
  /** Fetch (or return the cached) one-sentence AI summary for an item — shown at
   * the top of the reader when an allowlisted user pins the article. The server
   * generates it from the item's already-stored sanitized body (no new publisher
   * fetch) and caches it on the shared item. Returns a typed outcome so the
   * reader can stay silent on a soft failure (allowlist denial, not configured,
   * nothing to summarize) rather than showing a hard error. The pin is the
   * trigger (the reader only calls this for a pinned item) and the `allowlist`
   * table is the server-enforced boundary. `opts.signal` as in fetchFullText. */
  getSummary(id: ItemId, opts?: { signal?: AbortSignal }): Promise<SummaryResult>;

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
  /** Set a feed's open mode — the mutually-exclusive choice of where its article
   * rows open: the in-app `reader` (default), the `original` source website, or
   * the item's Hacker News discussion on `newshacker`. Writes the `open_original`
   * and `open_newshacker` booleans **atomically in one update**, so a feed can
   * never be left with both set. `newshacker` is offered for Hacker News feeds
   * only. */
  setOpenMode(feedId: FeedId, mode: OpenMode): Promise<void>;
  /** Per-feed "mark done when opening": when true, opening one of the feed's
   * items on the original source website or the newshacker discussion also marks
   * it Done. Deliberately does NOT cover an in-app reader (article view) open.
   * Independent of the open mode. */
  setMarkDoneOnOpen(feedId: FeedId, markDoneOnOpen: boolean): Promise<void>;
  /** Per-feed "card style" override: how much of this feed's articles a row
   * shows. Pass a {@link ListLayout} to override the app-wide Article layout
   * setting for this feed only, or `null` to clear the override (fall back to the
   * app setting). Per-user, synced. */
  setSubscriptionListLayout(
    feedId: FeedId,
    listLayout: ListLayout | null,
  ): Promise<void>;
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
   * the local source of truth — there's no server to reconcile against).
   *
   * Pass `force: true` when the caller has just applied server-side changes it
   * MUST see reflected (the newshacker reverse pull): a plain call may coalesce
   * onto an in-flight read that started *before* the write, so `force` chains a
   * guaranteed-fresh read after any in-flight one instead. */
  resyncState(force?: boolean): Promise<void>;
  /** Epoch ms of the last successful server `item_state` pull (boot hydration or
   * a cross-device resync), or null if none has completed this session. Surfaced
   * on `/debug` as "Last sync". Optional: sources with no server to reconcile
   * against (the in-memory mock) omit it, and `/debug` then shows it as N/A. */
  getLastSyncedAt?(): number | null;
  /** The account's synced reading-behavior settings (`user_settings`, 0064) —
   * only the columns the user has set; `{}` when the row doesn't exist yet;
   * `null` when the backend can't serve them (a backend predating the table —
   * feature-detected, guardrail #11 — or a transient failure). Optional: the
   * mock omits both methods and prefs stay device-local, exactly the demo-mode
   * behavior (no account, nothing to sync). Consumed by useSettingsSync. */
  getSyncedSettings?(): Promise<Partial<SyncedSettings> | null>;
  /** Merge the given settings into the account's `user_settings` row (only the
   * passed keys change — per-column last-write-wins across devices). Throws on
   * any failure — transient or a backend without the table — so the caller
   * keeps the change pending and retries: pre-migration values must never be
   * acknowledged as delivered, or they'd stay device-local forever once the
   * table exists (local == acked, nothing left to push). */
  setSyncedSettings?(patch: Partial<SyncedSettings>): Promise<void>;
  /** On-demand `/debug` probe: run the grouped windowed home read (and a flat
   * page for comparison) OUTSIDE the query cache and report where rows survive
   * — raw rows the backend returned, rows left after feed-metadata resolution,
   * and the per-feed split — so a device with no devtools can pinpoint whether
   * an empty grouped view lost its rows in transit, in resolution, or in
   * rendering. Runs under the caller's active body sort — and, when the
   * drawer's Home override scopes `/` to a folder, against that folder — so it
   * exercises the same read as the view being diagnosed (defaults: newest,
   * the all-subscriptions aggregate). Optional; `/debug` hides the probe when
   * the source omits it. */
  debugFeedProbe?(sort?: ItemSort, folder?: string | null): Promise<FeedProbeResult>;

  // --- newshacker dismissal mirror ------------------------------------------
  /** Whether this account has linked a newshacker app token, so dismissing a
   * Hacker News item here also marks it Done on newshacker (SPEC.md *Mirror
   * dismissals to newshacker*). Feature-detects a backend without the
   * `newshacker_link_status` RPC and returns `{ linked: false }`, so an old
   * backend just behaves as "not linked". Optional — the mock implements it in
   * memory; a source without it is treated as unlinked. */
  getNewshackerLink?(): Promise<{ linked: boolean; supported: boolean }>;
  /** Store (or replace) this account's newshacker app token — the credential
   * the `newshacker-sync` Edge Function forwards. Throws on an invalid token or
   * a backend predating the `set_newshacker_token` RPC. */
  setNewshackerToken?(token: string): Promise<void>;
  /** Forget the newshacker link (disconnect); mirroring stops. */
  clearNewshackerLink?(): Promise<void>;
  /** Best-effort mirror of Hacker News **Done** and **Pinned** transitions to
   * newshacker's matching sync lists. Never throws — the mirror is additive and
   * the local state stays authoritative; no-ops when unlinked, unsupported, or
   * the batch has no HN items. */
  syncNewshackerState?(payload: MirrorPayload): Promise<void>;
  /** Reverse sync: pull the linked newshacker account's own **Done + Pinned**
   * lists and apply them to Readmo `item_state`, mapping each HN id back to a
   * subscribed item (SPEC.md *Mirror dismissals and pins to newshacker* →
   * reverse pull). Best-effort — never throws; returns `{ linked:false,
   * applied:0 }` when unlinked, unsupported, or on any failure. When it applied
   * anything it re-hydrates local state so the feed reflects it (hydration never
   * fires the outbound mirror, so there's no echo). `ok` distinguishes
   * "newshacker was consulted and its lists applied" (true) from "the backend
   * couldn't reach newshacker / couldn't apply" (false) — `applied: 0` alone
   * can't tell "nothing changed over there" from "nobody answered", and the
   * reverse-pull coordinator must not settle a handoff card on the latter.
   * Undefined on a backend predating the flag (callers should treat that as
   * consulted). Optional — a source without it, or an old backend missing the
   * RPC, simply pulls nothing. */
  pullNewshackerState?(): Promise<{ linked: boolean; applied: number; ok?: boolean }>;

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
  /** Admin-only: the feeds a given account subscribes to (drill-down from the
   * user list). Rejects for non-admins; the RPC is gated on 0047, so callers
   * feature-detect via `canViewSubscriptions` before offering the link. */
  listUserFeeds(email: string): Promise<AdminUserFeed[]>;
  /** Admin-only: the accounts subscribed to a given feed (drill-down from the
   * feed-status list). Rejects for non-admins; gated on 0047 like
   * `listUserFeeds`. */
  listFeedSubscribers(feedId: FeedId): Promise<AdminFeedSubscriber[]>;
  /** Admin-only: system-wide feed status for `/admin/feeds` — every feed's
   * fetch health plus a sample article's cache state. Feature-detects a backend
   * that predates the RPC and returns `[]` so an old backend just shows an empty
   * list rather than crashing (guardrail #11). */
  listFeedStatuses(): Promise<AdminFeedStatus[]>;
  /** Admin-only: hard-delete a shared feed system-wide (cascades its items and
   * every user's subscription to it). Irreversible; callers confirm first. The
   * server re-checks `is_admin()`. */
  deleteFeed(feedId: FeedId): Promise<void>;
  /** Admin-only: pause/unpause a feed. While paused the poller and refresh skip
   * it and full-text/summaries are declined for its items; stored articles stay
   * readable. The server re-checks `is_admin()`. */
  setFeedPaused(feedId: FeedId, paused: boolean): Promise<void>;
  /** Admin-only: whether new sign-ups are currently allowed. Feature-detects a
   * backend that predates the switch and returns `true` (the default-open
   * state) so an old backend just reports sign-ups on (guardrail #11). */
  getSignupsEnabled(): Promise<boolean>;
  /** Admin-only: turn new account creation on or off globally. */
  setSignupsEnabled(enabled: boolean): Promise<void>;
  /** Admin-only: the most recent AI generation calls (summary + spoiler) for the
   * `/admin/ai` observability console (`ai_call_log`, 0067). Feature-detects a
   * backend that predates the RPC and returns `[]` so an old backend just shows
   * an empty list rather than crashing (guardrail #11). `limit` caps the rows. */
  listAiCalls(limit?: number): Promise<AiCall[]>;
  /** Admin-only: (kind, status) call tallies over the last `sinceHours` (default
   * 24) for the `/admin/ai` health summary. Feature-detects an old backend and
   * returns `[]` like {@link listAiCalls}. */
  getAiCallCounts(sinceHours?: number): Promise<AiCallCount[]>;
}

/** Items already cached on this device (offline view); resolved from the
 * persisted query cache rather than the network. The mock returns pinned +
 * favorited items, which are the always-offline buckets. */
export type OfflineReader = () => Promise<Item[]>;
