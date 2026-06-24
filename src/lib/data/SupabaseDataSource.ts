import {
  type SupabaseClient,
  FunctionsHttpError,
} from '@supabase/supabase-js';
import {
  type Feed,
  type FeedId,
  type FeedItem,
  type Folder,
  type ItemId,
  type ItemState,
  type Subscription,
} from '../types';
import type { FullTextResult, FullTextStatus } from '../fullText';
import { getSupabase } from '../supabase/client';
import { OUTBOX_SUFFIX } from '../userCache';
import { ItemStateStore, localStoragePersistence } from './itemState';
import {
  ItemStateOutbox,
  localStorageOutboxPersistence,
} from './itemStateOutbox';
import {
  type DataSource,
  type DiscoveredFeed,
  type FeedListOptions,
  type Page,
  AddFeedError,
  type AddFeedErrorKind,
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
  isPermanentWriteError,
} from './supabaseMappers';

/** The display-safe columns of `feeds_public` (and of `feeds` for clients —
 * never the fetch URLs). */
const FEED_COLS =
  'id, site_url, title, last_fetched_at, next_fetch_at, fetch_interval_s, error_count, last_error, created_at';
const ITEM_COLS =
  'id, feed_id, guid, url, title, author, published_at, content_html, summary, enclosures, content_hash, created_at';
// The reader (getItem) additionally needs the cached full-article body. List /
// search / library reads deliberately OMIT it: those rows only need metadata +
// the feed snippet, and pulling every cached full article into a 50-result
// search or a large library bucket would bloat the payload and the persisted
// (user-scoped) React Query cache. Only the single-item detail read fetches it.
const ITEM_DETAIL_COLS = `${ITEM_COLS}, full_content_html, full_content_version`;
const ITEM_STATE_COLS =
  'item_id, pinned, pinned_at, favorite, favorite_at, done, done_at, hidden, hidden_at, opened, opened_at, version';
const SUBSCRIPTION_COLS = 'feed_id, folder, title_override, muted, sort';

/** Max ids per `in (…)` lookup, so a large library bucket (Done/Hidden/Favorite
 * with hundreds/thousands of ids) is fetched in bounded batches rather than one
 * unbounded request that could exceed the request-line/query limit. */
const ID_LOOKUP_CHUNK = 200;

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

/** Decode the XML entities OPML attribute values are escaped with (inverse of
 * escapeXml). `&amp;` is decoded last so `&amp;lt;` → `&lt;`, not `<`. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Split an array into bounded batches (keeps `in (…)` request URLs within
 * server/proxy request-line limits for large id lists). */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Classify an Edge Function invoke error (discover / refresh) into a typed
 * {@link AddFeedError} so the UI can show a specific message. The function
 * itself tags the upstream-fetch outcomes it can tell apart with a JSON
 * `{ error, code }` body; a missing/expired JWT is rejected by the platform
 * (verify_jwt) as a bare 401 *before* the function runs, which we read off the
 * HTTP status.
 */
async function classifyFunctionError(error: unknown): Promise<AddFeedError> {
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response | undefined;
    const status = res?.status;
    let code: string | undefined;
    let serverMsg: string | undefined;
    try {
      const body = (await res?.clone().json()) as
        | { error?: string; code?: string }
        | undefined;
      code = body?.code;
      serverMsg = body?.error;
    } catch {
      /* non-JSON body (e.g. the platform's bare 401) — fall back to status */
    }
    const byCode: Record<string, AddFeedErrorKind> = {
      auth: 'feed-auth',
      'not-found': 'not-found',
      unreachable: 'unreachable',
    };
    if (code && byCode[code]) return new AddFeedError(byCode[code], serverMsg);
    // Platform auth layer: the caller's JWT is missing/expired.
    if (status === 401 || status === 403)
      return new AddFeedError('signed-out', serverMsg);
    return new AddFeedError('unreachable', serverMsg ?? `HTTP ${status ?? '?'}`);
  }
  // FunctionsFetchError / FunctionsRelayError / anything else: we couldn't even
  // reach the function.
  const msg = error instanceof Error ? error.message : String(error);
  return new AddFeedError('unreachable', msg);
}

