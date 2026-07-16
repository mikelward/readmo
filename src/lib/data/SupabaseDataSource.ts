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
  type ItemStateField,
  type ListLayout,
  type OpenMode,
  type Subscription,
} from '../types';
import type { FullTextResult, FullTextStatus } from '../fullText';
import type { SummaryResult, SummaryStatus } from '../summary';
import type { MirrorPayload } from '../newshackerSync';
import type { SyncedSettings } from '../settingsSync';
import { getSupabase } from '../supabase/client';
import { confirmBackendReachable } from '../networkStatus';
import { OUTBOX_SUFFIX } from '../userCache';
import { isGoogleNewsFeedUrl } from '../googleNews';
import { ItemStateStore, localStoragePersistence } from './itemState';
import { decodeXmlEntities } from './xmlEntities';
import { buildOpml } from './opml';
import {
  ItemStateOutbox,
  localStorageOutboxPersistence,
  type ChangedFields,
} from './itemStateOutbox';
import {
  type AdminFeedSampleItem,
  type AdminFeedStatus,
  type AdminFeedSubscriber,
  type AdminUserFeed,
  type AiCall,
  type AiCallCount,
  type AiCallKind,
  type FulltextDownloadStatus,
  type AllowlistEntry,
  type Capabilities,
  type DataSource,
  type DiscoveredFeed,
  type FeedListOptions,
  type FeedProbeResult,
  type ItemSort,
  type Page,
  type RegisteredUser,
  AddFeedError,
  type AddFeedErrorKind,
} from './DataSource';
import { PAGE_SIZE } from './MockDataSource';
import {
  type FeedPublicRow,
  type ItemRow,
  type SharedItemRow,
  type ItemStateRow,
  type SubscriptionRow,
  type UserSettingsRow,
  mapFeed,
  mapItem,
  mapSharedItem,
  mapItemState,
  mapSubscription,
  mapUserSettings,
  mapAiCall,
  type AiCallRow,
  isMissingTableError,
  isPermanentWriteError,
  toRequestError,
  PARKED_ERROR_THRESHOLD,
  FEED_LIMIT_CODE,
} from './supabaseMappers';

/** The display-safe columns of `feeds_public` (and of `feeds` for clients —
 * never the fetch URLs). */
const FEED_COLS =
  'id, site_url, title, favicon_url, last_fetched_at, next_fetch_at, fetch_interval_s, error_count, last_error, created_at';
const ITEM_COLS =
  'id, feed_id, guid, url, comments_url, title, spoiler_free_title, author, published_at, content_html, summary, enclosures, content_hash, created_at';
// No client read selects the cached full-article body (`full_content_html`) or
// its `full_content_via_fallback` provenance flag. Both are gated on the
// trusted-user allowlist and served ONLY through the `fulltext` Edge Function,
// which checks the allowlist and returns the cached body (and flag) to listed
// callers (a cache hit) — see fetchFullText / SPEC "Full-text reading mode". A
// direct column read here would hand the cached full article — including
// fallback-sourced content — to any subscriber who can see the item row,
// bypassing that gate. (List /
// search / library reads omit it anyway for payload/cache size.) So the reader's
// single-item detail read uses the same ITEM_COLS as list rows; the full body
// arrives via fetchFullText. A column-level REVOKE so a hand-crafted PostgREST
// read can't reach it either is folded into the DB-backed allowlist follow-up.
const ITEM_STATE_COLS =
  'item_id, pinned, pinned_at, favorite, favorite_at, done, done_at, hidden, hidden_at, opened, opened_at';
const SUBSCRIPTION_COLS =
  'feed_id, folder, title_override, muted, open_original, open_newshacker, mark_done_on_open, list_layout, sort';
/** The synced reading-behavior settings columns (`user_settings`, 0064) — the
 * caller's own row only (RLS); `user_id`/`updated_at` never leave the server. */
const USER_SETTINGS_COLS =
  'item_sort, group_by_feed, hide_on_scroll, show_row_favicon, show_group_favicon, hide_sports_spoilers, auto_summarize_pinned';

/** How long a "backend has no user_settings table" detection is trusted before
 * the next reconcile re-probes. Long enough that a pre-migration tab isn't
 * paying a failing request per focus/flip, short enough that a long-lived PWA
 * tab notices the operator's `make migrate` within minutes and drains its
 * pending settings without needing a reload. */
const SETTINGS_UNSUPPORTED_RETRY_MS = 5 * 60 * 1000;

/** Max ids per `in (…)` lookup, so a large library bucket (Done/Hidden/Favorite
 * with hundreds/thousands of ids) is fetched in bounded batches rather than one
 * unbounded request that could exceed the request-line/query limit. */
const ID_LOOKUP_CHUNK = 200;

/** Page size the group-by-feed read asks for, sized so every feed section
 * normally lands in a single response. This is NOT a fetch cap — the client
 * sends no per-feed limit and accepts everything the server returns (the
 * server decides any cap); it's the largest page PostgREST will serve anyway
 * (1000 rows). An account whose grouped view overflows it still pages by row
 * cursor, so later sections aren't silently dropped. */
const GROUPED_WINDOW_ROW_CAP = 1000;

/** Page size for the full item_state hydrate read. PostgREST caps a single
 * response at 1000 rows (see GROUPED_WINDOW_ROW_CAP), so an account that has
 * accumulated more than that many item_state rows (every pin / favorite / done /
 * open writes one, and they're never auto-deleted) would have its hydrate read
 * silently truncated to the cap. `hydrate` treats any local row ABSENT from the
 * server response as genuinely-stale and drops it — so a truncated read would
 * wipe the done/pinned/favorite flags of every row past the cap, resurfacing
 * swept items and dropping pins. Paging until a short page guarantees the
 * response is COMPLETE, so "absent = stale" holds.
 *
 * The paging is KEYSET (by `item_id`), not offset (`.range()`): an offset window
 * shifts if another device inserts a row between two page reads, which would skip
 * one already-existing server row — and `hydrate` would then drop that row's
 * local pin/done/favorite, the very bug this guards against, during a cross-
 * device write. Keying off the last item_id can't skip an existing row. */
const ITEM_STATE_PAGE = 1000;

/** Total attempts for a summary fetch (i.e. one retry). A transient outcome — a
 * statusless network blip / 5xx on invoke, or the server's own `unreachable`
 * envelope — is retried once before we return it, so a single blip no longer
 * costs the whole summary until the next reader mount. See getSummary. */
const SUMMARY_FETCH_ATTEMPTS = 2;

/** Delay between those summary-fetch attempts. Short — long enough to clear a
 * momentary blip, short enough not to make the reader's first open feel stuck. */
const SUMMARY_FETCH_RETRY_DELAY_MS = 800;

/** Total attempts for a full-text (reading-mode) fetch, mirroring the summary
 * policy above: a transient `unreachable` — a network blip / 5xx on invoke, or
 * the server's own `unreachable` envelope — is retried once before we return it,
 * so a single blip no longer drops the reader to the feed body until the next
 * open. See fetchFullText. */
const FULLTEXT_FETCH_ATTEMPTS = 2;

/** Delay between those full-text fetch attempts. Same short backoff as the
 * summary retry, for the same reason. */
const FULLTEXT_FETCH_RETRY_DELAY_MS = 800;

/** Hard ceiling on a single summary/full-text Edge invoke. These calls are
 * legitimately long-running (a cache miss generates: Jina + Gemini, or the
 * publisher fetch + extraction — tens of seconds; a coalescing waiter blocks
 * until the generator's result lands), which is exactly why the global
 * supabaseFetch read cap deliberately skips `/functions/v1/`. But "uncapped"
 * must not mean "can hang forever": on a phone, a fetch that's in flight when
 * the app is suspended can neither resolve nor reject after resume, and because
 * React Query dedupes every later fetch of the same key into that in-flight
 * promise, one frozen invoke silently wedges every future prewarm retry AND the
 * reader's own open. The cap turns that corpse into a retryable `unreachable`
 * so the retry loops actually loop. Sized above the worst-case legitimate
 * response (generation ≤ ~40 s; a waiter's poll ≤ 45 s) so it only ever fires
 * on a genuinely dead transport. */
const INVOKE_TIMEOUT_MS = 60_000;

/** How long a feed/library read on a still-empty store will WAIT for the first
 * item_state hydration before rendering anyway (with default per-row flags / a
 * library that self-heals on the hydration's store emit). Bounds the cold-cache
 * case — a fresh or cache-purged device whose first hydration is the slow/paged
 * or stalled read this fix targets — so it can't strand that device on loading
 * skeletons. Only the read's *wait* is capped; the hydration fetch itself runs
 * unbounded in the background (still subject to supabaseFetch's own 8s cap), so
 * connectivity/Down detection is unaffected. */
const COLD_HYDRATE_WAIT_MS = 4000;

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
      blocked: 'blocked',
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
 * Triage writes flow through the durable offline outbox ({@link ItemStateOutbox})
 * to `set_item_state`, which resolves cross-device conflicts by per-field
 * last-write-wins on each field's action timestamp (see SPEC *Sync*). OPML
 * *export* goes through the `export_subscriptions` RPC (0061), which returns the
 * caller's real feed fetch URLs so the file is re-importable elsewhere.
 *
 * Pagination is offset-based behind an opaque numeric cursor (mirroring the
 * mock); each page is the bounded slice of the combined pinned-then-body
 * sequence the `feed_items` RPC returns.
 */
