import {
  FEED_FLOOR,
  HOME_WINDOW_MS,
  type Feed,
  type FeedId,
  type FeedItem,
  type Folder,
  type Item,
  type ItemId,
  type ItemState,
  type ListLayout,
  type OpenMode,
  type Subscription,
} from '../types';
import {
  ItemStateStore,
  localStoragePersistence,
} from './itemState';
import { decodeXmlEntities } from './xmlEntities';
import { buildOpml } from './opml';
import type { FullTextResult } from '../fullText';
import type { SummaryResult } from '../summary';
import {
  type AdminFeedSampleItem,
  type AdminFeedStatus,
  type AdminFeedSubscriber,
  type AdminUserFeed,
  type FulltextDownloadStatus,
  type AllowlistEntry,
  type Capabilities,
  type DataSource,
  type FeedProbeResult,
  type ItemSort,
  type DiscoveredFeed,
  type FeedListOptions,
  type Page,
  type RegisteredUser,
} from './DataSource';
import {
  SEED_FEEDS,
  SEED_FOLDERS,
  SEED_ITEMS,
  SEED_SUBSCRIPTIONS,
} from './seed';

export const PAGE_SIZE = 30;

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** One recorded full-text download attempt, mirroring an `item_fulltext_status`
 * row (the shape `/admin/feeds` reads). */
interface FulltextStatusEntry {
  status: FulltextDownloadStatus;
  httpStatus: number | null;
  error: string | null;
  robotsRule: string | null;
  attemptedAt: string;
}

/**
 * In-memory, localStorage-backed implementation of {@link DataSource} for
 * PR1. Seeded with sample feeds/items so the entire UX runs offline. Feed
 * reads apply the spec's feed rules: muted feeds excluded from aggregate
 * views, Done/Hidden filtered out, and Pinned items prepended to the top
 * (oldest-pinned first, rendered once). Item state is delegated to a shared
 * {@link ItemStateStore} so optimistic toggles never wait on a refetch.
 */
export class MockDataSource implements DataSource {
  readonly stateStore: ItemStateStore;

  private feeds = new Map<FeedId, Feed>();
  private items: Item[] = [];
  private subs = new Map<FeedId, Subscription>();
  private folders: Folder[] = [];
  private seq = 100;
  /** In-memory trusted-user allowlist so the FAMILY chip and /admin are
   * demoable with no backend. The demo user is the operator (admin) and is
   * seeded onto the list, so they see the chip until they remove themselves in
   * /admin. Tests override getCapabilities() to exercise the off-list paths. */
  private readonly selfEmail = 'demo@readmo.app';
  private allowlist = new Set<string>([this.selfEmail]);
  /** In-memory AI-summary cache, mirroring the shared `items.ai_summary` column
   * (one generation serves every later pin of the same item). */
  private summaries = new Map<ItemId, string>();
  /** In-memory record of the last full-text download attempt per item, mirroring
   * the server's `item_fulltext_status` table (written by the fulltext function).
   * Powers `/admin/feeds`; `fetchFullText` records a success, and tests inject
   * failures via {@link recordFulltextStatus}. */
  private fulltextStatus = new Map<ItemId, FulltextStatusEntry>();
  /** Feeds paused from /admin/feeds — the poller/refresh skip them. */
  private pausedFeeds = new Set<FeedId>();
  /** Global "allow new sign-ups" switch (mock-only; defaults open). */
  private signupsEnabled = true;
  private readonly homeWindowMs: number;
  private readonly feedFloor: number;

  constructor(
    stateKey = 'readmo:item-state',
    opts: { homeWindowMs?: number; feedFloor?: number } = {},
  ) {
    this.homeWindowMs = opts.homeWindowMs ?? HOME_WINDOW_MS;
    this.feedFloor = opts.feedFloor ?? FEED_FLOOR;
    this.stateStore = new ItemStateStore(localStoragePersistence(stateKey));
    for (const f of SEED_FEEDS) this.feeds.set(f.id, { ...f });
    this.items = SEED_ITEMS.map((it) => ({ ...it }));
    for (const s of SEED_SUBSCRIPTIONS) this.subs.set(s.feedId, { ...s });
    this.folders = SEED_FOLDERS.map((f) => ({ ...f }));
  }

  // --- helpers --------------------------------------------------------------

  private toFeedItem(item: Item): FeedItem | null {
    const feed = this.feeds.get(item.feedId);
    if (!feed) return null;
    const sub = this.subs.get(item.feedId);
    const title = sub?.titleOverride ?? feed.title;
    // Return a snapshot copy of the item, mirroring the real backend (which maps
    // a fresh object per read). Without this, a later in-place mutation — e.g.
    // fetchFullText caching `fullContentHtml` on the stored item — would also
    // mutate a FeedItem already handed to the cache, making a background
    // full-text fetch appear to "auto-swap" the open reader mid-session.
    return { item: { ...item }, feed: title !== feed.title ? { ...feed, title } : feed };
  }