/**
 * Live {@link DataSource} backed by Supabase (Postgres + RLS + Edge Functions).
 * Reads are RLS-gated, so they only ever return rows the signed-in user may see.
 * Home/folder/feed reads go through the `feed_items` RPC; item state is hydrated
 * from the server into a shared {@link ItemStateStore} (the same store the UI
 * reads) and triage writes flow back through `set_item_state`. Subscribe / OPML
 * import / parked-feed retry use the `subscribe_to_feed` RPC and the `refresh`
 * Edge Function.
 *
 * Deferred to the offline/sync milestone (see SPEC *Sync*): the offline mutation
 * outbox + server-version reconciliation/rollback (item_state writes are
 * currently fire-and-forget optimistic), and an authenticated OPML *export* RPC
 * (the client can't emit server-only fetch URLs).
 *
 * Pagination is offset-based behind an opaque numeric cursor (mirroring the
 * mock); each page is the bounded slice of the combined pinned-then-body
 * sequence the `feed_items` RPC returns.
 */
export class SupabaseDataSource implements DataSource {
  readonly stateStore: ItemStateStore;

  private readonly sb: SupabaseClient;
  private readonly feedCache = new Map<FeedId, Feed>();
  private hydration: Promise<void> | null = null;
  private readonly outbox: ItemStateOutbox;

