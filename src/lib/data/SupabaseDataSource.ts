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
import { confirmBackendReachable } from '../networkStatus';
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
const ITEM_DETAIL_COLS = `${ITEM_COLS}, full_content_html`;
const ITEM_STATE_COLS =
  'item_id, pinned, pinned_at, favorite, favorite_at, done, done_at, hidden, hidden_at, opened, opened_at, version';
const SUBSCRIPTION_COLS = 'feed_id, folder, title_override, muted, sort';

/** Max ids per `in (…)` lookup, so a large library bucket (Done/Hidden/Favorite
 * with hundreds/thousands of ids) is fetched in bounded batches rather than one
 * unbounded request that could exceed the request-line/query limit. */
const ID_LOOKUP_CHUNK = 200;

/** Row ceiling the group-by-feed windowed read asks for, so every feed
 * section's opening window lands in a single response. PostgREST caps a
 * response at 1000 rows anyway; with each section capped to PER_FEED_WINDOW the
 * caller-bounded feed count keeps feeds × window well under this. */
const GROUPED_WINDOW_ROW_CAP = 1000;

/** Hard ceiling on the item_state hydration read, after which it's aborted and
 * treated as a failure. item_state is served NetworkOnly (vite.config —
 * `supabaseItemStatePattern`) so it has NO service-worker network-timeout/cache
 * fallback; without an explicit client-side abort a stalled backend would hang
 * the read forever — and with it every feed/library read, which `await`s
 * `ensureHydrated()` before returning rows (the home feed's "Checking for new
 * items…" strip and each grouped section's "More" then stick on a spinner that
 * never resolves). Bounding the read keeps the design's "live-or-fail" promise
 * literally true: a stall now *fails* within this budget, `ensureHydrated`
 * clears its memo, and the read proceeds on the last-good localStorage store.
 * Matches the 10s the removed NetworkFirst REST route applied to this same read
 * via `networkTimeoutSeconds`, so a merely-slow (not hung) connection that
 * worked before still works. */
export const ITEM_STATE_READ_TIMEOUT_MS = 10_000;

/** A throwaway UUID used as a per-request cache-buster on the item_state read
 * (`item_id=not.eq.<uuid>`). Prefers `crypto.randomUUID`; the Math.random
 * fallback is RFC4122-shaped — only uniqueness matters here, not entropy, and a
 * valid-UUID shape keeps it a legal literal for the (uuid) `item_id` column. */