  /** Build the ordered list for a feed view, with Done/Hidden filtered out and
   * the feed freshness window + per-feed floor applied.
   *
   * An item is served if it's **pinned**, OR younger than `homeWindowMs`
   * (3 days), OR among its feed's newest `feedFloor` (10) items *by date,
   * irrespective of read/done state* (Done/Hidden are then filtered from the
   * body, but they still occupy their recency slot — so dismissing a recent
   * item does NOT pull an older one up to refill the floor).
   * The floor keeps an infrequently-updated feed from going blank when nothing
   * it published is recent; the window keeps a busy feed decluttered. Pinned
   * items are always served regardless of age (SPEC.md *Feed freshness window*).
   * This mirrors the server `feed_items` RPC (window + `row_number()` floor in
   * the body branch; the pinned branch is exempt).
   *
   * The body order follows `opts.sort` (newest- or oldest-first by publish
   * date). Pinned items are always rendered once, oldest-pinned first.
   *
   * Where the pinned items sit depends on grouping:
   *   - **Flat** (default): a single pinned section at the very top of the
   *     whole list, then the body.
   *   - **Grouped by feed**: the body is sectioned by feed in the user's custom
   *     subscription order (drag-to-reorder, the `sort` field), and each feed's
   *     pinned items sit at the **top of that feed's section** — not lifted out
   *     to a global top section. So every section is self-contained
   *     (pinned-first, then the body in the chosen order). */
  private orderedFor(
    predicate: (item: Item) => boolean,
    opts?: FeedListOptions,
  ): FeedItem[] {
    const now = Date.now();
    const freshAfter = now - this.homeWindowMs;
    const sortAsc = opts?.sort === 'oldest';
    const groupByFeed = opts?.groupByFeed ?? false;

    // First pass: rank EVERY item within its feed by publish date (newest =
    // rank 0) for the per-feed floor, then collect the non-dismissed ones as
    // body candidates. Ranking over the whole feed — not just non-dismissed
    // items — is what makes the floor "the feed's newest `feedFloor` by date":
    // a Done/Hidden item still consumes its recency slot, so dismissing a recent
    // item can't pull an older one up to refill the floor.
    const candidates: Array<{ item: Item; st: ItemState }> = [];
    const byFeed = new Map<FeedId, Item[]>();
    for (const item of this.items) {
      if (!predicate(item)) continue;
      const arr = byFeed.get(item.feedId);
      if (arr) arr.push(item);
      else byFeed.set(item.feedId, [item]);
      const st = this.stateStore.get(item.id, now);
      // Dismissed rows are never served in the body — EXCEPT a pin, which stays
      // regardless of Done/Hidden (mirrors feed_items' pinned branch and the
      // SupabaseDataSource overlay; the pin wins, matching the display).
      if (!st.pinned && (st.done || st.hidden)) continue;
      candidates.push({ item, st });
    }
    const feedRank = new Map<ItemId, number>();
    for (const arr of byFeed.values()) {
      arr.sort((a, b) => b.publishedAt - a.publishedAt);
      arr.forEach((it, i) => feedRank.set(it.id, i));
    }

    const rows: Array<{ fi: FeedItem; pinned: boolean; pinAt: number }> = [];
    for (const { item, st } of candidates) {
      // Window ∪ floor ∪ pinned: serve recent items, each feed's newest
      // `feedFloor`, and any pinned item regardless of age. Mirrors feed_items.
      const served =
        st.pinned ||
        item.publishedAt >= freshAfter ||
        (feedRank.get(item.id) ?? Number.POSITIVE_INFINITY) < this.feedFloor;
      if (!served) continue;
      const fi = this.toFeedItem(item);
      if (fi) rows.push({ fi, pinned: !!st.pinned, pinAt: st.pinnedAt ?? 0 });
    }

    const byDate = (a: FeedItem, b: FeedItem) => {
      const d = sortAsc
        ? a.item.publishedAt - b.item.publishedAt
        : b.item.publishedAt - a.item.publishedAt;
      if (d !== 0) return d;
      // Break ties by id descending, mirroring feed_items' `ORDER BY … (i).id
      // desc` (supabase migration 0021), so equal-`publishedAt` rows have a
      // stable, server-matching order rather than falling back to seed/insert
      // order.
      return a.item.id < b.item.id ? 1 : a.item.id > b.item.id ? -1 : 0;
    };
    const feedOrder = (feedId: FeedId) =>
      this.subs.get(feedId)?.sort ?? Number.POSITIVE_INFINITY;

    rows.sort((a, b) => {
      // Grouped: feed section (custom order) is the primary key, so pinned items
      // stay inside their feed rather than floating to a global top section.
      if (groupByFeed) {
        const oa = feedOrder(a.fi.item.feedId);
        const ob = feedOrder(b.fi.item.feedId);
        if (oa !== ob) return oa - ob;
        // Tie on the custom sort ordinal (possible after unsubscribe+subscribe
        // reuses an index): keep each feed's rows contiguous by id so a section
        // never splits into interleaved runs. Mirrors feed_items' ORDER BY.
        if (a.fi.item.feedId !== b.fi.item.feedId) {
          return a.fi.item.feedId < b.fi.item.feedId ? -1 : 1;
        }
      }
      // Within a section (a feed when grouped, the whole list when flat): pinned
      // first, oldest-pinned first; then the body in the chosen date order.
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned) return a.pinAt - b.pinAt;
      return byDate(a.fi, b.fi);
    });