  constructor(stateKey = 'readmo:item-state', client?: SupabaseClient) {
    this.sb = client ?? getSupabase();
    this.stateStore = new ItemStateStore(localStoragePersistence(stateKey));

    // Durable write-through via the offline outbox: triage toggles apply to the
    // store optimistically (instant UI) and are queued here for delivery to the
    // set_item_state RPC (0004) — coalesced per item, serialized, retried on
    // reconnect, and surviving a reload/offline gap. A permanent server rejection
    // re-pulls server truth to correct the optimistic state.
    this.outbox = new ItemStateOutbox(
      async (id, changed, baseVersion) => {
        const params: Record<string, unknown> = { p_item_id: id };
        // Send only the changed fields (set_item_state leaves null params
        // untouched), so a stale mirror can't clobber a field changed elsewhere.
        for (const [f, v] of Object.entries(changed)) params[`p_${f}`] = v;
        // Optimistic-concurrency base: apply only if the row is still at this
        // version (0007). A conflict comes back as an error → permanent.
        if (baseVersion != null) params.p_base_version = baseVersion;
        const { data, error } = await this.sb.rpc('set_item_state', params);
        // Only a KNOWN-permanent error (version conflict / lost visibility) drops
        // the write; a 429/5xx hiccup (or a thrown/network error) stays queued
        // and retries, so a short outage can't roll back the user's action.
        const version = (data as ItemStateRow | null)?.version;
        return { ok: !error, permanent: isPermanentWriteError(error), version };
      },
      localStorageOutboxPersistence(`${stateKey}${OUTBOX_SUFFIX}`),
      () => {
        // Default to online unless the platform explicitly reports offline (some
        // runtimes expose `navigator` without a boolean `onLine`).
        const online = globalThis.navigator?.onLine;
        return typeof online === 'boolean' ? online : true;
      },
      () => {
        // Some writes were permanently rejected — drop our memoized hydration so
        // the next read re-pulls server truth and corrects the local store.
        this.hydration = null;
        void this.ensureHydrated();
      },
    );
    this.stateStore.setMutationSink((id, changed) => this.outbox.enqueue(id, changed));
    // Replay anything queued in a prior session now, and again when connectivity
    // returns.
    void this.outbox.flush();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => void this.outbox.flush());
    }

    // Kick off item_state hydration at boot so the library routes (/pinned,
    // /favorites, …), which derive their ids from the store, populate even when
    // no feed view has run yet. ensureHydrated is memoized; when the rows land
    // the store emits and those views refetch with real ids.
    void this.ensureHydrated().catch(() => {});
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
    // Preserve null: maybeSingle() returns { data: null } for a missing/
    // unauthorized row, and getItem/getFeed rely on that null to short-circuit.
    // PostgREST list selects return [] (never null), so array callers are
    // unaffected.
    return res.data as T;
  }

  /** Fetch the caller's item_state rows once and overlay them onto the store so
   * `stateStore.get()` reflects server truth for ordering/filtering. */
  private ensureHydrated(): Promise<void> {
    if (!this.hydration) {
      this.hydration = (async () => {
        // Snapshot pending writes BEFORE the read: a write that's in flight at
        // boot (flush + ensureHydrated start together) may resolve and clear the
        // outbox while this select is awaiting, which would otherwise let the
        // just-read pre-write server row look authoritative and overwrite the
        // optimistic state.
        const before = this.outbox.pendingChanges();
        const rows = this.unwrap<ItemStateRow[]>(
          await this.sb.from('item_state').select(ITEM_STATE_COLS),
        );
        // Record server versions so a future (not-yet-pending) edit bases its
        // optimistic-concurrency check on the right version.
        this.outbox.observeServerVersions(rows.map((r) => [r.item_id, r.version]));
        // Union with anything pending now, so an enqueue made DURING the select
        // is preserved too (newer fields win). Either snapshot alone misses one
        // of the two races; the union covers both.
        const pending = before;
        for (const [id, ch] of this.outbox.pendingChanges()) {
          pending.set(id, { ...pending.get(id), ...ch });
        }
        // Overlay un-synced local writes onto server truth (per field) while
        // clearing genuinely-stale rows.
        this.stateStore.hydrate(
          rows.map((r) => [r.item_id, mapItemState(r)] as [ItemId, ItemState]),
          pending,
        );
      })().catch((err) => {
        // Don't memoize a rejected promise — a transient/offline/expired-token
        // failure would otherwise be replayed to every later read forever. Clear
        // it so the next read retries.
        this.hydration = null;
        throw err;
      });
    }
    return this.hydration;
  }

  /** Fetch item rows for an id list in bounded `in (…)` batches (keeps the
   * request URL within limits for large library buckets). Optionally restricts
   * to a feed set. Order is not guaranteed — callers re-sort. */
  private async fetchItemRowsByIds(
    ids: ItemId[],
    feedIds?: FeedId[],
  ): Promise<ItemRow[]> {
    const batches = await Promise.all(
      chunk(ids, ID_LOOKUP_CHUNK).map(async (c) => {
        let q = this.sb.from('items').select(ITEM_COLS).in('id', c);
        if (feedIds) q = q.in('feed_id', feedIds);
        return this.unwrap<ItemRow[]>(await q);
      }),
    );
    return batches.flat();
  }

  private async ensureFeeds(ids: FeedId[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !this.feedCache.has(id));
    if (missing.length === 0) return;
    // Batch the metadata lookup too: a library/search result can span hundreds
    // of distinct feeds, which would otherwise be one unbounded feeds_public IN.
    const [feedBatches, subBatches] = await Promise.all([
      Promise.all(
        chunk(missing, ID_LOOKUP_CHUNK).map(async (c) =>
          this.unwrap<FeedPublicRow[]>(
            await this.sb.from('feeds_public').select(FEED_COLS).in('id', c),
          ),
        ),
      ),
      // Load overrides in the same pass so item-row feed labels (home/folder
      // views) show the subscription display name, not the raw feed title.
      Promise.all(
        chunk(missing, ID_LOOKUP_CHUNK).map((c) =>
          this.sb.from('subscriptions').select('feed_id,title_override').in('feed_id', c),
        ),
      ),
    ]);
    for (const row of feedBatches.flat()) this.feedCache.set(row.id, mapFeed(row));
    for (const result of subBatches) {
      for (const sub of (result.data ?? []) as Array<{ feed_id: string; title_override: string | null }>) {
        if (sub.title_override) {
          const feed = this.feedCache.get(sub.feed_id);
          if (feed) this.feedCache.set(sub.feed_id, { ...feed, title: sub.title_override });
        }
      }
    }
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
    // No per-instance memo: React Query owns subscription-list caching at the
    // hook layer, so a `['subscriptions']` invalidation (after subscribe/unsub/
    // mute, or to pick up another device's change) must re-hit Supabase here.
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
    return out;
  }

  /**
   * Shared feed-view read, fully server-side via the `feed_items` RPC
   * (0006_feed_rpcs.sql). The RPC drives from the caller's `subscriptions` →
   * `items` and LEFT JOINs `item_state` (scoped to `auth.uid()`) and returns one
   * combined, already-paged sequence: Pinned first (oldest-first), then the body
   * (newest-first by `sort_at`, Done/Hidden excluded). Because it pages the
   * *combined* sequence, each page holds at most `limit` rows (matching the
   * mock), and the client never sends an unbounded `feed_id`/exclusion `IN (…)`.
   * `total_count` is a window count carried on every row.
   */
  private async feedView(
    args: { p_scope: 'home' | 'folder' | 'feed'; p_folder: string | null; p_feed_id: FeedId | null },
    opts?: FeedListOptions,
  ): Promise<Page<FeedItem>> {
    const limit = opts?.limit ?? PAGE_SIZE;
    const offset = decodeCursor(opts?.cursor);

    // Ensure item_state is loaded before returning rows: the UI reads per-row
    // pin/opened affordances from the store, and overlayLocalState below consults
    // it, so a page returned before hydration would briefly show default flags.
    await this.ensureHydrated();
    const rows = this.unwrap<Array<{ item: ItemRow; total_count: number }>>(
      await this.sb.rpc('feed_items', { ...args, p_limit: limit, p_offset: offset }),
    );
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    const items = await this.resolveFeedItems(
      this.overlayLocalState(rows.map((r) => r.item)),
    );

    const nextOffset = offset + limit;
    return {
      items,
      total,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
    };
  }

  /**
   * Re-apply the local optimistic state to a page of RPC rows. The server join
   * is authoritative, but a just-written mutation may not have committed before
   * `useFeedItems` refetches — so overlay the store (which updated synchronously)
   * onto the bounded page: drop items now locally Done/Hidden (TTL-aware via
   * `stateStore.get`) and re-lift locally-Pinned ones to the top (oldest-pin
   * first). Operates only on the already-fetched page, so it can't resurrect a
   * row the server dropped — that self-heals on the next clean refetch.
   */
  private overlayLocalState(items: ItemRow[]): ItemRow[] {
    const pinned: Array<{ row: ItemRow; at: number }> = [];
    const body: ItemRow[] = [];
    for (const row of items) {
      const st = this.stateStore.get(row.id);
      if (st.done || st.hidden) continue;
      if (st.pinned) pinned.push({ row, at: st.pinnedAt ?? 0 });
      else body.push(row);
    }
    pinned.sort((a, b) => a.at - b.at);
    return [...pinned.map((p) => p.row), ...body];
  }

  // --- feed reads -----------------------------------------------------------

  async getHomeItems(opts?: FeedListOptions): Promise<Page<FeedItem>> {
    return this.feedView({ p_scope: 'home', p_folder: null, p_feed_id: null }, opts);
  }

  async getFolderItems(
    name: string,
    opts?: FeedListOptions,
  ): Promise<Page<FeedItem>> {
    return this.feedView({ p_scope: 'folder', p_folder: name, p_feed_id: null }, opts);
  }

  async getFeedItems(
    feedId: FeedId,
    opts?: FeedListOptions,
  ): Promise<Page<FeedItem>> {
    // Single-feed view includes a muted feed's own items (the RPC's 'feed' scope
    // doesn't apply the mute filter).
    return this.feedView({ p_scope: 'feed', p_folder: null, p_feed_id: feedId }, opts);
  }

  async getItem(id: ItemId): Promise<FeedItem | null> {
    const row = this.unwrap<ItemRow | null>(
      await this.sb.from('items').select(ITEM_DETAIL_COLS).eq('id', id).maybeSingle(),
    );
    if (!row) return null;
    const [fi] = await this.resolveFeedItems([row]);
    return fi ?? null;
  }

  async fetchFullText(id: ItemId): Promise<FullTextResult> {
    const { data, error } = await this.sb.functions.invoke('fulltext', {
      body: { itemId: id },
    });
    // Any invoke failure (signed-out, item not visible, function error) degrades
    // to "unreachable" so the reader simply falls back to the feed body rather
    // than surfacing an error — reading mode is a progressive enhancement.
    if (error) return { status: 'unreachable', contentHtml: null };
    const rec = data as { status?: string; contentHtml?: string | null } | null;
    const status: FullTextStatus =
      rec?.status === 'ok' ||
      rec?.status === 'empty' ||
      rec?.status === 'auth' ||
      rec?.status === 'unreachable'
        ? rec.status
        : 'unreachable';
    return {
      status,
      contentHtml: status === 'ok' ? (rec?.contentHtml ?? null) : null,
    };
  }

  async getItemsByIds(ids: ItemId[]): Promise<FeedItem[]> {
    // Ensure state is hydrated even on the empty-ids path so a direct cold boot
    // into a library route triggers the item_state fetch (which then repopulates
    // the store and re-derives the ids), rather than silently returning empty.
    await this.ensureHydrated();
    if (ids.length === 0) return [];
    const rows = await this.fetchItemRowsByIds(ids);
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
        .order('sort_at', { ascending: false })
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
    const sortMs = (r: ItemRow) =>
      Date.parse(r.published_at ?? r.created_at ?? '') || 0;
    let feedRows: ItemRow[] = [];
    if (feedIds.length > 0) {
      // A broad query ("news") can match many subscriptions, so batch the
      // feed_id lookup rather than send every id in one IN(...) URL. Each batch
      // returns its 50 newest; merge and keep the global 50 newest.
      const batches = await Promise.all(
        chunk(feedIds, ID_LOOKUP_CHUNK).map(async (c) =>
          this.unwrap<ItemRow[]>(
            await this.sb
              .from('items')
              .select(ITEM_COLS)
              .in('feed_id', c)
              .order('sort_at', { ascending: false })
              .limit(50),
          ),
        ),
      );
      feedRows = batches
        .flat()
        .sort((a, b) => sortMs(b) - sortMs(a))
        .slice(0, 50);
    }

    const byId = new Map<string, ItemRow>();
    for (const r of [...titleRows, ...feedRows]) byId.set(r.id, r);
    const merged = [...byId.values()].sort((a, b) => sortMs(b) - sortMs(a));
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
    let feed: Feed;
    const cached = this.feedCache.get(feedId);
    if (cached) {
      feed = cached;
    } else {
      const row = this.unwrap<FeedPublicRow | null>(
        await this.sb.from('feeds_public').select(FEED_COLS).eq('id', feedId).maybeSingle(),
      );
      if (!row) return null;
      feed = mapFeed(row);
      this.feedCache.set(feed.id, feed);
    }
    // Apply the user's title override from their subscription so the FeedPage
    // shows the display name rather than the raw feed title (or "Untitled feed").
    // Write the override-applied feed back to feedCache so a subsequent
    // resolveFeedItems() / ensureFeeds() call that finds this id already cached
    // also gets the correct display title.
    const subRow = await this.sb
      .from('subscriptions')
      .select('title_override')
      .eq('feed_id', feedId)
      .maybeSingle();
    const titleOverride = (subRow.data as { title_override: string | null } | null)?.title_override;
    if (titleOverride) {
      const overridden = { ...feed, title: titleOverride };
      this.feedCache.set(feedId, overridden);
      return overridden;
    }
    return { ...feed };
  }

  async discover(url: string): Promise<DiscoveredFeed[]> {
    const clean = url.trim();
    if (!clean) return [];
    const { data, error } = await this.sb.functions.invoke('discover', {
      body: { url: clean },
    });
    // Distinguish "couldn't reach / not a feed / needs auth / signed out" so
    // the UI can say which, rather than one opaque failure.
    if (error) throw await classifyFunctionError(error);
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

  /** subscribe_to_feed (0004) authorizes by URL possession, find-or-creates the
   * shared feed, subscribes auth.uid(), and returns the feeds_public row. Does
   * NOT trigger a fetch — callers that want the immediate poll do it. */
  private async subscribeOnly(feedUrl: string, folder?: string | null): Promise<Feed> {
    const rows = this.unwrap<FeedPublicRow[]>(
      await this.sb.rpc('subscribe_to_feed', {
        p_url: feedUrl,
        p_folder: folder ?? null,
      }),
    );
    const row = Array.isArray(rows) ? rows[0] : (rows as FeedPublicRow | null);
    if (!row) throw new Error('subscribe_to_feed returned no feed');
    const feed = mapFeed(row);
    this.feedCache.set(feed.id, feed);
    return feed;
  }

  async subscribe(feedUrl: string, folder?: string | null): Promise<Feed> {
    const feed = await this.subscribeOnly(feedUrl, folder);
    // SPEC *Polling → On-demand*: adding a feed triggers an immediate
    // server-side fetch so items/metadata appear without waiting for the cron.
    // Await the refresh so the caller gets back items + correct title/site_url.
    // Swallow errors — a failed poll still leaves the subscription in place.
    await this.refresh(feed.id).catch(() => {});
    // feedCache was cleared by refresh(); re-fetch so we return the updated title.
    const updated = await this.getFeed(feed.id).catch(() => null);
    return updated ?? feed;
  }

  async unsubscribe(feedId: FeedId): Promise<void> {
    // RLS scopes the delete to the caller's own (user_id, feed_id) row.
    const { error } = await this.sb
      .from('subscriptions')
      .delete()
      .eq('feed_id', feedId);
    if (error) throw error instanceof Error ? error : new Error(String(error));
  }

  async setMuted(feedId: FeedId, muted: boolean): Promise<void> {
    const { error } = await this.sb
      .from('subscriptions')
      .update({ muted })
      .eq('feed_id', feedId);
    if (error) throw error instanceof Error ? error : new Error(String(error));
  }

  async setTitleOverride(feedId: FeedId, title: string | null): Promise<void> {
    const { error } = await this.sb
      .from('subscriptions')
      .update({ title_override: title })
      .eq('feed_id', feedId);
    if (error) throw error instanceof Error ? error : new Error(String(error));
    // Evict from cache so the next ensureFeeds() re-fetches with the new override
    // applied. Without this, a warmed cache (e.g. from subscribe()'s getFeed())
    // would cause resolveFeedItems() to skip the override query for this feed.
    this.feedCache.delete(feedId);
  }

  async refresh(feedId?: FeedId): Promise<void> {
    const { error, data } = await this.sb.functions.invoke('refresh', {
      body: feedId ? { feedId } : {},
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
    // A refresh/poll updates feeds_public (title, parked/error health), so the
    // permanent feed cache is now stale. Clear before the failure check so that
    // any partial server-side metadata write (e.g. title updated but item upsert
    // failed) is reflected on the next getFeed() call rather than hidden behind
    // the pre-refresh cached value.
    this.feedCache.clear();
    // For a targeted single-feed refresh, treat { refreshed: 0, debounced: 0 }
    // as failure: it means refreshOne threw and the outer catch swallowed it.
    // refreshed: 0 + debounced: 1 is fine — the feed was recently fetched.
    if (feedId && data?.refreshed === 0 && data?.debounced === 0) {
      throw new Error('feed refresh failed');
    }
  }

  async retryParkedFeed(feedId: FeedId): Promise<void> {
    // "Retry now" = poll the feed immediately; a successful poll resets
    // error_count/parked server-side (poll/index.ts). refresh() also drops the
    // stale feedCache so the cleared health is re-read.
    await this.refresh(feedId);
  }

  // --- OPML -----------------------------------------------------------------

  async importOpml(xml: string): Promise<{ added: number; skipped: number }> {
    // Each <outline xmlUrl> becomes a subscribe_to_feed call. OPML attribute
    // values are XML-escaped, so decode entities (e.g. `&amp;` in a query string)
    // before subscribing or the feed gets stored/polled under the wrong URL.
    // subscribe_to_feed is idempotent, so a URL is "skipped" when it resolves to
    // a feed the caller already subscribed to.
    const urls = [...xml.matchAll(/xmlUrl="([^"]+)"/g)].map((m) => decodeXmlEntities(m[1]));
    const subscribed = new Set(
      (await this.loadSubscriptions()).map((s) => s.subscription.feedId),
    );
    let added = 0;
    let skipped = 0;
    for (const url of urls) {
      const feed = await this.subscribeOnly(url); // no per-feed refresh storm
      if (subscribed.has(feed.id)) {
        skipped++;
      } else {
        subscribed.add(feed.id);
        added++;
      }
    }
    // One immediate server fetch for the whole import (debounced server-side, so
    // already-fresh feeds are skipped) rather than a refresh per feed.
    if (added > 0) void this.refresh();
    return { added, skipped };
  }

  /**
   * KNOWN LIMITATION (tracked for the deferred backend item): `xmlUrl` here is
   * the display-safe `site_url` (homepage), not the RSS/Atom fetch URL. That is
   * deliberate — `feeds_public` never exposes `url`/`secret_url` (a per-user
   * token can ride in `secret_url`), so the client cannot emit the real feed
   * endpoint without leaking server-only data. A faithful, re-importable export
   * needs an authenticated server export RPC; until that lands the exported OPML
   * carries the public homepage address only.
   */
  async exportOpml(): Promise<string> {
    const subs = await this.loadSubscriptions();
    const outlines = subs
      .map(({ subscription, feed }) => {
        const title = subscription.titleOverride ?? feed.title;
        // See the method-level note: public homepage URL only, by design.
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