/** Narrow a raw `item_fulltext_status.status` string to the known enum, or null
 * (absent, or an unexpected value from a newer backend). */
function normalizeDownloadStatus(
  value: string | null,
): FulltextDownloadStatus | null {
  switch (value) {
    case 'ok':
    case 'auth':
    case 'unreachable':
    case 'empty':
      return value;
    default:
      return null;
  }
}

export class SupabaseDataSource implements DataSource {
  readonly stateStore: ItemStateStore;

  private readonly sb: SupabaseClient;
  private readonly feedCache = new Map<FeedId, Feed>();
  private hydration: Promise<void> | null = null;
  // Set by the write path when an LWW write lost (the server returned a row that
  // didn't take our value). Consumed by onDrained — *after* the drain clears the
  // entry — to re-pull server truth, so the re-hydrate's pending overlay no longer
  // preserves the stale optimistic value the in-flight write would have kept.
  private lwwLossPending = false;
  /** Changed FIELDS written by the user WHILE an item_state read is in flight,
   * unioned per item. Two jobs: (a) protect a brand-new row (no server row yet)
   * that raced the read from being dropped as "absent"; (b) carry the field set
   * so a write that enqueues AND drains entirely within the read window — leaving
   * the outbox, so neither the start nor end pending snapshot has it — can still
   * be overlaid onto a tied server row (a same-ms `at` the parked snapshot also
   * holds, which strict-`>` LWW would otherwise resolve to the stale server
   * value, with the outbox already empty so no loss re-pull corrects it). A
   * permanent reject removes its id (the write landed nothing and the item is
   * gone). Null when no read is in flight; hydrations are serialized so at most
   * one map is ever active. */
  private hydrationWrittenChanges: Map<ItemId, ChangedFields> | null = null;
  /** Set once any item_state hydration has successfully applied. Lets a read
   * tell "the store has never been populated" (wait for the first hydration so
   * the first paint isn't all default flags) from "we already have last-good
   * state" (return rows now; refresh hydration in the background) — see
   * `ensureHydratedForRead`. */
  private hydratedOnce = false;
  /** Epoch ms of the last successful server item_state pull, or null until the
   * first one lands. Surfaced on `/debug` via {@link getLastSyncedAt}. */
  private lastSyncedAt: number | null = null;
  /** Epoch ms of the last `user_settings` read/write that said the backend has
   * no such table (predates 0064), or null when the table is (assumed)
   * present. While fresh, both settings methods short-circuit so prefs behave
   * device-local without hitting the network (guardrail #11) — but the memo
   * EXPIRES ({@link SETTINGS_UNSUPPORTED_RETRY_MS}): a PWA tab can outlive the
   * operator's `make migrate` by days, and a permanent memo would strand its
   * pending settings until a reload. After expiry the next reconcile re-probes;
   * a still-missing table just re-stamps it (Codex P2 on #494). */
  private syncedSettingsUnsupportedAt: number | null = null;

  /** Whether the backend was recently seen without `user_settings`, expiring
   * the memo when its retry window has passed. */
  private settingsBackendUnsupported(): boolean {
    if (this.syncedSettingsUnsupportedAt === null) return false;
    if (Date.now() - this.syncedSettingsUnsupportedAt < SETTINGS_UNSUPPORTED_RETRY_MS) {
      return true;
    }
    this.syncedSettingsUnsupportedAt = null;
    return false;
  }
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
  /** Delay between summary-fetch retries (see getSummary). A mutable field rather
   * than the const directly so tests can zero it and not wait on a real timer. */
  summaryRetryDelayMs = SUMMARY_FETCH_RETRY_DELAY_MS;
  /** Delay between full-text fetch retries (see fetchFullText). Mutable for the
   * same reason as {@link summaryRetryDelayMs} — tests zero it. */
  fullTextRetryDelayMs = FULLTEXT_FETCH_RETRY_DELAY_MS;
  /** Ceiling on a single summary/full-text Edge invoke (see INVOKE_TIMEOUT_MS).
   * Mutable so tests can shrink it instead of waiting out a real minute. */
  invokeTimeoutMs = INVOKE_TIMEOUT_MS;

