import type {
  Enclosure,
  Feed,
  FeedId,
  Item,
  ItemId,
  ItemState,
  Subscription,
} from '../types';

// Pure row→domain mappers for the Supabase (PostgREST) shapes. Kept separate
// from SupabaseDataSource so they can be unit-tested without a client. PostgREST
// returns snake_case columns and timestamptz as ISO strings; we normalize to the
// camelCase domain types and epoch-ms timestamps the UI uses.

/** A feed is parked once the poller's circuit breaker has tripped. We derive it
 * from `error_count` because `feeds` has no explicit `parked` column.
 * MUST stay in sync with the poller's `CIRCUIT_BREAKER_FAILS`
 * (supabase/functions/poll/index.ts) — it parks when `error_count >= 8`, so a
 * lower value here would flag the badge + "retry now" for feeds still in normal
 * backoff (5–7 failures). Separate runtimes (Deno vs. client) can't share the
 * constant, so keep these two in lockstep. */
export const PARKED_ERROR_THRESHOLD = 8;

/** SQLSTATEs a set_item_state write can return that are *permanent* — retrying
 * the same write won't succeed, so the outbox drops it and re-reconciles:
 *   - 40001 serialization_failure → our optimistic-concurrency version conflict
 *   - 42501 insufficient_privilege → the caller lost visibility of the item
 * Everything else (429/5xx server hiccup, missing/unknown code, auth that a
 * token refresh fixes) is treated as transient so a short outage can't roll back
 * and lose a user's triage action. */
export const PERMANENT_WRITE_CODES = new Set(['40001', '42501']);

/** Whether a PostgREST/Supabase RPC error is a permanent write rejection (see
 * PERMANENT_WRITE_CODES). A thrown/network error never reaches here — the outbox
 * catches those as transient. */
export function isPermanentWriteError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && PERMANENT_WRITE_CODES.has(code);
}

/** An Error carrying the HTTP `status` + PostgREST `code` of a failed request. */
export type RequestError = Error & { status?: number; code?: string };

/**
 * Build a thrown error from a PostgREST/Supabase `{ error, status }` response,
 * PRESERVING the HTTP status and SQLSTATE/PGRST code. The retry policy
 * (src/lib/queryRetry.ts) needs them to tell a 4xx/5xx server error (don't
 * retry) from a transient network blip (retry) — a flat `Error(message)` looks
 * statusless and would be retried, re-introducing the retry amplification a
 * runaway client causes.
 */
export function toRequestError(res: { error: unknown; status?: number }): RequestError {
  const e = res.error;
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === 'object' && e && 'message' in e
        ? String((e as { message: unknown }).message)
        : String(e);
  const err = new Error(msg) as RequestError;
  if (typeof res.status === 'number') err.status = res.status;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string') err.code = code;
  return err;
}

/** ISO timestamptz (or null) → epoch ms (or null). */
export function tsToMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/** A row from the `feeds_public` view. NEVER includes the fetch URLs
 * (`url`/`secret_url`) — those are server-only (see 0002_rls.sql). */
export interface FeedPublicRow {
  id: string;
  site_url: string | null;
  title: string | null;
  last_fetched_at: string | null;
  next_fetch_at: string | null;
  fetch_interval_s: number | null;
  error_count: number | null;
  last_error: string | null;
  created_at: string | null;
}

export interface ItemRow {
  id: string;
  feed_id: string;
  guid: string;
  url: string | null;
  title: string | null;
  author: string | null;
  published_at: string | null;
  content_html: string | null;
  summary: string | null;
  full_content_html?: string | null;
  enclosures: unknown;
  content_hash: string | null;
  created_at: string | null;
}

export interface ItemStateRow {
  user_id?: string;
  item_id: string;
  pinned: boolean;
  pinned_at: string | null;
  favorite: boolean;
  favorite_at: string | null;
  done: boolean;
  done_at: string | null;
  hidden: boolean;
  hidden_at: string | null;
  opened: boolean;
  opened_at: string | null;
  version: number;
}

export interface SubscriptionRow {
  feed_id: string;
  folder: string | null;
  title_override: string | null;
  muted: boolean;
  sort: number;
}

/**
 * `feeds_public` row → `Feed`. The display `url` is sourced from `site_url` —
 * never a fetch URL, which the view doesn't even expose (a per-user token could
 * ride in it; see types.ts `Feed.url` and 0002_rls.sql). `faviconUrl` isn't in
 * the view yet, so null for now.
 */
export function mapFeed(row: FeedPublicRow): Feed {
  return {
    id: row.id,
    url: row.site_url ?? '',
    siteUrl: row.site_url ?? null,
    title: row.title ?? row.site_url ?? 'Untitled feed',
    faviconUrl: null,
    errorCount: row.error_count ?? 0,
    lastError: row.last_error ?? null,
    parked: (row.error_count ?? 0) >= PARKED_ERROR_THRESHOLD,
  };
}

function mapEnclosures(raw: unknown): Enclosure[] {
  if (!Array.isArray(raw)) return [];
  const out: Enclosure[] = [];
  for (const e of raw) {
    if (e && typeof e === 'object' && typeof (e as { url?: unknown }).url === 'string') {
      const rec = e as { url: string; type?: unknown; length?: unknown };
      out.push({
        url: rec.url,
        type: typeof rec.type === 'string' ? rec.type : null,
        length: typeof rec.length === 'number' ? rec.length : null,
      });
    }
  }
  return out;
}

/** `items` row → `Item`. `published_at` falls back to `created_at` so an item
 * missing a publish date still sorts sensibly. */
export function mapItem(row: ItemRow): Item {
  return {
    id: row.id,
    feedId: row.feed_id,
    guid: row.guid,
    url: row.url ?? '',
    title: row.title ?? '(untitled)',
    author: row.author ?? null,
    publishedAt: tsToMs(row.published_at) ?? tsToMs(row.created_at) ?? 0,
    contentHtml: row.content_html ?? '',
    summary: row.summary ?? null,
    fullContentHtml: row.full_content_html ?? null,
    enclosures: mapEnclosures(row.enclosures),
  };
}

/** `item_state` row → domain `ItemState` (drops the user/item key columns). */
export function mapItemState(row: ItemStateRow): ItemState {
  return {
    pinned: row.pinned,
    pinnedAt: tsToMs(row.pinned_at),
    favorite: row.favorite,
    favoriteAt: tsToMs(row.favorite_at),
    done: row.done,
    doneAt: tsToMs(row.done_at),
    hidden: row.hidden,
    hiddenAt: tsToMs(row.hidden_at),
    opened: row.opened,
    openedAt: tsToMs(row.opened_at),
    version: row.version,
  };
}

export function mapSubscription(row: SubscriptionRow): Subscription {
  return {
    feedId: row.feed_id,
    folder: row.folder,
    titleOverride: row.title_override,
    muted: row.muted,
    sort: row.sort,
  };
}

/** A library/feed item id paired with its already-mapped state, for callers
 * that hydrate the state store from server rows. */
export type { FeedId, ItemId };
