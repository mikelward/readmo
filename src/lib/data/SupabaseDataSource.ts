import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type Feed,
  type FeedId,
  type FeedItem,
  type Folder,
  type ItemId,
  type ItemState,
  type Subscription,
} from '../types';
import { getSupabase } from '../supabase/client';
import { ItemStateStore, localStoragePersistence } from './itemState';
import {
  type DataSource,
  type DiscoveredFeed,
  type FeedListOptions,
  type Page,
} from './DataSource';
import { PAGE_SIZE } from './MockDataSource';
import {
  type FeedPublicRow,
  type ItemRow,
  type ItemStateRow,
  type SubscriptionRow,
  mapFeed,
  mapItem,
  mapItemState,
  mapSubscription,
} from './supabaseMappers';

/** The display-safe columns of `feeds_public` (and of `feeds` for clients —
 * never the fetch URLs). */
const FEED_COLS =
  'id, site_url, title, last_fetched_at, next_fetch_at, fetch_interval_s, error_count, last_error, created_at';
const ITEM_COLS =
  'id, feed_id, guid, url, title, author, published_at, content_html, summary, enclosures, content_hash, created_at';
const ITEM_STATE_COLS =
  'item_id, pinned, pinned_at, favorite, favorite_at, done, done_at, hidden, hidden_at, opened, opened_at, version';
const SUBSCRIPTION_COLS = 'feed_id, folder, title_override, muted, sort';

/** Cap on the body-exclusion id list (pinned/done/hidden) we push into a single
 * `not in (…)` filter. Beyond this the proper fix is a server-side feed RPC that
 * joins item_state; see the class note. */
const MAX_EXCLUDE_IDS = 500;

function notImplemented(method: string): never {
  throw new Error(
    `SupabaseDataSource.${method} is not implemented yet — the privileged ` +
      `write path (subscribe_to_feed / set_item_state RPCs + item_state sync) ` +
      `lands in the next item. Reads + auth are wired in this PR.`,
  );
}