  constructor(stateKey = 'readmo:item-state', client?: SupabaseClient) {
    this.sb = client ?? getSupabase();
    this.stateStore = new ItemStateStore(localStoragePersistence(stateKey));

    // Durable write-through via the offline outbox: triage toggles apply to the
    // store optimistically (instant UI) and are queued here for delivery to the
    // set_item_state RPC (0004) — coalesced per item, serialized, retried on
    // reconnect, and surviving a reload/offline gap. A permanent server rejection
    // re-pulls server truth to correct the optimistic state.
    this.outbox = new ItemStateOutbox(
      async (id, changed) => {
        const params: Record<string, unknown> = { p_item_id: id };
        // Send only the changed fields (set_item_state leaves null params
        // untouched), each with its action time as the per-field last-write-wins
        // clock (`p_<f>_at`). The server keeps whichever write has the newer `at`,
        // so a stale mirror can't clobber a field changed more recently elsewhere.
        for (const [f, c] of Object.entries(changed)) {
          params[`p_${f}`] = c.value;
          params[`p_${f}_at`] = new Date(c.at).toISOString();
        }
        const { data, error } = await this.sb.rpc('set_item_state', params);
        // LWW: the RPC returns the post-write server row. If a field we sent did
        // NOT land — an older offline write that lost to a newer server value —
        // the optimistic local value is now wrong, and because a stale write is
        // superseded rather than rejected, nothing else corrects it until an
        // unrelated focus/online resync. Detect the loss from the returned row and
        // re-pull server truth at once, the same prompt correction the old
        // version-conflict path gave via onPermanentReject.
        if (!error && data) {
          const serverRow = mapItemState(data as ItemStateRow);
          // Our write fully landed only if, for every field we sent, BOTH the
          // value AND its timestamp match what we sent (the server echoes our
          // `at` when we win). A field that lost on value, OR one whose boolean
          // already matched but lost on the LWW clock (an older replay of the same
          // value), leaves the local store stale — a wrong value, or a stale `*At`
          // that skews the TTL window and library ordering. Either way, re-pull.
          const lostFields = (Object.entries(changed) as [ItemStateField, { value: boolean; at: number }][])
            .filter(([f, c]) => serverRow[f] !== c.value || serverRow[`${f}At`] !== c.at)
            .map(([f]) => f);
          if (lostFields.length) {
            // Our write lost LWW on at least one field, so the local store holds a
            // stale value the server-read may not reflect. Flag a re-pull (onDrained
            // runs it once the entry is no longer pending) to adopt the winner — its
            // newer `<f>At` wins the store's per-field LWW hydrate.
            this.lwwLossPending = true;
            // …and drop the lost fields from any in-flight read's during-read note,
            // so the parked snapshot's reconcile adopts the server winner for them
            // instead of the overlay re-applying the stale local value (the overlay
            // exists only to win ties / null-clock upgrades, never a real loss). A
            // later write to the same field re-adds it to the note via the sink, so
            // lose→toggle→win keeps the re-won value.
            const note = this.hydrationWrittenChanges?.get(id);
            if (note) for (const f of lostFields) delete note[f];
          }
        }
        // Only a KNOWN-permanent error (lost visibility) drops the write; a
        // 429/5xx hiccup (or a thrown/network error) stays queued and retries, so
        // a short outage can't roll back the user's action.
        return { ok: !error, permanent: isPermanentWriteError(error) };
      },
      localStorageOutboxPersistence(`${stateKey}${OUTBOX_SUFFIX}`),
      () => {
        // Default to online unless the platform explicitly reports offline (some
        // runtimes expose `navigator` without a boolean `onLine`).
        const online = globalThis.navigator?.onLine;
        return typeof online === 'boolean' ? online : true;
      },
      (ids) => {
        // Some writes were permanently rejected (lost visibility) — drop our
        // memoized hydration so the next read re-pulls server truth and corrects
        // the local store. The item is gone, so don't let a read in flight protect
        // it as a brand-new row: forget any during-read write note for it, letting
        // hydrate drop the now-absent local row.
        for (const id of ids) this.hydrationWrittenChanges?.delete(id);
        this.hydration = null;
        // Swallow rejection: ensureHydrated re-throws after clearing the memo,
        // so a failing correction re-pull (e.g. the device just went offline)
        // would otherwise be an unhandled rejection. The next read retries.
        void this.ensureHydrated().catch(() => {});
      },
      () => {
        // A queued write committed server-side. The list self-heals via the
        // local store overlay, but the per-feed unread-count badge reads a
        // server-only count (getFeedUnreadCounts) that was refetched
        // optimistically before the write landed — poke subscribers so the
        // feed-invalidation hook re-invalidates and the badge re-reads the now-
        // correct count.
        this.stateStore.notifySynced();
        // A write lost LWW this drain — its entry is now cleared, so re-pull
        // server truth to replace the stale optimistic value with the winner.
        if (this.lwwLossPending) {
          this.lwwLossPending = false;
          this.hydration = null;
          // Swallow rejection — same reasoning as the permanent-reject re-pull
          // above; the memo is cleared so the next read retries.
          void this.ensureHydrated().catch(() => {});
        }
      },
    );
    this.stateStore.setMutationSink((id, changed, at) => {
      // The store already applied this write optimistically with its action time
      // on every touched field, so the hydrate's per-field LWW preserves it. While
      // a read is in flight, note the write's changed fields (unioned) so a write
      // that also drains before the read returns can still overlay them onto a
      // tied server row, and so a brand-new row that raced the read isn't dropped
      // as "absent" (see applyHydration).
      const note = this.hydrationWrittenChanges;
      if (note) note.set(id, { ...note.get(id), ...changed });
      this.outbox.enqueue(id, changed, at);
    });
    // Kick off item_state hydration at boot so the library routes (/pinned,
    // /favorites, …), which derive their ids from the store, populate even when
    // no feed view has run yet. ensureHydrated is memoized; when the rows land
    // the store emits and those views refetch with real ids.
    void this.ensureHydrated().catch(() => {});

    // Replay anything queued in a prior session now, and again when connectivity
    // returns. A queued write carries its own action time, so per-field
    // last-write-wins on the server resolves it against any change another device
    // made in the meantime — no base version to resolve first.
    void this.outbox.flush();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => void this.outbox.flush());
      // Flush the moment the app might be about to lose the ability to send — any
      // backgrounding, teardown, OR loss of focus — so a triage toggle made right
      // before leaving (mark done / pin, then leave) is pushed out now instead of
      // stranded in the outbox until the next boot. This applies to ALL queued
      // writes uniformly, not just pins. `flushForUnload` (not the coalescing
      // `flush`) is used so writes queued behind an in-flight slow write still
      // start — each send is a keepalive fetch (see supabaseFetch), so it
      // completes as the page unloads. The handler is idempotent and no-ops on an
      // empty queue, so registering several overlapping signals is safe:
      //   - `visibilitychange`→hidden: tab switch, minimize, mobile app-background,
      //     and (unlike `beforeunload`) tab close;
      //   - `pagehide`: the bfcache / navigation teardown path;
      //   - `freeze` (Page Lifecycle): the tab being frozen after backgrounding,
      //     the last callback before the page may be discarded;
      //   - `blur` on the window: losing FOCUS without going hidden — e.g. a
      //     desktop OS-level app switch (Cmd/Alt-Tab) leaves the tab "visible" so
      //     the two events above never fire, yet the OS may still reclaim the
      //     backgrounded browser. This is the focus-loss case the others miss.
      const flushForUnload = () => this.outbox.flushForUnload();
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') flushForUnload();
        });
        // `freeze` fires on the Document (Page Lifecycle API); harmless where
        // unsupported (the listener simply never fires).
        document.addEventListener('freeze', flushForUnload);
      }
      window.addEventListener('pagehide', flushForUnload);
      window.addEventListener('blur', flushForUnload);
    }
  }

  // --- helpers --------------------------------------------------------------

  private unwrap<T>(res: { data: T | null; error: unknown; status?: number }): T {
    if (res.error) {
      // Preserve the HTTP status + PostgREST code on the thrown error so the
      // retry policy can stop a 4xx/5xx (e.g. an expired-token 401) instead of
      // treating it as a transient, retriable network blip. See toRequestError.
      throw toRequestError(res);
    }
    // Preserve null: maybeSingle() returns { data: null } for a missing/
    // unauthorized row, and getItem/getFeed rely on that null to short-circuit.
    // PostgREST list selects return [] (never null), so array callers are
    // unaffected.
    return res.data as T;
  }

  /** Run an `items` read with the full ITEM_COLS. `build(cols)` returns the
   * PostgREST query for the column projection; a runtime column string makes
   * PostgREST infer GenericStringError for the row, so unwrap<T> casts back to
   * the mapped ItemRow shape. */
  private async selectItemRows<T>(
    build: (cols: string) => PromiseLike<{ data: unknown; error: unknown; status?: number }>,
  ): Promise<T> {
    return this.unwrap<T>(
      (await build(ITEM_COLS)) as { data: T | null; error: unknown; status?: number },
    );
  }

  /** Run a `feeds_public` read with the full FEED_COLS. Mirrors
   * {@link selectItemRows}. */
  private async selectFeedRows<T>(
    build: (cols: string) => PromiseLike<{ data: unknown; error: unknown; status?: number }>,
  ): Promise<T> {
    return this.unwrap<T>(
      (await build(FEED_COLS)) as { data: T | null; error: unknown; status?: number },
    );
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
   * last-good (localStorage) state. An offline edit just replays from the outbox
   * on reconnect carrying its own action time, so per-field last-write-wins
   * resolves it against any newer change without needing this read first.
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
    // The store hydrate reconciles each field by last-write-wins on its `<f>At`
    // clock (so a just-made local write with a newer clock survives a pre-write
    // server row), then overlays the still-pending changed FIELDS — keeping local
    // for them regardless of the clock compare, which covers ms-`at` ties and
    // rows upgraded from a client that persisted `null` clocks on cleared false
    // fields. The pending map's KEYS also gate which server-absent local rows to
    // keep. Snapshot the outbox pending CHANGES at the read's START so an entry
    // that resolves and clears mid-read still carries its fields to overlay (its
    // `at` may tie the parked server row, which strict-`>` LWW would resolve to
    // the stale server value, and the outbox is empty so no loss re-pull fixes
    // it)…
    const startPending = new Map(this.outbox.pendingChanges());
    // …PLUS every write made WHILE the read is in flight (it may enqueue and drain
    // — leaving the outbox — entirely within the read window, so it shows in
    // neither the start nor end pending set, yet it must still overlay its fields
    // and protect its brand-new row). A permanent reject removes its id (above).
    const writtenDuringRead = new Map<ItemId, ChangedFields>();
    const prevWritten = this.hydrationWrittenChanges;
    this.hydrationWrittenChanges = writtenDuringRead;
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
    //
    // Read the FULL set in KEYSET pages (by item_id): PostgREST truncates a
    // single response at its row cap, and a truncated read would make `hydrate`
    // mistake every row past the cap for a genuinely-absent (stale) one and drop
    // its local pin/favorite/done — resurfacing swept items on a large account.
    // Keyset (not offset `.range()`) so a row inserted by another device between
    // two page reads can't shift a window and skip an already-existing row. A
    // page shorter than ITEM_STATE_PAGE is the last one. Any page read failing
    // throws, so a partial set is never applied (the store keeps last-good).
    const rows: ItemStateRow[] = [];
    let afterId: string | null = null;
    try {
      for (;;) {
        let q = this.sb
          .from('item_state')
          .select(ITEM_STATE_COLS)
          .order('item_id', { ascending: true })
          .limit(ITEM_STATE_PAGE)
          .not('item_id', 'eq', cacheBustUuid());
        // First page has no lower bound; later pages resume strictly after the last
        // id seen (a uuid sentinel for "before all rows" would be an invalid-uuid
        // cast, so omit the filter rather than seed one).
        if (afterId !== null) q = q.gt('item_id', afterId);
        const page = this.unwrap<ItemStateRow[]>(await q);
        rows.push(...page);
        if (page.length < ITEM_STATE_PAGE) break;
        afterId = page[page.length - 1].item_id;
      }
    } finally {
      this.hydrationWrittenChanges = prevWritten;
    }
    // Build the pending map hydrate uses to (a) overlay still-pending changed
    // FIELDS and (b) protect server-absent local rows. Union the fields across
    // all three sources — pending at the read's start, written during the read,
    // and still queued now — so a write that drained mid-read still overlays its
    // fields onto a tied server row (an LWW loss is instead corrected by the
    // lwwLossPending re-pull, whose winner carries a newer clock). Each source's
    // KEYS protect a brand-new row from being dropped as absent.
    const pending = new Map<ItemId, ChangedFields>();
    const fold = (id: ItemId, ch: ChangedFields) =>
      pending.set(id, { ...pending.get(id), ...ch });
    for (const [id, ch] of startPending) fold(id, ch);
    for (const [id, ch] of writtenDuringRead) fold(id, ch);
    for (const [id, ch] of this.outbox.pendingChanges()) fold(id, ch);
    this.stateStore.hydrate(
      rows.map((r) => [r.item_id, mapItemState(r)] as [ItemId, ItemState]),
      pending,
    );
    // A live read landed: from now on a feed/library read has server-confirmed
    // last-good state to overlay, so it never needs to BLOCK on a re-pull (even
    // one that hangs) — see ensureHydratedForRead.
    this.hydratedOnce = true;
    this.lastSyncedAt = Date.now();
  }

  /** Epoch ms of the last successful server item_state pull, or null until the
   * first one lands (see {@link DataSource.getLastSyncedAt}). */
  /** `/debug` feed-read probe (see DataSource.debugFeedProbe): runs the exact
   * grouped windowed home read outside the query cache and reports raw vs
   * resolved row counts plus the per-feed split, then a flat first page for
   * comparison — so a phone with no devtools can show where an empty grouped
   * view lost its rows (transit vs feed-metadata resolution vs rendering). */
  async debugFeedProbe(
    sort: ItemSort = 'newest',
    folder: string | null = null,
  ): Promise<FeedProbeResult> {
    const t0 = Date.now();
    const out: FeedProbeResult = {
      groupedMs: 0,
      groupedRawRows: null,
      groupedResolvedRows: 0,
      perFeed: [],
      flatResolvedRows: 0,
    };
    try {
      await this.ensureHydratedForRead();
      const rows = this.unwrap<Array<ItemRow>>(
        await this.sb.rpc('feed_items', {
          p_scope: folder != null ? 'folder' : 'home',
          p_folder: folder,
          p_feed_id: null,
          p_limit: GROUPED_WINDOW_ROW_CAP,
          p_offset: 0,
          p_sort: sort,
          p_group_by_feed: true,
        }),
      );
      out.groupedRawRows = rows.length;
      // Same row-shape guard as feedView: a stale/mismatched backend returning
      // an unexpected shape must surface as the probe's Error row, not be
      // miscounted as resolved rows or feed-metadata drops.
      const malformed = rows.find((r) => r == null || typeof r.id !== 'string');
      if (malformed !== undefined) {
        throw new Error('feed_items returned rows missing expected item fields.');
      }
      const items = await this.resolveFeedItems(rows);
      out.groupedResolvedRows = items.length;
      const per = new Map<string, number>();
      for (const fi of items) {
        per.set(fi.feed.title, (per.get(fi.feed.title) ?? 0) + 1);
      }
      out.perFeed = [...per].map(([title, n]) => ({ title, rows: n }));
      const flat =
        folder != null
          ? await this.getFolderItems(folder, { sort })
          : await this.getHomeItems({ sort });
      out.flatResolvedRows = flat.items.length;
    } catch (err) {
      out.error = err instanceof Error ? err.message : String(err);
    }
    out.groupedMs = Date.now() - t0;
    return out;
  }

  getLastSyncedAt(): number | null {
    return this.lastSyncedAt;
  }

  // --- newshacker dismissal mirror ------------------------------------------

  /** Whether this account has a newshacker link, and whether the backend even
   * supports it. `supported` is true ONLY on a successful RPC response, so a
   * backend that predates the 0050 RPC (PGRST202) — or any error — reports
   * `supported: false`, and the Settings section hides rather than offering a
   * control whose RPC would 404 (guardrail #11). The mirror also stays off. */
  async getNewshackerLink(): Promise<{ linked: boolean; supported: boolean }> {
    try {
      const { data, error } = await this.sb.rpc('newshacker_link_status');
      if (error) return { linked: false, supported: false };
      return { linked: data === true, supported: true };
    } catch {
      return { linked: false, supported: false };
    }
  }

  async setNewshackerToken(token: string): Promise<void> {
    const { error } = await this.sb.rpc('set_newshacker_token', {
      p_token: token,
    });
    if (error) throw toRequestError({ error });
  }

  async clearNewshackerLink(): Promise<void> {
    const { error } = await this.sb.rpc('clear_newshacker_link');
    if (error) throw toRequestError({ error });
  }

  /** Fire-and-forget the mirror to newshacker. Swallows every failure (signed
   * out, function not deployed, unlinked, newshacker down): the mirror is
   * additive and the local state is authoritative. The Done list rides the
   * legacy `entries` key so an older, not-yet-redeployed `newshacker-sync`
   * function (which only reads `entries`) still mirrors dismissals; the new
   * `pinned` key is simply ignored there until it's redeployed. */
  async syncNewshackerState(payload: MirrorPayload): Promise<void> {
    if (payload.done.length === 0 && payload.pinned.length === 0) return;
    try {
      await this.sb.functions.invoke('newshacker-sync', {
        body: { entries: payload.done, pinned: payload.pinned },
      });
    } catch {
      // best-effort; nothing to surface.
    }
  }

  /** Reverse sync: pull newshacker's own Done + Pinned lists (the
   * `newshacker-sync` GET branch applies them to item_state server-side) and, if
   * anything landed, re-hydrate so the local store + feed views reflect it.
   * Swallows every failure (signed out, function/RPC not deployed, unlinked,
   * newshacker down); the local state stays authoritative. The re-hydrate goes
   * through the store's `hydrate` path, which never fires the mutation mirror, so
   * a pulled Done/pin is not echoed back out to newshacker.
   *
   * `ok` passes through the Edge Function's consulted-newshacker signal
   * verbatim when present (false = the backend couldn't reach newshacker or
   * couldn't apply — see DataSource.pullNewshackerState); undefined on a
   * not-yet-redeployed backend that doesn't send it. */
  async pullNewshackerState(): Promise<{
    linked: boolean;
    applied: number;
    ok?: boolean;
  }> {
    let linked = false;
    let applied = 0;
    let ok: boolean | undefined;
    try {
      const { data, error } = await this.sb.functions.invoke('newshacker-sync', {
        method: 'GET',
      });
      if (error) return { linked: false, applied: 0, ok: false };
      const d = (data ?? {}) as { linked?: unknown; applied?: unknown; ok?: unknown };
      linked = d.linked === true;
      applied = typeof d.applied === 'number' && d.applied > 0 ? d.applied : 0;
      if (typeof d.ok === 'boolean') ok = d.ok;
    } catch {
      return { linked: false, applied: 0, ok: false };
    }
    if (applied > 0) {
      // force: a focus-time resync (useStateSync) may already be in flight, and
      // it can have read item_state BEFORE this pull applied the changes —
      // coalescing onto it would clear the "syncing" spinner without the row
      // actually graying/pinning until the next event. force chains a fresh read.
      await this.resyncState(true).catch(() => {
        // The changes are already in item_state server-side; a failed re-hydrate
        // just means the local view catches up on the next read/resync.
      });
    }
    return { linked, applied, ok };
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

  /**
   * Hydration for a feed/library read. item_state hydration is **best-effort**:
   * `feed_items` already filters Done/Hidden server-side, and the local store
   * carries last-good pin/opened/done flags (loaded synchronously from
   * localStorage at boot), so a read does NOT need a fresh hydration to render
   * the right rows — it only refines per-row flags. Therefore a read must never
   * **block** on hydration once there's state to overlay.
   *
   * Before, feedView/getItemsByIds `await`ed the FULL hydration before returning
   * any row. That hydration reads the entire `item_state` table in serialized
   * keyset pages, so on a large account (many pages) — or when the NetworkOnly
   * read stalls (a connection that's established but never answers, which the
   * service worker can't time out) — the boot read could take a very long time
   * or never settle, holding the home feed query in its initial loading state.
   * The symptom is the whole feed stuck on its loading skeletons, surviving
   * reload and pull-to-refresh because every cold boot re-runs the same blocking
   * read. (The earlier fix added a redundant read timeout and was reverted for
   * regressing offline detection; this fixes it at the right layer instead —
   * the read still flows through the connectivity-tracked, 8s-bounded
   * `supabaseFetch`, so Down/Offline detection is unchanged. We just stop
   * gating rows on it.)
   *
   * So: kick hydration (memoized — a no-op if one is in flight or already done),
   * and only WAIT on it when there's nothing to overlay yet — a brand-new or
   * cache-purged device whose store is still empty and has never hydrated — so
   * its first paint isn't all default flags. Even then the wait is BOUNDED
   * ({@link COLD_HYDRATE_WAIT_MS}): a cold device's read can be the very
   * slow/paged/stalled one this fix targets, so an unbounded wait would just move
   * the stuck-skeletons bug to first-time/purged users. Past the bound (or once
   * there's last-good state) the read returns immediately and lets the background
   * hydration's store emit trigger a refetch (useFeedInvalidation) / library
   * re-read to refine flags, exactly as a focus/visibility resync already does.
   * The hydration itself keeps running unbounded in the background — only the
   * read's WAIT on it is capped, so connectivity/Down detection is untouched.
   */
  private async ensureHydratedForRead(): Promise<void> {
    const hydration = this.ensureHydrated();
    // Swallow rejection in all paths so a failed background re-pull isn't an
    // unhandled rejection.
    const settle = hydration.catch(() => {});
    if (this.hydratedOnce || this.stateStore.hasEntries()) {
      // Last-good state is available; don't let a fresh/in-flight (possibly slow
      // or hung) hydration block the read.
      void settle;
      return;
    }
    // Cold store: wait briefly for the first hydration to avoid a default-flag
    // flash, but never longer than the bound — so a stalled cold read can't
    // strand the device on skeletons.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, COLD_HYDRATE_WAIT_MS);
    });
    try {
      await Promise.race([settle, bound]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Fetch item rows for an id list in bounded `in (…)` batches (keeps the
   * request URL within limits for large library buckets). Optionally restricts
   * to a feed set. Order is not guaranteed — callers re-sort. */
  private async fetchItemRowsByIds(
    ids: ItemId[],
    feedIds?: FeedId[],
  ): Promise<ItemRow[]> {
    const batches = await Promise.all(
      chunk(ids, ID_LOOKUP_CHUNK).map(async (c) =>
        this.selectItemRows<ItemRow[]>((cols) => {
          let q = this.sb.from('items').select(cols).in('id', c);
          if (feedIds) q = q.in('feed_id', feedIds);
          return q;
        }),
      ),
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
          this.selectFeedRows<FeedPublicRow[]>((cols) =>
            this.sb.from('feeds_public').select(cols).in('id', c),
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
    // Fail BEFORE touching the cache: feedCache entries are permanent for the
    // session (only refresh/delete/rename evict), and `missing`-only fetching
    // never retries an id it already cached. Caching the raw titles when the
    // override read failed (a 401 mid-token-refresh, a 5xx blip) would strip
    // every rename for the rest of the session; throwing lets the caller's
    // query error/retry machinery rerun the whole lookup instead.
    for (const result of subBatches) {
      if (result.error) {
        throw new Error(`loading title overrides failed: ${result.error.message}`);
      }
    }
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
    // Group-by-feed read: one deep page that carries every section in full.
    // The client sends NO per-feed fetch cap — the server decides how much of
    // each feed to return (today: the feed's whole listable set, its freshness
    // window ∪ floor ∪ pins; any future cap is a server-side decision) and the
    // client accepts everything that comes back. Sections are windowed for
    // DISPLAY in ItemList; depth comes from the per-section "More" revealing
    // already-fetched rows. We ask for up to the PostgREST row cap; if an
    // account overflows it the read still pages by row cursor so the later
    // feed-sections aren't silently dropped — the bottom "More" loads the next
    // batch of sections.
    const grouped = opts?.groupByFeed ?? false;
    const limit = grouped ? GROUPED_WINDOW_ROW_CAP : opts?.limit ?? PAGE_SIZE;
    const offset = decodeCursor(opts?.cursor);

    // Hydrate item_state so the UI's per-row pin/opened affordances and
    // overlayLocalState reflect server truth — but DON'T block the feed on it
    // once there's last-good state to overlay. item_state hydration is
    // best-effort: feed_items filters Done/Hidden server-side and the store
    // carries last-good flags from localStorage, so it only refines per-row
    // flags. Blocking here on a slow/large (paged) or hung NetworkOnly read is
    // what used to strand the whole feed on its loading skeletons, surviving
    // reload and pull-to-refresh. See ensureHydratedForRead.
    await this.ensureHydratedForRead();
    const rows = this.unwrap<Array<ItemRow>>(
      await this.sb.rpc('feed_items', {
        ...args,
        p_limit: limit,
        p_offset: offset,
        // Body ordering/sectioning is applied server-side so it holds across
        // pages (0016_feed_items_sort_group.sql). Pinned stay oldest-first on top.
        p_sort: opts?.sort ?? 'newest',
        p_group_by_feed: grouped,
        // No p_per_feed_limit: the client never dictates a per-feed fetch cap.
        // The RPC's own default (null → uncapped) applies, so the server owns
        // the decision — a future cap is a migration changing that default,
        // deployable without any client change. Old cached clients that still
        // send the arg keep resolving against the same function (it retains
        // the parameter), and the 7-arg payload here resolves against every
        // deployed feed_items version.
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
    // 200 while the backend is actually down — the 8s read cap sits past the
    // SW's 6s cache-fallback window precisely so a slow read still gets served
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
    // The grouped read is normally a single deep page (the per-section "More"
    // reveals its already-fetched depth), but if it filled the row cap there
    // are more rows than fit — keep a cursor so the bottom "More" can load the
    // next batch rather than dropping them.
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
   * dropping here is redundant for display; worse, ItemList's per-section
   * "More" reveals from the fetched run, and dropping a row here while its
   * optimistic Done/Hidden is still outbox-pending would transiently shrink
   * that run even though the server returned the row. Keeping the raw server
   * rows means the fetched set reflects what the server actually returned; the
   * dismissed row is filtered from the rendered list by ItemList and
   * self-heals on the next clean refetch. (The server already sections pinned
   * within each feed, so no lift is needed.)
   */
  private overlayLocalState(items: ItemRow[], groupByFeed: boolean): ItemRow[] {
    if (groupByFeed) return items;
    const pinned: Array<{ row: ItemRow; at: number }> = [];
    const body: ItemRow[] = [];
    for (const row of items) {
      const st = this.stateStore.get(row.id);
      // A pin is EXEMPT from the Done/Hidden drop — it stays in the feed (and
      // lifts to the top block), matching the server read's pinned branch, which
      // returns a pinned row regardless of Done/Hidden. Without the `!st.pinned`
      // guard a pinned-then-Done row (e.g. one opened on a mark-done-on-open
      // feed) is dropped from the flat river even though the server returned it.
      if (!st.pinned && (st.done || st.hidden)) continue;
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

  /** Item ids whose state write hasn't synced yet (see DataSource). Lets the
   * per-feed unread badge discount a just-applied Sweep/Done that the server-side
   * `feed_unread_counts` above can't see until the outbox drains. */
  pendingItemIds(): ReadonlySet<ItemId> {
    return new Set(this.outbox.pendingIds());
  }

  async getItem(id: ItemId): Promise<FeedItem | null> {
    const row = await this.selectItemRows<ItemRow | null>((cols) =>
      this.sb.from('items').select(cols).eq('id', id).maybeSingle(),
    );
    if (row) {
      const [fi] = await this.resolveFeedItems([row]);
      if (fi) return fi;
    }
    // Shared-link fallback: the caller may not subscribe to this item's feed (nor
    // hold a permanent state on it), so items_select hid the row above. A PUBLIC
    // feed's item is still reachable by its unguessable uuid via get_shared_item
    // (0068) — a capability-by-URL open. Returns display-safe item + feed data,
    // or null for a private/tokenized feed, a genuine miss, or an older backend
    // without the RPC.
    return this.loadSharedItem(id);
  }

  /** Resolve a shared /item/<id> link via the `get_shared_item` RPC (0068) for an
   * item the caller can't see under RLS. Degrades any error — including an older
   * backend missing the function (PGRST202) — to null so the reader shows its
   * miss state; the unguessable id means there's nothing to retry-leak. */
  private async loadSharedItem(id: ItemId): Promise<FeedItem | null> {
    const { data, error, status } = await this.sb.rpc('get_shared_item', {
      p_item_id: id,
    });
    if (error) {
      // Swallow ONLY the expected old-backend case — the function doesn't exist
      // yet (PGRST202, or a 404) — as "no shared item", so the reader shows its
      // normal miss state. Any OTHER error (a transient PostgREST/DB blip) throws
      // like the direct item read, so React Query retries and the reader surfaces
      // a real error instead of a false "article missing" the caller can't retry.
      const code = (error as { code?: string } | null)?.code;
      if (code === 'PGRST202' || status === 404) return null;
      throw toRequestError({ error, status });
    }
    const row = (Array.isArray(data) ? data[0] : data) as
      | SharedItemRow
      | null
      | undefined;
    return row ? mapSharedItem(row) : null;
  }

  async fetchFullText(
    id: ItemId,
    opts?: { signal?: AbortSignal },
  ): Promise<FullTextResult> {
    // Retry a TRANSIENT failure once before giving up, mirroring getSummary: a
    // full-text fetch RESOLVES `unreachable` (a React Query success, not a
    // throw), so the client retry policy never engages — the retry has to live
    // here. `unreachable` (a network blip / 5xx on invoke, or the server's own
    // unreachable envelope) may clear on the next attempt; terminal outcomes
    // (ok/empty/auth) return immediately since re-fetching can't change them.
    // A CANCELLED fetch (the caller's signal aborted — the query was superseded
    // or the foreground-resume path cancelled a frozen one) is not retried: the
    // caller no longer wants this response, so a second attempt only spends a
    // request whose result gets discarded.
    let result = await this.invokeFullTextOnce(id, opts?.signal);
    for (
      let attempt = 1;
      attempt < FULLTEXT_FETCH_ATTEMPTS &&
      result.status === 'unreachable' &&
      !opts?.signal?.aborted;
      attempt++
    ) {
      await new Promise((r) => setTimeout(r, this.fullTextRetryDelayMs));
      result = await this.invokeFullTextOnce(id, opts?.signal);
    }
    return result;
  }

  /** Invoke a summary/full-text Edge Function with the {@link invokeTimeoutMs}
   * ceiling, so the caller can degrade to a retryable `unreachable` instead of
   * hanging forever (see INVOKE_TIMEOUT_MS — a fetch frozen by an app suspension
   * otherwise wedges, via React Query's dedupe, every later warm retry and the
   * reader's own open). At the ceiling the underlying request is ABORTED (the
   * forwarded signal), not just abandoned — an orphaned transport would keep
   * holding a browser connection slot / the radio, and the retry loop would
   * stack more of them (Codex P2 on #506). The race resolving `'timeout'` is
   * the belt-and-braces on top: even a transport stuck so hard it never
   * observes the abort still can't hang the query. A response lost to the
   * abort is fine — its result is cached server-side, so the next retry is a
   * cheap hit.
   *
   * `callerSignal` (React Query's per-fetch signal, threaded through from the
   * queryFn) composes with the timeout: cancelling the query — notably the
   * foreground-resume path that cancels a fetch left frozen by an app
   * suspension — aborts the underlying invoke too, freeing the transport
   * immediately instead of leaving an orphan running to the timeout while the
   * fresh warm starts a second request (Codex P2, round 2 on #506). */
  private invokeWithTimeout(
    fn: string,
    body: Record<string, unknown>,
    callerSignal?: AbortSignal,
  ): Promise<{ data: unknown; error: unknown } | 'timeout'> {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener('abort', forwardAbort, { once: true });
    }
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(
          new DOMException('Edge Function invoke timed out', 'TimeoutError'),
        );
        resolve('timeout');
      }, this.invokeTimeoutMs);
    });
    return Promise.race([
      this.sb.functions.invoke(fn, { body, signal: controller.signal }),
      timeout,
    ]).finally(() => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forwardAbort);
    });
  }

  /** One attempt of the full-text fetch — the invoke + status/error mapping.
   * {@link fetchFullText} wraps this in a bounded transient-failure retry. */
  private async invokeFullTextOnce(
    id: ItemId,
    signal?: AbortSignal,
  ): Promise<FullTextResult> {
    const invoked = await this.invokeWithTimeout('fulltext', { itemId: id }, signal);
    if (invoked === 'timeout') {
      // Transport hung past the ceiling — degrade to the retryable
      // `unreachable`, same as any other invoke failure below.
      return { status: 'unreachable', contentHtml: null };
    }
    const { data, error } = invoked;
    if (error) {
      // A 404 is TERMINAL, not transient — the `fulltext` function isn't
      // deployed yet, or it ran and RLS hid the item; neither improves by
      // retrying. Map it to a plain `empty` (terminal in fullTextStaleTime) so
      // the reader falls back to the feed body and STOPS re-invoking a
      // capability it can't reach, rather than retrying every open during a
      // deploy gap. (Same reasoning as getSummary's 404 handling.)
      if (
        error instanceof FunctionsHttpError &&
        (error.context as Response | undefined)?.status === 404
      ) {
        return { status: 'empty', contentHtml: null };
      }
      // Any other invoke failure (signed-out, item not visible, network, 5xx)
      // degrades to "unreachable" so the reader falls back to the feed body and
      // re-checks on the next open — reading mode is a progressive enhancement.
      return { status: 'unreachable', contentHtml: null };
    }
    const rec = data as
      | {
          status?: string;
          contentHtml?: string | null;
          retryable?: boolean;
          viaFallback?: boolean;
        }
      | null;
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
      // Additive flag (e.g. an allowlist denial on an `empty`): keeps the result
      // retryable so a later server-side change re-checks instead of caching it.
      // Only present when true, so non-retryable results keep their plain shape.
      ...(rec?.retryable === true ? { retryable: true } : {}),
      // Provenance: rides along only with an `ok` body that came from the
      // bot-block fallback fetch, so the reader can label it "via fallback".
      // Additive (omitted otherwise) — a missing/older backend reads as direct.
      ...(status === 'ok' && rec?.viaFallback === true ? { viaFallback: true } : {}),
    };
  }

  async getSummary(
    id: ItemId,
    opts?: { signal?: AbortSignal },
  ): Promise<SummaryResult> {
    // Retry a TRANSIENT failure at least once before giving up. A transient
    // outcome is a statusless network blip / 5xx on invoke, or the server's own
    // `unreachable` envelope (a Gemini or allowlist-read hiccup) — none of which
    // improve the summary on this attempt but may on the next. React Query can't
    // do this retry for us: getSummary RESOLVES `unreachable` (a query SUCCESS,
    // not a throw), so the client retry policy (queryRetry.ts, which only retries
    // THROWN statusless errors) never engages — so the retry lives here. Terminal
    // outcomes (ok/empty/unavailable) return immediately; `unavailable` (the key
    // isn't set) won't flip in a few hundred ms, so it isn't retried either.
    // A CANCELLED fetch (the caller's signal aborted) is not retried — see
    // fetchFullText.
    let result = await this.invokeSummaryOnce(id, opts?.signal);
    for (
      let attempt = 1;
      attempt < SUMMARY_FETCH_ATTEMPTS &&
      result.status === 'unreachable' &&
      !opts?.signal?.aborted;
      attempt++
    ) {
      await new Promise((r) => setTimeout(r, this.summaryRetryDelayMs));
      result = await this.invokeSummaryOnce(id, opts?.signal);
    }
    return result;
  }

  /** One attempt of the summary fetch — the invoke + status/error mapping.
   * {@link getSummary} wraps this in a bounded transient-failure retry. */
  private async invokeSummaryOnce(
    id: ItemId,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const invoked = await this.invokeWithTimeout('summary', { itemId: id }, signal);
    if (invoked === 'timeout') {
      // Transport hung past the ceiling — degrade to the retryable
      // `unreachable`, same as any other invoke failure below.
      return { status: 'unreachable', summary: null };
    }
    const { data, error } = invoked;
    if (error) {
      // A 404 is TERMINAL, not transient — either the `summary` function isn't
      // deployed yet (the frontend auto-deploys ahead of the manual Edge Function
      // deploy; guardrail #11), or the function ran and RLS hid the item. Neither
      // improves by retrying, so map it to a non-retryable `empty` (terminal in
      // `summaryStaleTime`) — the reader shows no card and STOPS re-invoking a
      // capability it can't reach, rather than hammering every pinned-article
      // mount/refocus until the backend catches up. (Items viewed during the
      // deploy gap stay cardless until the query cache evicts — an accepted trade
      // vs. the retry storm; new pins after deploy work normally.)
      if (error instanceof FunctionsHttpError &&
          (error.context as Response | undefined)?.status === 404) {
        return { status: 'empty', summary: null };
      }
      // Any other invoke failure (network, 5xx, signed-out) degrades to the
      // retryable "unreachable" so the reader shows no card but re-checks on the
      // next mount/reconnect — summaries are a progressive enhancement.
      return { status: 'unreachable', summary: null };
    }
    const rec = data as
      | { status?: string; summary?: string | null; retryable?: boolean; site?: string | null }
      | null;
    const status: SummaryStatus =
      rec?.status === 'ok' ||
      rec?.status === 'empty' ||
      rec?.status === 'unavailable' ||
      rec?.status === 'unreachable' ||
      rec?.status === 'blocked'
        ? rec.status
        : 'unreachable';
    return {
      status,
      summary: status === 'ok' ? (rec?.summary ?? null) : null,
      // Additive flag (allowlist denial on `empty`, or not-configured
      // `unavailable`): keeps the result retryable so a later server-side change
      // re-checks instead of caching it. Only present when true.
      ...(rec?.retryable === true ? { retryable: true } : {}),
      // `blocked` carries the publisher host for the "Summary blocked by {site}"
      // card (null when the item had no URL). Only threaded on that status.
      ...(status === 'blocked' ? { site: rec?.site ?? null } : {}),
    };
  }

  async getItemsByIds(ids: ItemId[]): Promise<FeedItem[]> {
    // Ensure state is hydrated even on the empty-ids path so a direct cold boot
    // into a library route triggers the item_state fetch (which then repopulates
    // the store and re-derives the ids), rather than silently returning empty.
    // As with feedView, only BLOCK on the first hydration (empty store, brand-new
    // device); once there's last-good state to overlay, kick it in the background
    // so a slow/large/hung item_state read can't strand the library on its
    // skeletons either — the background hydration's store emit re-derives the ids
    // and refetches. See ensureHydratedForRead.
    await this.ensureHydratedForRead();
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
    const titleRows = await this.selectItemRows<ItemRow[]>((cols) =>
      this.sb
        .from('items')
        .select(cols)
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
          this.selectItemRows<ItemRow[]>((cols) =>
            this.sb
              .from('items')
              .select(cols)
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
      const row = await this.selectFeedRows<FeedPublicRow | null>((cols) =>
        this.sb.from('feeds_public').select(cols).eq('id', feedId).maybeSingle(),
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
   * The RPC caps the account at 100 feeds server-side (0059; idempotent
   * re-subscribes exempt) — bounding abuse/cost and keeping the group-by-feed
   * read's opening page under the PostgREST 1000-row cap (100 × PER_FEED_WINDOW).
   * A subscribe past the cap comes back as SQLSTATE 53400, mapped below to a
   * typed AddFeedError('feed-limit') so both the Add-a-feed UI and importOpml
   * see the limit. Older backends predating 0059 never raise it. */
  private async subscribeOnly(feedUrl: string, folder?: string | null): Promise<Feed> {
    let rows: FeedPublicRow[];
    try {
      rows = this.unwrap<FeedPublicRow[]>(
        await this.sb.rpc('subscribe_to_feed', {
          p_url: feedUrl,
          p_folder: folder ?? null,
        }),
      );
    } catch (err) {
      // The server rejects a subscribe past the per-account feed cap with
      // SQLSTATE 53400 (see migration 0059). Map it to a typed AddFeedError so
      // the UI shows the "feed limit reached" copy instead of a generic failure,
      // and importOpml can stop early. Any other error propagates unchanged.
      if ((err as { code?: unknown } | null)?.code === FEED_LIMIT_CODE) {
        throw new AddFeedError('feed-limit', err instanceof Error ? err.message : undefined);
      }
      throw err;
    }
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

  async setOpenOriginal(feedId: FeedId, openOriginal: boolean): Promise<void> {
    // RLS + the column-scoped UPDATE grant (0027) confine this to the caller's
    // own row and the single display column.
    const { error } = await this.sb
      .from('subscriptions')
      .update({ open_original: openOriginal })
      .eq('feed_id', feedId);
    if (error) throw error instanceof Error ? error : new Error(String(error));
  }

  async setOpenMode(feedId: FeedId, mode: OpenMode): Promise<void> {
    // Write BOTH display booleans in a single PATCH so the two flags flip
    // together — a feed is never left with open_original AND open_newshacker both
    // true. RLS + the column-scoped UPDATE grants (0027/0034) confine this to the
    // caller's own row and these two columns.
    const { error } = await this.sb
      .from('subscriptions')
      .update({
        open_original: mode === 'original',
        open_newshacker: mode === 'newshacker',
      })
      .eq('feed_id', feedId);
    if (error) throw error instanceof Error ? error : new Error(String(error));
  }

  async setMarkDoneOnOpen(feedId: FeedId, markDoneOnOpen: boolean): Promise<void> {
    // RLS + the column-scoped UPDATE grant (0037) confine this to the caller's
    // own row and the single display column.
    const { error } = await this.sb
      .from('subscriptions')
      .update({ mark_done_on_open: markDoneOnOpen })
      .eq('feed_id', feedId);
    if (error) throw error instanceof Error ? error : new Error(String(error));
  }

  async setSubscriptionListLayout(
    feedId: FeedId,
    listLayout: ListLayout | null,
  ): Promise<void> {
    // RLS + the column-scoped UPDATE grant (0051) confine this to the caller's
    // own row and the single display column. `null` clears the override (the CHECK
    // constraint permits NULL) so the feed falls back to the app-wide setting.
    const { error } = await this.sb
      .from('subscriptions')
      .update({ list_layout: listLayout })
      .eq('feed_id', feedId);
    if (error) throw error instanceof Error ? error : new Error(String(error));
  }

  /** Synced reading-behavior settings (`user_settings`, 0064; RLS scopes the
   * read to the caller's own row). A backend without the table — the manual
   * `make migrate` hasn't run — is remembered (with expiry, see
   * {@link settingsBackendUnsupported}) and both methods short-circuit, so
   * prefs simply stay device-local until the deploy lands (guardrail #11).
   * Any other read error also resolves null (soft): the sync layer re-tries on
   * the next focus/online reconcile. */
  async getSyncedSettings(): Promise<Partial<SyncedSettings> | null> {
    if (this.settingsBackendUnsupported()) return null;
    const { data, error } = await this.sb
      .from('user_settings')
      .select(USER_SETTINGS_COLS)
      .maybeSingle();
    if (error) {
      if (isMissingTableError(error)) {
        this.syncedSettingsUnsupportedAt = Date.now();
      }
      return null;
    }
    return data ? mapUserSettings(data as UserSettingsRow) : {};
  }

  async setSyncedSettings(patch: Partial<SyncedSettings>): Promise<void> {
    const row: Record<string, unknown> = {};
    if (patch.itemSort !== undefined) row.item_sort = patch.itemSort;
    if (patch.groupByFeed !== undefined) row.group_by_feed = patch.groupByFeed;
    if (patch.hideOnScroll !== undefined) row.hide_on_scroll = patch.hideOnScroll;
    if (patch.showRowFavicon !== undefined) row.show_row_favicon = patch.showRowFavicon;
    if (patch.showGroupFavicon !== undefined) row.show_group_favicon = patch.showGroupFavicon;
    if (patch.hideSportsSpoilers !== undefined) row.hide_sports_spoilers = patch.hideSportsSpoilers;
    if (patch.autoSummarizePinned !== undefined) row.auto_summarize_pinned = patch.autoSummarizePinned;
    if (Object.keys(row).length === 0) return;
    // An unsupported backend REJECTS rather than resolving: a resolved set()
    // is the sync engine's cue to acknowledge the patch as delivered, and a
    // fake ack would strand these values device-local forever — after the
    // manual `make migrate`, local == acked means there is no pending diff
    // left to push (Codex P2 on #494). Rejecting keeps the diff pending, so
    // the first push after the migration lands it for real. The remembered
    // detection short-circuits before the network (free retries) but EXPIRES
    // (settingsBackendUnsupported), so a long-lived tab re-probes and drains
    // its pending settings within minutes of the migration, no reload needed.
    if (this.settingsBackendUnsupported()) {
      throw new Error('user_settings is not deployed on this backend');
    }
    // The payload carries ONLY the changed columns — `user_id` is filled by its
    // `default auth.uid()` (0064) so no identity rides in the request, and the
    // ON CONFLICT (user_id) merge leaves the row's other columns untouched.
    // That per-column write is what makes cross-device conflicts resolve
    // last-write-wins per setting rather than per row.
    //
    // A single-OBJECT payload already gets the DB default for its absent
    // columns (postgrest-js only sends the `columns=` param — where missing
    // keys become NULL — for array payloads; PostgREST builds the INSERT from
    // the object's own keys, so an unlisted column takes its SQL default).
    // `defaultToNull: false` (`Prefer: missing=default`) is belt-and-braces on
    // top: it keeps the `auth.uid()` default in force even if this payload
    // ever becomes an array (Codex P1 on #494).
    const { error } = await this.sb
      .from('user_settings')
      .upsert(row, { onConflict: 'user_id', defaultToNull: false });
    if (error) {
      if (isMissingTableError(error)) {
        this.syncedSettingsUnsupportedAt = Date.now();
      }
      // Missing table or transient (offline/5xx) alike: throw so the sync
      // engine keeps the diff pending — it retries on the next change/online/
      // focus, and post-migration the pending values sync for real.
      throw error instanceof Error ? error : new Error(String((error as { message?: string }).message ?? error));
    }
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
  resyncState(force = false): Promise<void> {
    // Coalesce overlapping calls (a single tab return can fire `focus` AND
    // `visibilitychange`) — but remember the request, because conditions may
    // have changed in a way the in-flight attempt won't reflect. Notably an
    // `online` event can land while a resync started during a connectivity blip
    // is still in flight and doomed to fail; coalescing into it would lose the
    // recovery. So if the in-flight attempt fails, we run a fresh one after.
    if (this.resyncing) {
      if (force) {
        // The caller just applied server-side changes it must see (the
        // newshacker reverse pull). The in-flight read may have STARTED before
        // that write, and a successful coalesced read clears the request without
        // re-reading — so chain a guaranteed-fresh read AFTER the in-flight one
        // instead of coalescing onto it. (When it settles, `this.resyncing` is
        // already null, so the inner call starts a new read.)
        return this.resyncing.then(
          () => this.resyncState(),
          () => this.resyncState(),
        );
      }
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
    // Once the account hits its feed cap every remaining subscribe is doomed, so
    // stop early and count the rest as skipped rather than firing one rejected
    // RPC per entry. A cap error can surface from either branch's subscribe.
    const isCapError = (err: unknown) =>
      err instanceof AddFeedError && err.kind === 'feed-limit';
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      // Google News feeds are restricted to the trusted-user allowlist, enforced
      // server-side in the `discover` Edge Function. importOpml otherwise
      // subscribes directly (no discover step), which would let an OPML import
      // bypass that gate — so route Google News URLs through discover instead.
      // An unlisted caller's entry comes back `blocked` (a thrown AddFeedError)
      // and is skipped; a network/parse failure is skipped too, never fatal to
      // the rest of the import.
      let feed: Feed;
      if (isGoogleNewsFeedUrl(url)) {
        try {
          const [candidate] = await this.discover(url);
          if (!candidate) {
            skipped++;
            continue;
          }
          feed = await this.subscribeOnly(candidate.url);
        } catch (err) {
          if (isCapError(err)) {
            skipped += urls.length - i; // this entry + all remaining
            break;
          }
          skipped++;
          continue;
        }
      } else {
        try {
          feed = await this.subscribeOnly(url); // no per-feed refresh storm
        } catch (err) {
          if (isCapError(err)) {
            skipped += urls.length - i; // this entry + all remaining
            break;
          }
          // A dead URL or transient RPC failure skips this entry only — one bad
          // outline must not abort the rest of the file (entries before it are
          // already committed server-side, and the caller would report nothing).
          skipped++;
          continue;
        }
      }
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
   * Export the caller's subscriptions as OPML. The `export_subscriptions` RPC
   * (0061) returns the feed fetch URL (`feeds.url`) that `feeds_public` withholds
   * from clients, so the export is re-importable into other readers. Exposing
   * `url` (which can embed a pasted per-user token) is a deliberate owner-scoped
   * carve-out: the RPC is scoped to the caller's own `subscriptions`, and to
   * subscribe to a tokenized feed you had to present that URL yourself — so a
   * user only ever gets back tokens they already have (see the migration's
   * safety note). It never emits the separate server-only `secret_url`, so a
   * rare secret-backed feed exports its token-stripped `url` and may not
   * round-trip. Against a backend that predates the RPC (PGRST202)
   * we fall back to the display-safe homepage URL — the older behavior — so a
   * new client keeps working before the manual `make deploy` lands (guardrail
   * #11). Any other RPC error is surfaced to the caller (Export shows a toast).
   */
  async exportOpml(): Promise<string> {
    const { data, error } = await this.sb.rpc('export_subscriptions');
    if (!error && Array.isArray(data)) {
      // `feed_url` is the real fetch URL; `title` is resolved server-side
      // (override → title → site_url) but is null when a never-fetched feed has
      // none of them, so fall back to the same "Untitled feed" the list uses.
      const rows = data as Array<{
        feed_url: string;
        site_url: string | null;
        title: string | null;
      }>;
      const outlines = rows.map((r) => ({
        title: r.title ?? r.site_url ?? 'Untitled feed',
        xmlUrl: r.feed_url,
        htmlUrl: r.site_url,
      }));
      return buildOpml(outlines, { dateCreated: new Date() });
    }
    const err = error as { code?: string; message?: string } | null;
    if (err && err.code !== 'PGRST202') {
      throw error instanceof Error ? error : new Error(err.message ?? String(error));
    }
    // Old backend: the RPC isn't deployed, so emit the homepage URL (all the
    // client can see) rather than the real feed endpoint.
    const subs = await this.loadSubscriptions();
    const outlines = subs.map(({ subscription, feed }) => ({
      title: subscription.titleOverride ?? feed.title,
      xmlUrl: feed.url,
      htmlUrl: feed.siteUrl,
    }));
    return buildOpml(outlines, { dateCreated: new Date() });
  }

  // --- Capabilities & admin -------------------------------------------------

  async getCapabilities(): Promise<Capabilities> {
    const { data, error } = await this.sb.rpc('get_capabilities');
    if (error) {
      // Rethrow (rather than returning a permissive all-false) so React Query
      // retries and keeps the prior cached value for the 5-min staleTime, instead
      // of letting an off-list user issue `fulltext` calls meanwhile.
      const err = error as { code?: string; message?: string };
      throw error instanceof Error ? error : new Error(err.message ?? String(error));
    }
    // `get_capabilities` returns a single-row table → an array of one row.
    const row = (Array.isArray(data) ? data[0] : data) as
      | {
          family?: boolean;
          admin?: boolean;
          allowlist_armed?: boolean;
          can_manage_users?: boolean;
          can_view_subscriptions?: boolean;
          shared_items?: boolean;
        }
      | null
      | undefined;
    return {
      family: row?.family === true,
      admin: row?.admin === true,
      allowlistArmed: row?.allowlist_armed === true,
      canManageUsers: row?.can_manage_users === true,
      canViewSubscriptions: row?.can_view_subscriptions === true,
      sharedItems: row?.shared_items === true,
    };
  }

  async listAllowlist(): Promise<AllowlistEntry[]> {
    const { data, error } = await this.sb.rpc('list_allowlist');
    if (error) throw error instanceof Error ? error : new Error(String(error));
    const rows = (data ?? []) as Array<{
      email: string;
      added_by: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      email: r.email,
      addedBy: r.added_by ?? null,
      createdAt: r.created_at,
    }));
  }

  async addToAllowlist(email: string): Promise<void> {
    const { error } = await this.sb.rpc('add_to_allowlist', { p_email: email });
    if (error) throw error instanceof Error ? error : new Error(String(error));
  }

  async removeFromAllowlist(email: string): Promise<void> {
    const { error } = await this.sb.rpc('remove_from_allowlist', { p_email: email });
    if (error) throw error instanceof Error ? error : new Error(String(error));
  }

  async listFeedStatuses(): Promise<AdminFeedStatus[]> {
    const { data, error } = await this.sb.rpc('admin_list_feeds');
    if (error) throw error instanceof Error ? error : new Error(String(error));
    const rows = (data ?? []) as Array<{
      id: string;
      title: string | null;
      site_url: string | null;
      favicon_url: string | null;
      last_fetched_at: string | null;
      error_count: number | null;
      last_error: string | null;
      paused: boolean | null;
      subscriber_count: number | null;
      sample_item_id: string | null;
      sample_item_title: string | null;
      sample_has_full_content: boolean | null;
      sample_download_status: string | null;
      sample_download_http: number | null;
      sample_download_error: string | null;
      sample_download_robots_rule: string | null;
      sample_download_at: string | null;
    }>;
    return rows.map((r) => {
      const errorCount = r.error_count ?? 0;
      const sample: AdminFeedSampleItem | null = r.sample_item_id
        ? {
            id: r.sample_item_id,
            title: r.sample_item_title,
            hasFullContent: r.sample_has_full_content === true,
            downloadStatus: normalizeDownloadStatus(r.sample_download_status),
            downloadHttpStatus: r.sample_download_http ?? null,
            downloadError: r.sample_download_error ?? null,
            downloadRobotsRule: r.sample_download_robots_rule ?? null,
            downloadAttemptedAt: r.sample_download_at ?? null,
          }
        : null;
      return {
        id: r.id,
        title: r.title ?? r.site_url ?? 'Untitled feed',
        siteUrl: r.site_url,
        faviconUrl: r.favicon_url,
        lastFetchedAt: r.last_fetched_at ?? null,
        errorCount,
        lastError: r.last_error ?? null,
        // A malformed row → null ("unknown"), so the console degrades rather
        // than rendering a bogus control. Present → the flag.
        paused: typeof r.paused === 'boolean' ? r.paused : null,
        // A malformed row → null ("unknown"), not a false 0. A present 0 stays 0.
        subscriberCount:
          typeof r.subscriber_count === 'number' ? r.subscriber_count : null,
        fetchFailed: errorCount > 0,
        parked: errorCount >= PARKED_ERROR_THRESHOLD,
        sample,
      };
    });
  }

  async deleteFeed(feedId: FeedId): Promise<void> {
    const { error } = await this.sb.rpc('admin_delete_feed', { p_feed_id: feedId });
    if (error) throw error instanceof Error ? error : new Error(String(error));
    // The feed (and its items) are gone — drop any cached copy so a later
    // getFeed() doesn't serve the deleted row.
    this.feedCache.clear();
  }

  async setFeedPaused(feedId: FeedId, paused: boolean): Promise<void> {
    const { error } = await this.sb.rpc('admin_set_feed_paused', {
      p_feed_id: feedId,
      p_paused: paused,
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
  }

  async listUsers(): Promise<RegisteredUser[]> {
    const { data, error } = await this.sb.rpc('list_users');
    if (error) throw error instanceof Error ? error : new Error(String(error));
    const rows = (data ?? []) as Array<{
      email: string;
      created_at: string;
      last_sign_in_at: string | null;
      family: boolean;
      admin: boolean;
      blocked?: boolean;
    }>;
    return rows.map((r) => ({
      email: r.email,
      createdAt: r.created_at,
      lastSignInAt: r.last_sign_in_at ?? null,
      family: r.family === true,
      admin: r.admin === true,
      blocked: r.blocked === true,
    }));
  }

  async deleteUser(email: string): Promise<void> {
    const { error } = await this.sb.rpc('admin_delete_user', { p_email: email });
    if (error) throw error instanceof Error ? error : new Error(String(error));
  }

  async setUserBlocked(email: string, blocked: boolean): Promise<void> {
    const { error } = await this.sb.rpc('admin_set_user_blocked', {
      p_email: email,
      p_blocked: blocked,
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
  }

  async listUserFeeds(email: string): Promise<AdminUserFeed[]> {
    const { data, error } = await this.sb.rpc('admin_list_user_feeds', {
      p_email: email,
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
    const rows = (data ?? []) as Array<{
      feed_id: string;
      title: string;
      site_url: string | null;
      muted: boolean;
      folder: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      feedId: r.feed_id,
      title: r.title,
      siteUrl: r.site_url ?? null,
      muted: r.muted === true,
      folder: r.folder ?? null,
      subscribedAt: r.created_at,
    }));
  }

  async listFeedSubscribers(feedId: FeedId): Promise<AdminFeedSubscriber[]> {
    const { data, error } = await this.sb.rpc('admin_list_feed_subscribers', {
      p_feed_id: feedId,
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
    const rows = (data ?? []) as Array<{
      email: string;
      family: boolean;
      blocked: boolean;
      muted: boolean;
      created_at: string;
    }>;
    return rows.map((r) => ({
      email: r.email,
      family: r.family === true,
      blocked: r.blocked === true,
      muted: r.muted === true,
      subscribedAt: r.created_at,
    }));
  }

  async getSignupsEnabled(): Promise<boolean> {
    const { data, error } = await this.sb.rpc('get_signups_enabled');
    if (error) throw error instanceof Error ? error : new Error(String(error));
    return data === true;
  }

  async setSignupsEnabled(enabled: boolean): Promise<void> {
    const { error } = await this.sb.rpc('set_signups_enabled', {
      p_enabled: enabled,
    });
    if (error) throw error instanceof Error ? error : new Error(String(error));
  }

  async listAiCalls(limit = 200): Promise<AiCall[]> {
    const { data, error } = await this.sb.rpc('admin_ai_call_log', {
      p_limit: limit,
    });
    if (error) {
      // A backend that predates the 0067 RPC (PGRST202) → empty list, so a new
      // client renders the console's empty state instead of crashing before the
      // manual `make migrate` lands (guardrail #11). Every other error (incl. the
      // non-admin 42501) surfaces to the caller.
      const err = error as { code?: string; message?: string };
      if (err.code === 'PGRST202') return [];
      throw error instanceof Error ? error : new Error(err.message ?? String(error));
    }
    return ((data ?? []) as AiCallRow[]).map(mapAiCall);
  }

  async getAiCallCounts(sinceHours = 24): Promise<AiCallCount[]> {
    const { data, error } = await this.sb.rpc('admin_ai_call_counts', {
      p_since_hours: sinceHours,
    });
    if (error) {
      const err = error as { code?: string; message?: string };
      if (err.code === 'PGRST202') return [];
      throw error instanceof Error ? error : new Error(err.message ?? String(error));
    }
    return ((data ?? []) as Array<{
      kind?: string | null;
      status?: string | null;
      count?: number | string | null;
    }>).map((r) => ({
      kind: (r.kind === 'spoiler' ? 'spoiler' : 'summary') as AiCallKind,
      status: r.status ?? '',
      // PostgREST returns bigint count as a string; coerce to a number.
      count: typeof r.count === 'number' ? r.count : Number(r.count ?? 0),
    }));
  }
}
