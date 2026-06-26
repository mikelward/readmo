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
  type Subscription,
} from '../types';
import {
  ItemStateStore,
  localStoragePersistence,
} from './itemState';
import type { FullTextResult } from '../fullText';
import {
  type DataSource,
  type DiscoveredFeed,
  type FeedListOptions,
  type Page,
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
   * (3 days), OR among its feed's newest `feedFloor` (10) non-dismissed items.
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

    // First pass: gather the non-dismissed candidates and rank each within its
    // feed by publish date (newest = rank 0), so the per-feed floor can keep a
    // feed's newest `feedFloor` items even when they're older than the window.
    const candidates: Array<{ item: Item; st: ItemState }> = [];
    const byFeed = new Map<FeedId, Item[]>();
    for (const item of this.items) {
      if (!predicate(item)) continue;
      const st = this.stateStore.get(item.id, now);
      if (st.done || st.hidden) continue; // filtered from every feed
      candidates.push({ item, st });
      const arr = byFeed.get(item.feedId);
      if (arr) arr.push(item);
      else byFeed.set(item.feedId, [item]);
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

    const byDate = (a: FeedItem, b: FeedItem) =>
      sortAsc
        ? a.item.publishedAt - b.item.publishedAt
        : b.item.publishedAt - a.item.publishedAt;
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

    // Group-by-feed only: cap each feed's section to its newest `perFeedLimit`
    // rows (the sort above made each feed run contiguous, pinned-first). The
    // per-section "More" pages deeper into one feed via getFeedItems. Mirrors
    // the `feed_items` RPC's p_per_feed_limit window. A single-feed read (no
    // groupByFeed) is never capped — that's the path "More" pages through.
    const perFeedLimit = opts?.perFeedLimit;
    if (groupByFeed && perFeedLimit != null && perFeedLimit >= 0) {
      const seen = new Map<FeedId, number>();
      const capped: typeof rows = [];
      for (const r of rows) {
        const fid = r.fi.item.feedId;
        const n = seen.get(fid) ?? 0;
        if (n >= perFeedLimit) continue;
        seen.set(fid, n + 1);
        capped.push(r);
      }
      return capped.map((r) => r.fi);
    }

    return rows.map((r) => r.fi);
  }

  private paginate(all: FeedItem[], opts?: FeedListOptions): Page<FeedItem> {
    // Grouped + per-feed windowed: each section is already capped to its newest
    // `perFeedLimit` rows, so the whole (bounded) river is returned in one page.
    // The view pages deeper into a single feed via its own "More" (getFeedItems),
    // not by globally fetching the next page — so there's no global next cursor.
    if (opts?.groupByFeed && opts?.perFeedLimit != null) {
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

    // Gather each wanted feed's non-dismissed items (Done/active-Hidden drop
    // out, same as the list), bucketed by feed for the per-feed floor ranking.
    const byFeed = new Map<FeedId, Array<{ item: Item; st: ItemState }>>();
    for (const item of this.items) {
      if (!want.has(item.feedId)) continue;
      const st = this.stateStore.get(item.id, now);
      if (st.done || st.hidden) continue;
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
        // A pinned item always counts (a pin is a to-do, read or not); other
        // listable items drop out once Opened.
        const listable =
          st.pinned || item.publishedAt >= freshAfter || rank < this.feedFloor;
        if (listable && (st.pinned || !st.opened)) n += 1;
      });
      counts[feedId] = n;
    }
    return counts;
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
    // Simulate server-side extraction: expand the feed stub into a fuller body
    // and cache it on the (shared) item, mirroring how the real source persists
    // the extracted HTML so a second open is served from cache.
    const full =
      `${item.contentHtml}` +
      `<p>This is the full article text, fetched in reading mode because the ` +
      `feed only carried a short excerpt. It continues well past what the feed ` +
      `provided, with the complete body of “${item.title}”.</p>`;
    item.fullContentHtml = full;
    return { status: 'ok', contentHtml: full };
  }

  async search(query: string): Promise<FeedItem[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.items
      .filter((it) => {
        const feed = this.feeds.get(it.feedId);
        return (
          it.title.toLowerCase().includes(q) ||
          (feed?.title.toLowerCase().includes(q) ?? false)
        );
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

  async setTitleOverride(feedId: FeedId, title: string | null): Promise<void> {
    const sub = this.subs.get(feedId);
    if (sub) sub.titleOverride = title;
  }

  async refresh(): Promise<void> {
    // No-op in the mock; the real source triggers a server-side fetch.
  }

  async retryParkedFeed(feedId: FeedId): Promise<void> {
    const feed = this.feeds.get(feedId);
    if (feed) {
      feed.parked = false;
      feed.errorCount = 0;
      feed.lastError = null;
    }
  }

  // --- OPML -----------------------------------------------------------------

  async importOpml(xml: string): Promise<{ added: number; skipped: number }> {
    const urls = [...xml.matchAll(/xmlUrl="([^"]+)"/g)].map((m) => m[1]);
    let added = 0;
    let skipped = 0;
    for (const url of urls) {
      const exists = [...this.feeds.values()].some((f) => f.url === url);
      if (exists) {
        skipped++;
        continue;
      }
      await this.subscribe(url);
      added++;
    }
    return { added, skipped };
  }

  async exportOpml(): Promise<string> {
    const outlines = [...this.subs.values()]
      .map((sub) => {
        const feed = this.feeds.get(sub.feedId);
        if (!feed) return '';
        const title = sub.titleOverride ?? feed.title;
        return `    <outline type="rss" text="${escapeXml(title)}" title="${escapeXml(
          title,
        )}" xmlUrl="${escapeXml(feed.url)}"${
          feed.siteUrl ? ` htmlUrl="${escapeXml(feed.siteUrl)}"` : ''
        } />`;
      })
      .filter(Boolean)
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Readmo subscriptions</title></head>\n  <body>\n${outlines}\n  </body>\n</opml>\n`;
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