    // No per-feed cap: like the live `feed_items` read, a grouped section
    // carries the feed's whole listable set — the "server" (here, the mock)
    // decides what to return and the client accepts all of it. The view
    // windows each section for display and its "More" reveals already-fetched
    // rows.
    return rows.map((r) => r.fi);
  }

  private paginate(all: FeedItem[], opts?: FeedListOptions): Page<FeedItem> {
    // Grouped: one deep page carrying every section in full, mirroring the
    // live source's single GROUPED_WINDOW_ROW_CAP-sized read (mock data is far
    // smaller than any real row cap, so there's never a next cursor). An
    // explicit `limit` still pages below — it models the row-cap-overflow
    // case (the cap splitting the read across pages), which tests exercise
    // with small limits.
    if (opts?.groupByFeed && opts?.limit == null) {
      return { items: all, nextCursor: null };
    }
    const limit = opts?.limit ?? PAGE_SIZE;
    const offset = decodeCursor(opts?.cursor);
    const slice = all.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    return {
      items: slice,
      nextCursor: nextOffset < all.length ? String(nextOffset) : null,
    };
  }

  private subscribedFeedIds(opts: { excludeMuted: boolean }): Set<FeedId> {
    const ids = new Set<FeedId>();
    for (const sub of this.subs.values()) {
      if (opts.excludeMuted && sub.muted) continue;
      ids.add(sub.feedId);
    }
    return ids;
  }

  // --- feed reads -----------------------------------------------------------

  async getHomeItems(opts?: FeedListOptions): Promise<Page<FeedItem>> {
    const feedIds = this.subscribedFeedIds({ excludeMuted: true });
    return this.paginate(
      this.orderedFor((it) => feedIds.has(it.feedId), opts),
      opts,
    );
  }

  async getFolderItems(
    name: string,
    opts?: FeedListOptions,
  ): Promise<Page<FeedItem>> {
    const feedIds = new Set<FeedId>();
    for (const sub of this.subs.values()) {
      if (sub.muted) continue;
      if (sub.folder === name) feedIds.add(sub.feedId);
    }
    return this.paginate(
      this.orderedFor((it) => feedIds.has(it.feedId), opts),
      opts,
    );
  }

  async getFeedItems(
    feedId: FeedId,
    opts?: FeedListOptions,
  ): Promise<Page<FeedItem>> {
    // Single-feed view includes a muted feed's own items. Grouping by feed is a
    // no-op here (one feed), but sort order still applies.
    return this.paginate(
      this.orderedFor((it) => it.feedId === feedId, opts),
      opts,
    );
  }

  async getFeedUnreadCounts(
    feedIds: FeedId[],
  ): Promise<Record<FeedId, number>> {
    const now = Date.now();
    const freshAfter = now - this.homeWindowMs;
    const want = new Set(feedIds);

    // Bucket EVERY wanted-feed item (not just non-dismissed) so the per-feed
    // floor ranks over the feed's whole recency order — the floor is its newest
    // `feedFloor` items by date, irrespective of state, so a dismissed recent
    // item still consumes its slot and can't be backfilled by an older one.
    const byFeed = new Map<FeedId, Array<{ item: Item; st: ItemState }>>();
    for (const item of this.items) {
      if (!want.has(item.feedId)) continue;
      const st = this.stateStore.get(item.id, now);
      const arr = byFeed.get(item.feedId);
      if (arr) arr.push({ item, st });
      else byFeed.set(item.feedId, [{ item, st }]);
    }

    const counts: Record<FeedId, number> = {};
    for (const id of feedIds) counts[id] = 0;
    for (const [feedId, arr] of byFeed) {
      // Newest-first so the per-feed floor keeps a sparse feed's latest items.
      arr.sort((a, b) => b.item.publishedAt - a.item.publishedAt);
      let n = 0;
      arr.forEach(({ item, st }, rank) => {
        // Listable = window ∪ floor ∪ pinned (mirrors orderedFor / feed_items).
        const listable =
          st.pinned || item.publishedAt >= freshAfter || rank < this.feedFloor;
        if (!listable) return;
        // Among listable items, count the unread/to-do ones: not Done or active
        // Hidden, and either pinned OR not Opened — a pinned item always counts
        // (a pin is a to-do, read or not); others drop out once Opened.
        if (!st.pinned && (st.done || st.hidden)) return; // a pin always counts
        if (st.pinned || !st.opened) n += 1;
      });
      counts[feedId] = n;
    }
    return counts;
  }

  /** No outbox: the mock's store is authoritative, so `getFeedUnreadCounts`
   * never lags a local write and there's nothing pending to discount. */
  pendingItemIds(): ReadonlySet<ItemId> {
    return new Set();
  }

  async getItem(id: ItemId): Promise<FeedItem | null> {
    const item = this.items.find((it) => it.id === id);
    return item ? this.toFeedItem(item) : null;
  }

  async getItemsByIds(ids: ItemId[]): Promise<FeedItem[]> {
    const order = new Map(ids.map((id, i) => [id, i]));
    return this.items
      .filter((it) => order.has(it.id))
      .map((it) => this.toFeedItem(it))
      .filter((fi): fi is FeedItem => fi !== null)
      .sort((a, b) => (order.get(a.item.id)! - order.get(b.item.id)!));
  }

  async fetchFullText(id: ItemId): Promise<FullTextResult> {
    const item = this.items.find((it) => it.id === id);
    if (!item) return { status: 'unreachable', contentHtml: null };
    // Cache hit — return the already-"extracted" body.
    if (item.fullContentHtml) {
      return { status: 'ok', contentHtml: item.fullContentHtml };
    }
    // Paused feed → decline a NEW download (mirrors the fulltext Edge Function).
    // Cache hits above still serve; this only blocks fresh extraction. `retryable`
    // so the reader re-checks after Unpause instead of caching the stub as
    // terminal (fullTextStaleTime only retries unreachable/retryable results).
    if (this.pausedFeeds.has(item.feedId)) {
      return { status: 'empty', contentHtml: null, retryable: true };
    }
    // Simulate server-side extraction: expand the feed stub into a fuller body
    // and cache it on the (shared) item, mirroring how the real source persists
    // the extracted HTML so a second open is served from cache.
    const full =
      `${item.contentHtml}` +
      `<p>This is the full article text, fetched in reading mode because the ` +
      `feed only carried a short excerpt. It continues well past what the feed ` +
      `provided, with the complete body of “${item.title}”.</p>`;
    item.fullContentHtml = full;
    this.fulltextStatus.set(id, {
      status: 'ok',
      httpStatus: 200,
      error: null,
      robotsRule: null,
      attemptedAt: new Date().toISOString(),
    });
    return { status: 'ok', contentHtml: full };
  }

  /** Test/demo seam: record a full-text download outcome for an item, mirroring
   * what the `fulltext` Edge Function writes to `item_fulltext_status`. Lets a
   * test set a failed download (403 / unreachable / robots-empty) so the
   * `/admin/feeds` statuses are exercisable without a real fetch. */
  recordFulltextStatus(
    id: ItemId,
    entry: {
      status: FulltextDownloadStatus;
      httpStatus?: number | null;
      error?: string | null;
      robotsRule?: string | null;
      attemptedAt?: string;
    },
  ): void {
    this.fulltextStatus.set(id, {
      status: entry.status,
      httpStatus: entry.httpStatus ?? null,
      error: entry.error ?? null,
      robotsRule: entry.robotsRule ?? null,
      attemptedAt: entry.attemptedAt ?? new Date().toISOString(),
    });
  }

  async getSummary(id: ItemId): Promise<SummaryResult> {
    const item = this.items.find((it) => it.id === id);
    if (!item) return { status: 'unreachable', summary: null };
    // Mirror the server allowlist gate: when armed and the demo user isn't on
    // the list, no summary (silent, retryable). Empty/disarmed → open to all.
    if (this.allowlist.size > 0 && !this.allowlist.has(this.selfEmail)) {
      return { status: 'empty', summary: null, retryable: true };
    }
    // Cache hit — one generation serves every later pin of the same item.
    const cached = this.summaries.get(id);
    if (cached) return { status: 'ok', summary: cached };
    // Paused feed → decline generation (mirrors the summary Edge Function).
    if (this.pausedFeeds.has(item.feedId)) {
      return { status: 'empty', summary: null, retryable: true };
    }
    // Simulate generation with a deterministic one-sentence gist of the title.
    const summary = `${item.title.replace(/[.?!]+$/, '')} — the key takeaway in one sentence.`;
    this.summaries.set(id, summary);
    return { status: 'ok', summary };
  }

  async search(query: string): Promise<FeedItem[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.items
      .filter((it) => {
        // Match the feed title the user actually sees — the subscription's
        // rename when set (SupabaseDataSource searches the overridden title
        // too, because ensureFeeds applies title_override before matching).
        const feed = this.feeds.get(it.feedId);
        const feedTitle = this.subs.get(it.feedId)?.titleOverride ?? feed?.title ?? '';
        return it.title.toLowerCase().includes(q) || feedTitle.toLowerCase().includes(q);
      })
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .map((it) => this.toFeedItem(it))
      .filter((fi): fi is FeedItem => fi !== null);
  }

  // --- subscriptions --------------------------------------------------------

  async getSubscriptions(): Promise<
    Array<{ subscription: Subscription; feed: Feed }>
  > {
    const out: Array<{ subscription: Subscription; feed: Feed }> = [];
    for (const sub of this.subs.values()) {
      const feed = this.feeds.get(sub.feedId);
      if (feed) out.push({ subscription: { ...sub }, feed: { ...feed } });
    }
    return out.sort((a, b) => a.subscription.sort - b.subscription.sort);
  }

  async reorderSubscriptions(orderedFeedIds: FeedId[]): Promise<void> {
    // Reassign `sort` to match the given order. Any subscription not named in
    // the list keeps its relative position after the listed ones (defensive —
    // the caller passes the full set, but a concurrent subscribe shouldn't lose
    // its row). Indices stay dense so the next reorder is well-defined.
    const ranked = new Map(orderedFeedIds.map((id, i) => [id, i]));
    const remaining = [...this.subs.values()]
      .filter((s) => !ranked.has(s.feedId))
      .sort((a, b) => a.sort - b.sort);
    let next = orderedFeedIds.length;
    for (const id of orderedFeedIds) {
      const sub = this.subs.get(id);
      if (sub) sub.sort = ranked.get(id)!;
    }
    for (const sub of remaining) sub.sort = next++;
  }

  async getFolders(): Promise<Folder[]> {
    return this.folders.map((f) => ({ ...f }));
  }

  async getFeed(feedId: FeedId): Promise<Feed | null> {
    const feed = this.feeds.get(feedId);
    if (!feed) return null;
    const sub = this.subs.get(feedId);
    const title = sub?.titleOverride ?? feed.title;
    return { ...feed, title };
  }

  async discover(url: string): Promise<DiscoveredFeed[]> {
    const clean = url.trim();
    if (!clean) return [];
    // Mock discovery: synthesize one plausible candidate from the input.
    let host = clean;
    try {
      host = new URL(clean.includes('://') ? clean : `https://${clean}`).host;
    } catch {
      // leave as-is
    }
    return [
      {
        url: clean.includes('://') ? clean : `https://${clean}/feed`,
        title: host,
        siteUrl: `https://${host}`,
        sampleTitles: [
          'A recent post from this site',
          'Another recent post',
          'One more headline',
        ],
      },
    ];
  }

  async subscribe(feedUrl: string, folder: string | null = null): Promise<Feed> {
    const existing = [...this.feeds.values()].find((f) => f.url === feedUrl);
    if (existing) {
      if (!this.subs.has(existing.id)) {
        this.subs.set(existing.id, {
          feedId: existing.id,
          folder,
          titleOverride: null,
          muted: false,
          openOriginal: false,
          openNewshacker: false,
          markDoneOnOpen: false,
          listLayout: null,
          sort: this.subs.size,
        });
      }
      return { ...existing };
    }
    let host = feedUrl;
    try {
      host = new URL(feedUrl).host;
    } catch {
      // leave as-is
    }
    const feed: Feed = {
      id: `feed-${this.seq++}`,
      url: feedUrl,
      siteUrl: `https://${host}`,
      title: host,
      faviconUrl: null,
      errorCount: 0,
      lastError: null,
      parked: false,
    };
    this.feeds.set(feed.id, feed);
    this.subs.set(feed.id, {
      feedId: feed.id,
      folder,
      titleOverride: null,
      muted: false,
      openOriginal: false,
      openNewshacker: false,
      markDoneOnOpen: false,
      listLayout: null,
      sort: this.subs.size,
    });
    return { ...feed };
  }

  async unsubscribe(feedId: FeedId): Promise<void> {
    this.subs.delete(feedId);
  }

  async setMuted(feedId: FeedId, muted: boolean): Promise<void> {
    const sub = this.subs.get(feedId);
    if (sub) sub.muted = muted;
  }

  async setOpenOriginal(feedId: FeedId, openOriginal: boolean): Promise<void> {
    const sub = this.subs.get(feedId);
    if (sub) sub.openOriginal = openOriginal;
  }

  async setOpenMode(feedId: FeedId, mode: OpenMode): Promise<void> {
    const sub = this.subs.get(feedId);
    if (sub) {
      // Atomic in-memory equivalent: set both booleans together so they're never
      // transiently both true.
      sub.openOriginal = mode === 'original';
      sub.openNewshacker = mode === 'newshacker';
    }
  }

  async setMarkDoneOnOpen(feedId: FeedId, markDoneOnOpen: boolean): Promise<void> {
    const sub = this.subs.get(feedId);
    if (sub) sub.markDoneOnOpen = markDoneOnOpen;
  }

  async setSubscriptionListLayout(
    feedId: FeedId,
    listLayout: ListLayout | null,
  ): Promise<void> {
    const sub = this.subs.get(feedId);
    if (sub) sub.listLayout = listLayout;
  }

  async setTitleOverride(feedId: FeedId, title: string | null): Promise<void> {
    const sub = this.subs.get(feedId);
    if (sub) sub.titleOverride = title;
  }

  async refresh(feedId?: FeedId): Promise<void> {
    // The real source triggers a server-side fetch; the mock simulates a
    // successful poll of the named feed (clears the error / circuit breaker,
    // like a 2xx or 304), so an admin "Fetch now" has a visible effect. Refresh
    // of all feeds (no id) stays a no-op.
    if (!feedId) return;
    // Paused feeds are skipped server-side, so the mock no-ops too.
    if (this.pausedFeeds.has(feedId)) return;
    const feed = this.feeds.get(feedId);
    if (feed) {
      feed.errorCount = 0;
      feed.lastError = null;
      feed.parked = false;
    }
  }

  async retryParkedFeed(feedId: FeedId): Promise<void> {
    const feed = this.feeds.get(feedId);
    if (feed) {
      feed.parked = false;
      feed.errorCount = 0;
      feed.lastError = null;
    }
  }

  /** `/debug` feed-read probe: the mock has no raw transport layer, so raw is
   * null and the counts come straight from the same reads the views use. */
  async debugFeedProbe(
    sort: ItemSort = 'newest',
    folder: string | null = null,
  ): Promise<FeedProbeResult> {
    const t0 = Date.now();
    const opts = {
      sort,
      groupByFeed: true,
    };
    const grouped =
      folder != null
        ? await this.getFolderItems(folder, opts)
        : await this.getHomeItems(opts);
    const per = new Map<string, number>();
    for (const fi of grouped.items) {
      per.set(fi.feed.title, (per.get(fi.feed.title) ?? 0) + 1);
    }
    const flat =
      folder != null
        ? await this.getFolderItems(folder, { sort })
        : await this.getHomeItems({ sort });
    return {
      groupedMs: Date.now() - t0,
      groupedRawRows: null,
      groupedResolvedRows: grouped.items.length,
      perFeed: [...per].map(([title, n]) => ({ title, rows: n })),
      flatResolvedRows: flat.items.length,
    };
  }

  async resyncState(): Promise<void> {
    // No server to reconcile against — the in-memory store (mirrored to
    // localStorage) is the source of truth here. Cross-device sync is a
    // SupabaseDataSource concern; in the mock this is a no-op.
  }

  // --- newshacker dismissal mirror ------------------------------------------
  // In-memory: enough for dev + Settings + tests to exercise the connect flow.
  // The actual mirror POST is a SupabaseDataSource/Edge-Function concern.
  private newshackerToken: string | null = null;

  async getNewshackerLink(): Promise<{ linked: boolean; supported: boolean }> {
    return { linked: this.newshackerToken != null, supported: true };
  }

  async setNewshackerToken(token: string): Promise<void> {
    if (!/^nht_[A-Za-z0-9_-]{16,}$/.test(token.trim())) {
      throw new Error('a valid newshacker token is required');
    }
    this.newshackerToken = token.trim();
  }

  async clearNewshackerLink(): Promise<void> {
    this.newshackerToken = null;
  }

  async syncNewshackerState(): Promise<void> {
    // No newshacker to reach from the mock — no-op.
  }

  async pullNewshackerDone(): Promise<{ linked: boolean; applied: number }> {
    // No newshacker to reach from the mock — report the link state, apply nothing.
    return { linked: this.newshackerToken != null, applied: 0 };
  }

  // --- OPML -----------------------------------------------------------------

  async importOpml(xml: string): Promise<{ added: number; skipped: number }> {
    // Mirror SupabaseDataSource: attribute values are XML-escaped, so decode
    // entities before matching/subscribing (or a URL with `&` re-subscribes as
    // a duplicate feed under its escaped form), and "skipped" means the caller
    // is already SUBSCRIBED — a known feed the user unsubscribed from is
    // re-added, not skipped (subscribe() resubscribes an existing feed).
    const urls = [...xml.matchAll(/xmlUrl="([^"]+)"/g)].map((m) => decodeXmlEntities(m[1]));
    let added = 0;
    let skipped = 0;
    for (const url of urls) {
      const existing = [...this.feeds.values()].find((f) => f.url === url);
      if (existing && this.subs.has(existing.id)) {
        skipped++;
        continue;
      }
      await this.subscribe(url);
      added++;
    }
    return { added, skipped };
  }

  async exportOpml(): Promise<string> {
    const outlines = [...this.subs.values()].flatMap((sub) => {
      const feed = this.feeds.get(sub.feedId);
      if (!feed) return [];
      return [{ title: sub.titleOverride ?? feed.title, xmlUrl: feed.url, htmlUrl: feed.siteUrl }];
    });
    return buildOpml(outlines, { dateCreated: new Date() });
  }

  // --- Capabilities & admin (in-memory) -------------------------------------

  async getCapabilities(): Promise<Capabilities> {
    const armed = this.allowlist.size > 0;
    return {
      family: armed && this.allowlist.has(this.selfEmail),
      admin: true, // the demo user is the operator in mock/dev
      allowlistArmed: armed,
      canManageUsers: true, // the mock backend has the 0030 RPCs
      canViewSubscriptions: true, // …and the 0047 subscription-view RPCs
    };
  }

  async listAllowlist(): Promise<AllowlistEntry[]> {
    return [...this.allowlist].map((email) => ({
      email,
      addedBy: this.selfEmail,
      createdAt: '2024-01-01T00:00:00.000Z',
    }));
  }

  async addToAllowlist(email: string): Promise<void> {
    this.allowlist.add(email.trim().toLowerCase());
  }

  async removeFromAllowlist(email: string): Promise<void> {
    this.allowlist.delete(email.trim().toLowerCase());
  }

  /** A few registered accounts (distinct signup dates so the sort options are
   * demoable) so the /admin user list + promote/demote + block/delete are
   * testable. Mutable: deleteUser removes a row, setUserBlocked flips `blocked`.
   * `family` is derived from current allowlist membership at read time, so a
   * promote/demote shows up on the next refetch. */
  private registeredUsers: Array<{
    email: string;
    createdAt: string;
    lastSignInAt: string | null;
    blocked: boolean;
  }> = [
    { email: this.selfEmail, createdAt: '2024-01-01T00:00:00.000Z', lastSignInAt: '2024-06-01T00:00:00.000Z', blocked: false },
    { email: 'alex@example.com', createdAt: '2024-03-15T00:00:00.000Z', lastSignInAt: '2024-05-20T00:00:00.000Z', blocked: false },
    { email: 'sam@example.com', createdAt: '2024-02-10T00:00:00.000Z', lastSignInAt: null, blocked: false },
  ];

  async listFeedStatuses(): Promise<AdminFeedStatus[]> {
    // Sample = the item in each feed with the most recent recorded reading-mode
    // attempt (mirrors admin_list_feeds taking the latest item_fulltext_status
    // row per feed). `fetchFullText` records 'ok'; `recordFulltextStatus`
    // injects other outcomes. No pin/allowlist logic — a recorded attempt only
    // exists for an allowlisted fetch.
    const itemsById = new Map(this.items.map((it) => [it.id, it] as const));
    const latestByFeed = new Map<
      FeedId,
      { item: Item; entry: FulltextStatusEntry }
    >();
    for (const [itemId, entry] of this.fulltextStatus) {
      const item = itemsById.get(itemId);
      if (!item) continue;
      const cur = latestByFeed.get(item.feedId);
      // ISO timestamps compare chronologically as strings.
      if (!cur || entry.attemptedAt > cur.entry.attemptedAt) {
        latestByFeed.set(item.feedId, { item, entry });
      }
    }
    const statuses: AdminFeedStatus[] = [];
    for (const feed of this.feeds.values()) {
      const latest = latestByFeed.get(feed.id);
      const sample: AdminFeedSampleItem | null = latest
        ? {
            id: latest.item.id,
            title: latest.item.title,
            hasFullContent: Boolean(latest.item.fullContentHtml),
            downloadStatus: latest.entry.status,
            downloadHttpStatus: latest.entry.httpStatus,
            downloadError: latest.entry.error,
            downloadRobotsRule: latest.entry.robotsRule,
            downloadAttemptedAt: latest.entry.attemptedAt,
          }
        : null;
      statuses.push({
        id: feed.id,
        title: feed.title,
        siteUrl: feed.siteUrl,
        faviconUrl: feed.faviconUrl,
        lastFetchedAt: null,
        errorCount: feed.errorCount,
        lastError: feed.lastError,
        paused: this.pausedFeeds.has(feed.id),
        // The mock store is single-user, so this is 0 or 1 per feed.
        subscriberCount: this.subs.has(feed.id) ? 1 : 0,
        fetchFailed: feed.errorCount > 0,
        parked: feed.parked,
        sample,
      });
    }
    return statuses.sort((a, b) => a.title.localeCompare(b.title));
  }

  async deleteFeed(feedId: FeedId): Promise<void> {
    // Mirror the server cascade: drop the feed, its items, and the caller's
    // subscription (the mock is single-user). Prune per-item caches too.
    const removed = new Set(
      this.items.filter((it) => it.feedId === feedId).map((it) => it.id),
    );
    this.feeds.delete(feedId);
    this.items = this.items.filter((it) => it.feedId !== feedId);
    this.subs.delete(feedId);
    this.pausedFeeds.delete(feedId);
    for (const id of removed) {
      this.fulltextStatus.delete(id);
      this.summaries.delete(id);
    }
  }

  async setFeedPaused(feedId: FeedId, paused: boolean): Promise<void> {
    if (paused) this.pausedFeeds.add(feedId);
    else this.pausedFeeds.delete(feedId);
  }

  async listUsers(): Promise<RegisteredUser[]> {
    return this.registeredUsers.map((u) => ({
      email: u.email,
      createdAt: u.createdAt,
      lastSignInAt: u.lastSignInAt,
      blocked: u.blocked,
      family: this.allowlist.has(u.email),
      admin: u.email === this.selfEmail,
    }));
  }

  async deleteUser(email: string): Promise<void> {
    const target = email.trim().toLowerCase();
    if (target === this.selfEmail) {
      throw new Error("you can't delete your own account");
    }
    this.registeredUsers = this.registeredUsers.filter((u) => u.email !== target);
    this.allowlist.delete(target);
  }

  async setUserBlocked(email: string, blocked: boolean): Promise<void> {
    const target = email.trim().toLowerCase();
    if (target === this.selfEmail) {
      throw new Error("you can't block your own account");
    }
    const user = this.registeredUsers.find((u) => u.email === target);
    if (user) user.blocked = blocked;
  }

  async getSignupsEnabled(): Promise<boolean> {
    return this.signupsEnabled;
  }

  async setSignupsEnabled(enabled: boolean): Promise<void> {
    this.signupsEnabled = enabled;
  }

  /** The in-memory store is single-user (`this.subs` is the demo account), so
   * the admin cross-user drill-downs need a deterministic stand-in mapping to be
   * demoable: the demo user gets its real subscriptions; the other seed accounts
   * get fixed slices of the feed set. Keyed by lowercased email. */
  private mockFeedIdsForUser(email: string): FeedId[] {
    const target = email.trim().toLowerCase();
    const all = [...this.feeds.keys()];
    if (target === this.selfEmail) return [...this.subs.keys()];
    if (target === 'alex@example.com') return all.slice(0, 2);
    if (target === 'sam@example.com') return all.slice(0, 1);
    return [];
  }

  async listUserFeeds(email: string): Promise<AdminUserFeed[]> {
    const target = email.trim().toLowerCase();
    const subscribedAt =
      this.registeredUsers.find((u) => u.email === target)?.createdAt ??
      '2024-01-01T00:00:00.000Z';
    const rows: AdminUserFeed[] = [];
    for (const feedId of this.mockFeedIdsForUser(target)) {
      const feed = this.feeds.get(feedId);
      if (!feed) continue;
      const sub = target === this.selfEmail ? this.subs.get(feedId) : undefined;
      rows.push({
        feedId,
        title: sub?.titleOverride ?? feed.title,
        siteUrl: feed.siteUrl,
        muted: sub?.muted ?? false,
        folder: sub?.folder ?? null,
        subscribedAt,
      });
    }
    return rows.sort((a, b) => a.title.localeCompare(b.title));
  }

  async listFeedSubscribers(feedId: FeedId): Promise<AdminFeedSubscriber[]> {
    const rows: AdminFeedSubscriber[] = [];
    for (const u of this.registeredUsers) {
      if (!this.mockFeedIdsForUser(u.email).includes(feedId)) continue;
      const sub = u.email === this.selfEmail ? this.subs.get(feedId) : undefined;
      rows.push({
        email: u.email,
        family: this.allowlist.has(u.email),
        blocked: u.blocked,
        muted: sub?.muted ?? false,
        subscribedAt: u.createdAt,
      });
    }
    return rows.sort((a, b) => a.email.localeCompare(b.email));
  }
}