function cacheBustUuid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
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
  private resyncing: Promise<void> | null = null;
  /** A resync was requested while one was already in flight — re-run a fresh one
   * if the in-flight attempt fails, so a recovery (e.g. an `online` event after
   * a blip) isn't lost to the coalesce. See resyncState. */
  private resyncPending = false;
  /** Serializes item_state hydrations: a new read chains after any in-flight one
   * so reads run one-at-a-time. The last-applied read is then always the freshest
   * — its request is sent only after the prior response arrived, so the server
   * executes it strictly later — without assuming client start order matches the
   * server's execution order (which HTTP/2 / server queueing can reorder). */
  private hydrationChain: Promise<void> = Promise.resolve();
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
        // Normalize the optimistic store version to the confirmed server version
        // so a later cold-boot `seedConfirmedVersions` bases offline edits on the
        // real server version, not an inflated local counter (coalesced edits bump
        // the local version more than the single server write does).
        if (!error && version != null) this.stateStore.confirmServerVersion(id, version);
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
      () => {
        // A queued write committed server-side. The list self-heals via the
        // local store overlay, but the per-feed unread-count badge reads a
        // server-only count (getFeedUnreadCounts) that was refetched
        // optimistically before the write landed — poke subscribers so the
        // feed-invalidation hook re-invalidates and the badge re-reads the now-
        // correct count.
        this.stateStore.notifySynced();
      },
    );
    this.stateStore.setMutationSink((id, changed) => this.outbox.enqueue(id, changed));
    // Seed the outbox's optimistic-concurrency write bases from the persisted
    // store's per-row versions. item_state is read NetworkOnly, so an offline
    // cold boot gets no live hydration to observe versions from; without this
    // seed, an edit made before the first online read would flush with a null
    // base ("no check") and could clobber a concurrent change from another
    // device. The seeded version is this device's last-known server version
    // (corrected by the next live hydrate), so the edit conflicts/reconciles
    // instead. Does NOT mark the outbox "fully hydrated" — only a live read
    // confirms an item is absent (which authorizes base 0).
    this.outbox.seedConfirmedVersions(
      this.stateStore.entries().map(([id, s]) => [id, s.version] as const),
    );
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

  /**
   * Fetch the caller's item_state rows and overlay them onto the store so
   * `stateStore.get()` reflects server truth. A live read is authoritative, so
   * `hydrate` reconciles fully (server rows win, un-synced pending writes
   * preserved, genuinely-absent rows dropped).
   *
   * The read **bypasses the service-worker cache** (NetworkOnly — see
   * `supabaseItemStatePattern` in vite.config — plus a per-request cache-buster
   * so an old worker still on the NetworkFirst route can't serve a stale 200
   * either); it is therefore live or it fails. A live read is authoritative, so
   * no stale-cache guards are needed.
   * That's what keeps a focus/online resync from reverting a just-made pin off
   * an old cached snapshot, AND keeps an offline cold boot from dropping a
   * resync-adopted row by reconciling against a stale cached boot snapshot:
   * offline the read simply fails and callers leave the local store on its
   * last-good (localStorage) state. The outbox's optimistic-concurrency write
   * bases come from the persisted store instead (constructor
   * `seedConfirmedVersions`), so an offline edit still conflicts/reconciles on
   * reconnect rather than flushing a blind no-base write.
   *
   * Hydrations are **serialized** (`hydrationChain`): a read doesn't start until
   * any in-flight one has finished applying. Running them one-at-a-time means the
   * last to apply is always the freshest — its request is sent only after the
   * previous response arrived, so the server executes it strictly later. That
   * avoids assuming the client's start order matches the server's execution order
   * (HTTP/2 / server-side queueing can reorder concurrent requests), which an
   * earlier generation-counter approach got wrong: a boot read started first but
   * executed later could carry a newer cross-device change, yet be dropped
   * because a resync had already applied.
   */
  private runHydration(): Promise<void> {
    const run = this.hydrationChain.then(
      () => this.applyHydration(),
      // A prior hydration's failure must not poison the chain — still run ours.
      () => this.applyHydration(),
    );
    // The chain tracks completion (success or failure) so the next read waits its
    // turn without inheriting this one's rejection.
    this.hydrationChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** One serialized hydration: read item_state live and reconcile it into the
   * store. Only called via {@link runHydration}, so reads never overlap. */
  private async applyHydration(): Promise<void> {
    // Snapshot pending writes BEFORE the read: a write that's in flight at boot
    // (flush + hydration start together) may resolve and clear the outbox while
    // this select is awaiting, which would otherwise let the just-read pre-write
    // server row look authoritative and overwrite the optimistic state.
    const before = this.outbox.pendingChanges();
    // Append an always-unique `item_id=not.eq.<uuid>` filter (excludes nothing —
    // no row has that id — so every row is still returned). It makes the request
    // URL unique per read, which busts any URL-keyed cache. That matters during a
    // service-worker rollout: a newly-deployed bundle can run for a moment under
    // the PREVIOUS worker, whose `/rest/v1/` NetworkFirst route (the new
    // NetworkOnly item_state route doesn't exist until the new worker activates)
    // could otherwise serve a stale cached 200 that `hydrate` would treat as
    // authoritative and revert committed local state. A never-seen URL has no
    // cache entry, so even that old worker goes to network or misses-and-fails —
    // live-or-fail under any worker version, so the deleted stale-snapshot guards
    // stay unneeded.
    // Bound the read: item_state is NetworkOnly (no SW network-timeout/cache
    // fallback), so a stalled backend would otherwise hang this read — and every
    // feed/library read awaiting it — indefinitely. Abort after the budget so a
    // stall fails fast and reads fall back to the last-good store. Uses an
    // AbortController + setTimeout (not AbortSignal.timeout) so fake timers can
    // drive it in tests, mirroring confirmBackendReachable.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ITEM_STATE_READ_TIMEOUT_MS);
    let rows: ItemStateRow[];
    try {
      rows = this.unwrap<ItemStateRow[]>(
        await this.sb
          .from('item_state')
          .select(ITEM_STATE_COLS)
          .not('item_id', 'eq', cacheBustUuid())
          .abortSignal(controller.signal),
      );
    } finally {
      clearTimeout(timer);
    }
    // Record server versions (monotonic) for the outbox's optimistic-concurrency
    // base.
    this.outbox.observeServerVersions(rows.map((r) => [r.item_id, r.version]));
    // Union with anything pending now, so an enqueue made DURING the select is
    // preserved too (newer fields win). Either snapshot alone misses one of the
    // two races; the union covers both.
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
  }

  /** Memoized hydration, used by every read: once it has succeeded, reads return
   * the established hydration without re-fetching. A failed attempt clears the
   * memo (identity-guarded) so the next read retries; a successful background
   * resync may replace it with a fresher one, and a *failed* resync leaves it
   * untouched (see `resyncState`) so reads keep using last-good state. */
  private ensureHydrated(): Promise<void> {
    if (!this.hydration) {
      const p: Promise<void> = this.runHydration().catch((err) => {
        // Don't memoize a rejected hydration — a transient/offline/expired-token
        // failure would otherwise be replayed to every later read forever. Only
        // clear if THIS attempt is still the memo (a resync may have swapped in a
        // good one meanwhile), so we never null out a healthy hydration.
        if (this.hydration === p) this.hydration = null;
        throw err;
      });
      this.hydration = p;
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
   * No total count rides on the rows (it forced a full scan of the filtered set
   * on every call — SCALING.md); "is there another page?" is inferred from
   * whether this page came back full.
   */
  private async feedView(
    args: { p_scope: 'home' | 'folder' | 'feed'; p_folder: string | null; p_feed_id: FeedId | null },
    opts?: FeedListOptions,
  ): Promise<Page<FeedItem>> {
    // Group-by-feed windowed read: each feed section is capped to `perFeedLimit`
    // rows server-side, so a single read holds every section's opening window and
    // depth comes from the per-section "More" — not a global page. We ask for up
    // to the PostgREST row cap; with a bounded feed count (feeds × perFeedLimit)
    // that's one page. If an account still overflows the cap (more than
    // GROUPED_WINDOW_ROW_CAP / perFeedLimit populated feeds, until the planned
    // feed cap lands), the read still pages by row cursor so the later
    // feed-sections aren't silently dropped — the bottom "More" loads the next
    // batch of sections.
    const perFeedLimit =
      opts?.groupByFeed && opts?.perFeedLimit != null ? opts.perFeedLimit : null;
    const windowed = perFeedLimit != null;
    const limit = windowed ? GROUPED_WINDOW_ROW_CAP : opts?.limit ?? PAGE_SIZE;
    const offset = decodeCursor(opts?.cursor);

    // Ensure item_state is loaded before returning rows: the UI reads per-row
    // pin/opened affordances from the store, and overlayLocalState below consults
    // it, so a page returned before hydration would briefly show default flags.
    // Best-effort: item_state is read NetworkOnly (live or fail), so when it
    // fails (offline / backend down) proceed with the last-good localStorage
    // store rather than failing the whole feed here — the feed_items RPC below is
    // what surfaces the offline/down miss-state.
    await this.ensureHydrated().catch(() => {});
    const rows = this.unwrap<Array<ItemRow>>(
      await this.sb.rpc('feed_items', {
        ...args,
        p_limit: limit,
        p_offset: offset,
        // Body ordering/sectioning is applied server-side so it holds across
        // pages (0016_feed_items_sort_group.sql). Pinned stay oldest-first on top.
        p_sort: opts?.sort ?? 'newest',
        p_group_by_feed: opts?.groupByFeed ?? false,
        // Cap each feed's section to its newest this-many rows (0021), grouping
        // only. Sent ONLY for the windowed grouped read so flat/folder/single-feed
        // reads keep the 7-arg payload — that way a client that rolls out before
        // migration 0021 still resolves those against the old 7-arg function
        // (PostgREST matches a function by the arg-name set, so an unknown
        // p_per_feed_limit key would 404 the whole read). After 0021 the arg
        // defaults to null, so the omitted key is fine; only the grouped view
        // depends on the new function.
        ...(windowed ? { p_per_feed_limit: perFeedLimit } : {}),
      }),
    );
    // PostgREST expands composite OUT columns flat: `returns table (item items)`
    // yields `[{ id, feed_id, ... }]`, not `[{ item: { id, ... } }]`. Guard that
    // each row has the minimum expected shape so a stale DB function surfaces a
    // clear error instead of a cryptic downstream crash.
    const malformed = rows.find((r) => r == null || typeof r.id !== 'string');
    if (malformed !== undefined) {
      console.error(
        '[readmo] feed_items returned an unexpected row shape — expected flat item rows. Sample row:',
        malformed,
      );
      throw new Error('feed_items returned rows missing expected item fields.');
    }
    const items = await this.resolveFeedItems(
      this.overlayLocalState(rows, opts?.groupByFeed ?? false),
    );

    // An empty first page renders the "all caught up" empty state. But the
    // service worker's NetworkFirst cache can answer this read with a stale empty
    // 200 while the backend is actually down — the 15s read cap sits past the
    // SW's 10s cache-fallback window precisely so a slow read still gets served
    // from cache — and trackedFetch reads that cache hit as success, leaving the
    // status 'online'. So a cache-served empty page would falsely claim the
    // reader is caught up. Confirm with a live, SW-bypassing reachability probe
    // before trusting it; if the backend isn't reachable, surface a read error so
    // the view shows the offline/down miss-state instead of "all caught up".
    if (offset === 0 && items.length === 0 && !(await confirmBackendReachable())) {
      throw new Error(
        'feed read returned empty but the backend is unreachable — refusing to claim caught up off a possible cache hit',
      );
    }

    // A full page (server returned exactly `limit` rows) means more may follow;
    // a short page is the end. This compares the *raw* RPC row count, not the
    // post-overlay `items` (overlayLocalState can drop locally Done/Hidden rows
    // from a page), so the cursor still tracks the server's offset paging. The
    // tradeoff vs. a total count: when the result set is an exact multiple of
    // `limit`, the final fetch returns an empty page before stopping.
    // A full page (server returned exactly `limit` rows) means more may follow.
    // The windowed grouped read is normally a single page (the per-section
    // "More" handles depth), but if it filled the row cap there are more
    // sections than fit — keep a cursor so the bottom "More" can load the next
    // batch rather than dropping them.
    const nextOffset = offset + limit;
    return {
      items,
      nextCursor: rows.length === limit ? String(nextOffset) : null,
    };
  }

  /**
   * Re-apply the local optimistic state to a page of RPC rows. The server join
   * is authoritative, but a just-written mutation may not have committed before
   * `useFeedItems` refetches — so overlay the store (which updated synchronously)
   * onto the bounded page: drop items now locally Done/Hidden (TTL-aware via
   * `stateStore.get`). Operates only on the already-fetched page, so it can't
   * resurrect a row the server dropped — that self-heals on the next clean
   * refetch.
   *
   * In the flat view it also re-lifts locally-Pinned rows to a global top
   * section (oldest-pin first), matching the server layout.
   *
   * In the **grouped** view it returns the server rows UNCHANGED — no local
   * Done/Hidden drop and no pin lift. ItemList already filters Done/Hidden for
   * display (`visibleItems`) and reads pin/opened per row from the store, so
   * dropping here is redundant for display; worse, it would shrink the
   * per-feed has-more probe (the overfetched `PER_FEED_WINDOW + 1`th row) below
   * the threshold while an optimistic Done/Hidden is still outbox-pending —
   * transiently hiding that section's "More" even though the server returned
   * older rows. Keeping the raw server rows means the has-more count reflects
   * what the server actually returned; the dismissed row is filtered from the
   * rendered list by ItemList and self-heals on the next clean refetch. (The
   * server already sections pinned within each feed, so no lift is needed.)
   */
  private overlayLocalState(items: ItemRow[], groupByFeed: boolean): ItemRow[] {
    if (groupByFeed) return items;
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

  async getFeedUnreadCounts(
    feedIds: FeedId[],
  ): Promise<Record<FeedId, number>> {
    const counts: Record<FeedId, number> = {};
    for (const id of feedIds) counts[id] = 0;
    if (feedIds.length === 0) return counts;
    // Server-side count (RLS scopes it to the caller's subscriptions). It reads
    // the server's item_state, so it can briefly lag a just-applied local
    // open/done until the outbox syncs — fine for a badge; it self-heals on the
    // next refetch (feed invalidation after a triage write triggers one).
    //
    // Batch the feed-id list (one response row per feed) so no single response
    // approaches the PostgREST row cap — otherwise a caller with a very large
    // subscription list would get a truncated response and the missing feeds
    // would stay at their prefilled 0, falsely reading as "nothing unread".
    for (const batch of chunk(feedIds, ID_LOOKUP_CHUNK)) {
      const rows = this.unwrap<Array<{ feed_id: string; n: number | string }>>(
        await this.sb.rpc('feed_unread_counts', { p_feed_ids: batch }),
      );
      for (const r of rows) counts[r.feed_id] = Number(r.n) || 0;
    }
    return counts;
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
    // Best-effort: item_state is read NetworkOnly, so offline it fails — fall
    // back to the last-good localStorage store (the ids already came from it)
    // rather than failing the whole library read.
    await this.ensureHydrated().catch(() => {});
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

  async reorderSubscriptions(orderedFeedIds: FeedId[]): Promise<void> {
    // One atomic statement (0017's reorder_subscriptions RPC) reassigns every
    // named subscription's `sort` to its position, scoped to auth.uid(). Doing it
    // server-side in a single UPDATE means a transient failure can't leave the
    // order half-rewritten with duplicate/gap sorts — which would corrupt the
    // grouped feed order until the next full reorder. Negligible cost.
    const { error } = await this.sb.rpc('reorder_subscriptions', {
      p_feed_ids: orderedFeedIds,
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
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
   * NOT trigger a fetch — callers that want the immediate poll do it.
   *
   * TODO(feed-cap): cap the number of feeds a user may subscribe to. Enforce it
   * server-side in the `subscribe_to_feed` RPC (count the caller's subscriptions
   * and reject past the limit) so it can't be bypassed, and surface a clear
   * "subscription limit reached" error here. Beyond abuse/cost, the cap bounds
   * the grouped feed read: the group-by-feed view returns up to K items per feed
   * in one response, so a hard feed cap keeps that under the PostgREST row cap
   * (and the OPML import path must respect it too). */
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

  // --- sync -----------------------------------------------------------------

  /**
   * Re-pull server item_state so a pin/favorite/done made on another device
   * shows up here. Boot hydration is memoized in `this.hydration` and never
   * re-runs on its own, so without this a backgrounded tab keeps showing the
   * pins it loaded at boot. The re-pull bypasses the service-worker cache (see
   * runHydration), so it's live or it fails: a live read fully reconciles the
   * store with server truth (pending writes preserved); a failed one leaves the
   * store untouched. The store emits on change → the feed-invalidation hook
   * refetches and the library pages re-read.
   *
   * The memo is swapped to the fresh hydration only on success, so a failed
   * resync (offline / backend down) leaves last-good state and reads keep
   * working. Concurrent calls coalesce: a single tab return can fire `focus` AND
   * `visibilitychange`, and we want one re-pull, not two. We also kick the outbox
   * so a write stranded while the tab was hidden (online, but no `online` event
   * fired) gets pushed out — the read side's pending snapshot keeps that
   * in-flight write safe.
   */
  resyncState(): Promise<void> {
    // Coalesce overlapping calls (a single tab return can fire `focus` AND
    // `visibilitychange`) — but remember the request, because conditions may
    // have changed in a way the in-flight attempt won't reflect. Notably an
    // `online` event can land while a resync started during a connectivity blip
    // is still in flight and doomed to fail; coalescing into it would lose the
    // recovery. So if the in-flight attempt fails, we run a fresh one after.
    if (this.resyncing) {
      this.resyncPending = true;
      return this.resyncing;
    }
    void this.outbox.flush();
    const current = (async () => {
      try {
        // Swap the memo to the fresh hydration only AFTER it succeeds, so a
        // failed resync leaves the last-good hydration — and the in-memory store
        // — intact and reads keep working. The read is NetworkOnly (live or
        // fail), so a resync never reconciles against a stale cache snapshot.
        const fresh = this.runHydration();
        await fresh;
        this.hydration = fresh;
      } finally {
        this.resyncing = null;
      }
    })();
    this.resyncing = current;
    current.then(
      // Succeeded — any callers that coalesced got the fresh result; clear the
      // request so we don't re-pull needlessly.
      () => {
        this.resyncPending = false;
      },
      // Failed — if another resync was requested while this one ran, run a fresh
      // one now (e.g. we came back online after a blip). Bounded by real events:
      // the flag is only set by an incoming call.
      () => {
        if (this.resyncPending) {
          this.resyncPending = false;
          void this.resyncState().catch(() => {});
        }
      },
    );
    return current;
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