function escapeLike(q: string): string {
  // Treat the user's query literally: escape the LIKE wildcards.
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Live {@link DataSource} backed by Supabase (Postgres + RLS + Edge Functions).
 * THIS PR ships the READ surface + real auth; reads are RLS-gated, so they only
 * ever return rows the signed-in user may see. Item *state* is hydrated from the
 * server once and mirrored in a shared {@link ItemStateStore} (same store the UI
 * already reads) so feed ordering — pinned-first, Done/Hidden filtered — matches
 * the mock.
 *
 * Deliberate seams left for the next item:
 *  - the privileged write path (`subscribe`, OPML import, parked-feed retry) goes
 *    through the `subscribe_to_feed` / `set_item_state` SECURITY DEFINER RPCs and
 *    throws `notImplemented` here for now;
 *  - item_state *mutations* still persist locally/optimistically (no RPC
 *    write-through or offline outbox yet);
 *  - the feed query excludes Pinned/Done/Hidden via an id list; a heavy archive
 *    should move that join server-side (see MAX_EXCLUDE_IDS).
 *
 * Pagination is offset-based behind an opaque numeric cursor (mirroring the
 * mock); it can move to keyset later without changing the interface. Pinned
 * items are prepended once on the first page, in addition to a full body page.
 */
export class SupabaseDataSource implements DataSource {
  readonly stateStore: ItemStateStore;

  private readonly sb: SupabaseClient;
  private readonly feedCache = new Map<FeedId, Feed>();
  private subsCache: Array<{ subscription: Subscription; feed: Feed }> | null =
    null;
  private hydration: Promise<void> | null = null;

  constructor(stateKey = 'readmo:item-state', client?: SupabaseClient) {
    this.sb = client ?? getSupabase();
    this.stateStore = new ItemStateStore(localStoragePersistence(stateKey));
  }

  // --- helpers --------------------------------------------------------------

  private unwrap<T>(res: { data: T | null; error: unknown }): T {
    if (res.error) {
      const msg =
        res.error instanceof Error
          ? res.error.message
          : typeof res.error === 'object' &&
              res.error &&
              'message' in res.error
            ? String((res.error as { message: unknown }).message)
            : String(res.error);
      throw new Error(msg);
    }
    return (res.data ?? ([] as unknown)) as T;
  }

  /** Fetch the caller's item_state rows once and overlay them onto the store so
   * `stateStore.get()` reflects server truth for ordering/filtering. */
  private ensureHydrated(): Promise<void> {
    if (!this.hydration) {
      this.hydration = (async () => {
        const rows = this.unwrap<ItemStateRow[]>(
          await this.sb.from('item_state').select(ITEM_STATE_COLS),
        );
        this.stateStore.hydrate(
          rows.map((r) => [r.item_id, mapItemState(r)] as [ItemId, ItemState]),
        );
      })();
    }
    return this.hydration;
  }

  private async ensureFeeds(ids: FeedId[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !this.feedCache.has(id));
    if (missing.length === 0) return;
    const rows = this.unwrap<FeedPublicRow[]>(
      await this.sb.from('feeds_public').select(FEED_COLS).in('id', missing),
    );
    for (const row of rows) this.feedCache.set(row.id, mapFeed(row));
  }

  /** Map item rows to FeedItems, loading any feeds not already cached. */
  private async resolveFeedItems(rows: ItemRow[]): Promise<FeedItem[]> {
    await this.ensureFeeds(rows.map((r) => r.feed_id));
    const out: FeedItem[] = [];
    for (const row of rows) {
      const feed = this.feedCache.get(row.feed_id);
      if (feed) out.push({ item: mapItem(row), feed });
    }
    return out;
  }

  private async loadSubscriptions(): Promise<
    Array<{ subscription: Subscription; feed: Feed }>
  > {
    if (this.subsCache) return this.subsCache;
    const subRows = this.unwrap<SubscriptionRow[]>(
      await this.sb.from('subscriptions').select(SUBSCRIPTION_COLS),
    );
    await this.ensureFeeds(subRows.map((s) => s.feed_id));
    const out: Array<{ subscription: Subscription; feed: Feed }> = [];
    for (const row of subRows) {
      const feed = this.feedCache.get(row.feed_id);
      if (feed) out.push({ subscription: mapSubscription(row), feed });
    }
    out.sort((a, b) => a.subscription.sort - b.subscription.sort);
    this.subsCache = out;
    return out;
  }

  /** Pinned (oldest-first) + the full set to exclude from feed bodies
   * (pinned ∪ done ∪ hidden), derived from the hydrated state store. */
  private partitionStateIds(): {
    pinnedOldestFirst: ItemId[];
    excludeFromBody: ItemId[];
  } {
    const pinned: Array<[ItemId, number]> = [];
    const exclude: ItemId[] = [];
    for (const [id, st] of this.stateStore.entries()) {
      if (st.pinned) {
        pinned.push([id, st.pinnedAt ?? 0]);
        exclude.push(id);
      } else if (st.done || st.hidden) {
        exclude.push(id);
      }
    }
    pinned.sort((a, b) => a[1] - b[1]);
    return { pinnedOldestFirst: pinned.map((p) => p[0]), excludeFromBody: exclude };
  }

  /** Shared feed-view read: pinned-first (page 1 only) over the given feed set,
   * body newest-first with Pinned/Done/Hidden excluded server-side. */
  private async feedView(
    feedIds: FeedId[],
    opts?: FeedListOptions,
  ): Promise<Page<FeedItem>> {
    if (feedIds.length === 0) {
      return { items: [], total: 0, nextCursor: null };
    }
    await this.ensureHydrated();

    const limit = opts?.limit ?? PAGE_SIZE;
    const offset = decodeCursor(opts?.cursor);
    const { pinnedOldestFirst, excludeFromBody } = this.partitionStateIds();

    // Body: newest-first, excluding pinned/done/hidden, offset-paginated.
    let query = this.sb
      .from('items')
      .select(ITEM_COLS, { count: 'exact' })
      .in('feed_id', feedIds);
    if (excludeFromBody.length > 0 && excludeFromBody.length <= MAX_EXCLUDE_IDS) {
      query = query.not('id', 'in', `(${excludeFromBody.join(',')})`);
    }
    query = query
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    const res = (await query) as {
      data: ItemRow[] | null;
      count: number | null;
      error: unknown;
    };
    const bodyRows = this.unwrap<ItemRow[]>(res);
    const bodyTotal = res.count ?? bodyRows.length;
    const body = await this.resolveFeedItems(bodyRows);

    // Pinned prepend (page 1 only), restricted to this feed set and rendered
    // once at the top, oldest-pinned first.
    let pinned: FeedItem[] = [];
    if (offset === 0 && pinnedOldestFirst.length > 0) {
      const pinnedRows = this.unwrap<ItemRow[]>(
        await this.sb
          .from('items')
          .select(ITEM_COLS)
          .in('id', pinnedOldestFirst)
          .in('feed_id', feedIds),
      );
      const byId = new Map(pinnedRows.map((r) => [r.id, r]));
      const ordered = pinnedOldestFirst
        .map((id) => byId.get(id))
        .filter((r): r is ItemRow => r !== undefined);
      pinned = await this.resolveFeedItems(ordered);
    }

    const nextOffset = offset + limit;
    return {
      items: [...pinned, ...body],
      total: bodyTotal + (offset === 0 ? pinned.length : 0),
      nextCursor: nextOffset < bodyTotal ? String(nextOffset) : null,
    };
  }

  // --- feed reads -----------------------------------------------------------

  async getHomeItems(opts?: FeedListOptions): Promise<Page<FeedItem>> {
    const subs = await this.loadSubscriptions();
    const feedIds = subs
      .filter((s) => !s.subscription.muted)
      .map((s) => s.subscription.feedId);
    return this.feedView(feedIds, opts);
  }

  async getFolderItems(
    name: string,
    opts?: FeedListOptions,
  ): Promise<Page<FeedItem>> {
    const subs = await this.loadSubscriptions();
    const feedIds = subs
      .filter((s) => !s.subscription.muted && s.subscription.folder === name)
      .map((s) => s.subscription.feedId);
    return this.feedView(feedIds, opts);
  }

  async getFeedItems(
    feedId: FeedId,
    opts?: FeedListOptions,
  ): Promise<Page<FeedItem>> {
    // Single-feed view includes a muted feed's own items.
    return this.feedView([feedId], opts);
  }

  async getItem(id: ItemId): Promise<FeedItem | null> {
    const row = this.unwrap<ItemRow | null>(
      await this.sb.from('items').select(ITEM_COLS).eq('id', id).maybeSingle(),
    );
    if (!row) return null;
    const [fi] = await this.resolveFeedItems([row]);
    return fi ?? null;
  }

  async getItemsByIds(ids: ItemId[]): Promise<FeedItem[]> {
    if (ids.length === 0) return [];
    const rows = this.unwrap<ItemRow[]>(
      await this.sb.from('items').select(ITEM_COLS).in('id', ids),
    );
    const order = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return this.resolveFeedItems(rows);
  }

  async search(query: string): Promise<FeedItem[]> {
    const q = query.trim();
    if (!q) return [];
    const pattern = `%${escapeLike(q.toLowerCase())}%`;

    // Item-title matches (RLS-scoped to the caller's visible items).
    const titleRows = this.unwrap<ItemRow[]>(
      await this.sb
        .from('items')
        .select(ITEM_COLS)
        .ilike('title', pattern)
        .order('published_at', { ascending: false, nullsFirst: false })
        .limit(50),
    );

    // Feed-title matches: include recent items from subscribed feeds whose title
    // matches (mirrors the mock's feed-title search). Full-text search is a
    // later refinement.
    const subs = await this.loadSubscriptions();
    const ql = q.toLowerCase();
    const feedIds = subs
      .filter((s) => s.feed.title.toLowerCase().includes(ql))
      .map((s) => s.feed.id);
    let feedRows: ItemRow[] = [];
    if (feedIds.length > 0) {
      feedRows = this.unwrap<ItemRow[]>(
        await this.sb
          .from('items')
          .select(ITEM_COLS)
          .in('feed_id', feedIds)
          .order('published_at', { ascending: false, nullsFirst: false })
          .limit(50),
      );
    }

    const byId = new Map<string, ItemRow>();
    for (const r of [...titleRows, ...feedRows]) byId.set(r.id, r);
    const merged = [...byId.values()].sort(
      (a, b) => (Date.parse(b.published_at ?? '') || 0) - (Date.parse(a.published_at ?? '') || 0),
    );
    return this.resolveFeedItems(merged);
  }

  // --- subscriptions --------------------------------------------------------

  async getSubscriptions(): Promise<
    Array<{ subscription: Subscription; feed: Feed }>
  > {
    return this.loadSubscriptions();
  }

  async getFolders(): Promise<Folder[]> {
    const rows = this.unwrap<Array<{ name: string; sort: number }>>(
      await this.sb.from('folders').select('name, sort').order('sort'),
    );
    return rows.map((r) => ({ name: r.name, sort: r.sort }));
  }

  async getFeed(feedId: FeedId): Promise<Feed | null> {
    const cached = this.feedCache.get(feedId);
    if (cached) return cached;
    const row = this.unwrap<FeedPublicRow | null>(
      await this.sb.from('feeds_public').select(FEED_COLS).eq('id', feedId).maybeSingle(),
    );
    if (!row) return null;
    const feed = mapFeed(row);
    this.feedCache.set(feed.id, feed);
    return feed;
  }

  async discover(url: string): Promise<DiscoveredFeed[]> {
    const clean = url.trim();
    if (!clean) return [];
    const { data, error } = await this.sb.functions.invoke('discover', {
      body: { url: clean },
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
    const candidates =
      (data as { candidates?: unknown })?.candidates ?? [];
    if (!Array.isArray(candidates)) return [];
    return candidates.map((c) => {
      const rec = c as {
        feedUrl?: string;
        title?: string | null;
        siteUrl?: string | null;
        sample?: Array<{ title?: string | null }>;
      };
      return {
        url: rec.feedUrl ?? '',
        title: rec.title ?? rec.feedUrl ?? '',
        siteUrl: rec.siteUrl ?? null,
        sampleTitles: (rec.sample ?? [])
          .map((s) => s.title ?? '')
          .filter((t) => t.length > 0),
      };
    });
  }

  async subscribe(_feedUrl: string, _folder?: string | null): Promise<Feed> {
    // → subscribe_to_feed RPC (authorizes by URL possession); next item.
    return notImplemented('subscribe');
  }

  async unsubscribe(feedId: FeedId): Promise<void> {
    // RLS scopes the delete to the caller's own (user_id, feed_id) row.
    const { error } = await this.sb
      .from('subscriptions')
      .delete()
      .eq('feed_id', feedId);
    if (error) throw error instanceof Error ? error : new Error(String(error));
    this.subsCache = null;
  }

  async setMuted(feedId: FeedId, muted: boolean): Promise<void> {
    const { error } = await this.sb
      .from('subscriptions')
      .update({ muted })
      .eq('feed_id', feedId);
    if (error) throw error instanceof Error ? error : new Error(String(error));
    this.subsCache = null;
  }

  async setTitleOverride(feedId: FeedId, title: string | null): Promise<void> {
    const { error } = await this.sb
      .from('subscriptions')
      .update({ title_override: title })
      .eq('feed_id', feedId);
    if (error) throw error instanceof Error ? error : new Error(String(error));
    this.subsCache = null;
  }

  async refresh(feedId?: FeedId): Promise<void> {
    const { error } = await this.sb.functions.invoke('refresh', {
      body: feedId ? { feedId } : {},
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
  }

  async retryParkedFeed(_feedId: FeedId): Promise<void> {
    // Server-side state reset (service role); wired with the write path.
    return notImplemented('retryParkedFeed');
  }

  // --- OPML -----------------------------------------------------------------

  async importOpml(_xml: string): Promise<{ added: number; skipped: number }> {
    // Each <outline> becomes a subscribe_to_feed call; next item.
    return notImplemented('importOpml');
  }

  async exportOpml(): Promise<string> {
    const subs = await this.loadSubscriptions();
    const outlines = subs
      .map(({ subscription, feed }) => {
        const title = subscription.titleOverride ?? feed.title;
        // `feed.url` is the display-safe site URL (feeds_public never exposes
        // the fetch URL), so exported OPML carries the public address only.
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
