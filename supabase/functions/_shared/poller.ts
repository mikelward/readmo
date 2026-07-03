// Readmo poller core — the per-feed fetch/parse/store/schedule logic behind
// the `poll` Edge Function. Lives in _shared (plain TypeScript, structural DB
// client, injectable fetcher) so vitest can exercise it directly; the Deno
// entrypoint (supabase/functions/poll/index.ts) stays a thin auth + batch
// loop. See SPEC.md "Polling (the cron)".

import { cleanFaviconUrl, parseFeedBody } from './parser.ts';
import type { ParsedFeed } from './parser.ts';
import { discoverIconFromHtml } from './discover.ts';
import { sanitizeContent } from './sanitize.ts';
import { safeFetch } from './ssrf.ts';
import type { SafeFetchOptions, SafeFetchResult } from './ssrf.ts';
import { redactUrl } from './urlSafety.ts';

export const USER_AGENT = 'Readmo/1.0 (+https://readmo.app)';
// Adaptive interval bounds (seconds).
export const MIN_INTERVAL_S = 15 * 60; //  15 min — politeness floor for healthy feeds
export const MAX_INTERVAL_S = 6 * 60 * 60; // 6 h — backoff ceiling (SPEC.md)
export const CIRCUIT_BREAKER_FAILS = 8; // park the feed after N consecutive failures

/** The feed row the poll batch query selects. */
export interface PollerFeedRow {
  id: string;
  url: string;
  secret_url: string | null;
  etag: string | null;
  last_modified: string | null;
  fetch_interval_s: number;
  error_count: number | null;
  /** The favicon currently stored for this feed, if any. Lets homepage icon
   * discovery skip the extra fetch once a real icon has been found (see
   * {@link resolveStoredFavicon}). */
  favicon_url: string | null;
}

/** Minimal shape of the Supabase client the poller needs — feed-row updates
 * and the upsert_feed_items RPC. Typed structurally so this module stays free
 * of the supabase-js types (it's shared with vitest unit tests). */
export interface PollerDbClient {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): PromiseLike<{ error: { message?: string } | null }>;
    };
  };
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ error: { message?: string } | null }>;
}

/** Injectable fetcher (defaults to the SSRF-hardened safeFetch; tests fake it). */
export type PollerFetch = (
  url: string,
  options?: SafeFetchOptions,
) => Promise<SafeFetchResult>;

export async function pollOne(
  supabase: PollerDbClient,
  feed: PollerFeedRow,
  fetchFn: PollerFetch = safeFetch,
): Promise<void> {
  // The fetchable URL is secret_url when present (tokenized feeds), else url.
  const fetchUrl: string = feed.secret_url ?? feed.url;

  // Conditional GET: a 304 is free — bump last_fetched_at and stop.
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/rdf+xml, application/xml, text/xml, */*;q=0.8',
  };
  if (feed.etag) headers['If-None-Match'] = feed.etag;
  if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;

  console.log(`poll: fetching feed ${feed.id} (${redactUrl(fetchUrl)})`);
  const res = await fetchFn(fetchUrl, { headers, timeoutMs: 10_000 });
  console.log(`poll: feed ${feed.id} responded HTTP ${res.status}`);

  if (res.status === 304) {
    console.log(`poll: feed ${feed.id} not modified (304), skipping`);
    await scheduleNext(supabase, feed, { ok: true, interval: feed.fetch_interval_s });
    return;
  }

  // Honor 429/Retry-After by backing off without treating it as a hard error.
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after')) || feed.fetch_interval_s * 2;
    console.log(`poll: feed ${feed.id} rate-limited (429), backing off ${retry}s`);
    await scheduleNext(supabase, feed, { ok: true, interval: clampInterval(retry) });
    return;
  }
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  const body = new TextDecoder().decode(res.body);
  // parseFeedBody parses first; the HTML guard fires only when the parse yields
  // nothing and the content-type confirms it's an HTML page (bot-challenge /
  // paywall redirect). Mislabelled-but-valid feeds (real RSS served as
  // text/html) are accepted if parseFeed extracts a title or items.
  const parsed = parseFeedBody(body, fetchUrl, ct);
  console.log(`poll: feed ${feed.id} parsed — ${parsed.items.length} item(s)`);

  // When the feed advertises no icon of its own, the parser hands back the
  // guessed /favicon.ico — which 404s for some publishers (e.g. ft.com). Try to
  // discover a real icon from the site homepage's <link rel="icon">, once, and
  // reuse it on later polls so this stays a one-time extra fetch per feed.
  const faviconUrl = await resolveStoredFavicon(parsed, feed.favicon_url, fetchFn);

  // Upsert feed-level metadata (title, site_url, favicon). The new validators
  // (etag/last_modified) are NOT written here — they're persisted by
  // scheduleNext only after the item upsert succeeds. Writing them first would
  // let a failed upsert strand this response's items: the next poll would send
  // If-None-Match / If-Modified-Since, receive a 304, and permanently skip
  // items that were never actually stored. (refresh/index.ts orders its writes
  // the same way.)
  await supabase
    .from('feeds')
    .update({
      title: parsed.feedTitle,
      site_url: parsed.siteUrl,
      favicon_url: faviconUrl,
      last_fetched_at: new Date().toISOString(),
    })
    .eq('id', feed.id);

  // Upsert items. SANITIZE every body before storing (guardrail #6).
  const rows = parsed.items.map((it) => ({
    feed_id: feed.id,
    guid: it.guid,
    url: it.url,
    comments_url: it.commentsUrl,
    title: it.title,
    author: it.author,
    published_at: it.publishedAt,
    content_html: sanitizeContent(it.contentHtml, it.url ?? parsed.siteUrl),
    summary: it.summary,
    enclosures: it.enclosures,
    // content_hash detects edits → update in place rather than duplicate.
    content_hash: it.guid,
  }));
  if (rows.length === 0) {
    console.log(`poll: feed ${feed.id} — 0 items to upsert, skipping`);
  } else {
    // Call upsert_feed_items (migration 0013) instead of a direct .upsert():
    // we need ON CONFLICT to target EITHER (feed_id, guid) OR (feed_id, url),
    // and a single PostgREST upsert can only name one constraint. The RPC
    // catches the (feed_id, url) unique_violation and updates the existing
    // row in place — that's what de-dups a publisher re-issuing the same URL
    // under a new guid (BBC, ...). See SPEC.md "Feed fetching & parsing".
    //
    // strip feed_id from the row payload — the RPC carries it as p_feed_id.
    const itemsPayload = rows.map(({ feed_id: _fid, ...rest }) => rest);
    const { error: upsertError } = await supabase.rpc('upsert_feed_items', {
      p_feed_id: feed.id,
      p_items: itemsPayload,
    });
    if (upsertError) throw new Error(`item upsert failed: ${upsertError.message}`);
    console.log(`poll: feed ${feed.id} — upserted ${rows.length} item(s)`);
  }

  await scheduleNext(supabase, feed, {
    ok: true,
    interval: feed.fetch_interval_s,
    validators: {
      etag: res.headers.get('etag'),
      last_modified: res.headers.get('last-modified'),
    },
  });
}

// --- Favicon: homepage <link rel="icon"> discovery -------------------------

/**
 * The favicon URL to store for this feed.
 *
 * Priority: a feed-advertised icon (authoritative, already screened by the
 * parser) → a real icon discovered on the site homepage → the guessed
 * `/favicon.ico`. Homepage discovery is the fallback for feeds that advertise
 * no icon *and* whose `/favicon.ico` guess may 404 (e.g. ft.com), and it costs
 * one extra HTTP GET — so it runs at most **once per feed**:
 *
 *   - Advertised icon present → use it; no fetch.
 *   - Otherwise, if *any* favicon is already stored → reuse it; no fetch.
 *   - Otherwise (nothing stored yet — the first poll) → fetch the homepage once
 *     and discover; fall back to the guess if nothing usable is found.
 *
 * Gating on "nothing stored yet" rather than "stored differs from the guess" is
 * deliberate: a homepage whose advertised icon *is* `/favicon.ico` discovers a
 * URL equal to the guess, and keying off inequality would re-fetch that
 * homepage on every subsequent poll forever. Once anything is stored we leave
 * it — favicons effectively never change, and a feed that later starts
 * advertising one in its body still updates through the first branch.
 *
 * A discovery fetch failure never fails the poll — the guess is used.
 */
export async function resolveStoredFavicon(
  parsed: Pick<ParsedFeed, 'faviconUrl' | 'faviconAdvertised' | 'siteUrl'>,
  storedFaviconUrl: string | null,
  fetchFn: PollerFetch,
): Promise<string | null> {
  if (parsed.faviconAdvertised) return parsed.faviconUrl;
  const guess = parsed.faviconUrl;
  // Anything already stored (a discovered icon, or the guess we settled on)
  // is reused — discovery is one-shot, so later polls never re-fetch the page.
  if (storedFaviconUrl != null) return storedFaviconUrl;
  if (!parsed.siteUrl) return guess;
  const discovered = await discoverHomepageIcon(parsed.siteUrl, fetchFn);
  return discovered ?? guess;
}

/** Fetch a site homepage and return the screened favicon URL it advertises via
 * `<link rel="icon">`, or null. Swallows every fetch/parse failure (returns
 * null) so icon discovery is never able to fail a poll — the article data is
 * already parsed by the time this runs. */
async function discoverHomepageIcon(
  pageUrl: string,
  fetchFn: PollerFetch,
): Promise<string | null> {
  try {
    // No custom maxBytes: safeFetch's cap is a hard reject on the WHOLE
    // response (it even pre-checks Content-Length), not a prefix read, so a
    // tight cap would throw on a large homepage before we ever reach its
    // <head> — exactly the big publisher pages this fallback should rescue.
    // Rely on safeFetch's default whole-response bound (the same one the feed
    // fetch uses); discoverIconFromHtml then slices at </head> to bound parsing.
    const res = await fetchFn(pageUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html, application/xhtml+xml, */*;q=0.8',
      },
      timeoutMs: 8_000,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const ct = res.headers.get('content-type') ?? '';
    // Only parse HTML; a non-HTML homepage (rare) has no <link rel="icon">.
    if (ct && !/html/i.test(ct)) return null;
    const html = new TextDecoder().decode(res.body);
    // Absolutize against the final URL after redirects, not the request URL.
    // Screen candidates best-first and take the first that survives, so a
    // rejected top pick (data: icon, tokenized ?v=…) doesn't mask a later safe
    // one and force the /favicon.ico fallback.
    for (const candidate of discoverIconFromHtml(html, res.url || pageUrl)) {
      const cleaned = cleanFaviconUrl(candidate);
      if (cleaned) return cleaned;
    }
    return null;
  } catch (err) {
    console.warn(
      `poll: homepage favicon discovery failed for ${redactUrl(pageUrl)}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// --- Scheduling, backoff, circuit breaker ----------------------------------

export function clampInterval(seconds: number): number {
  return Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, Math.round(seconds)));
}

export async function scheduleNext(
  supabase: PollerDbClient,
  feed: PollerFeedRow,
  opts: {
    ok: boolean;
    interval: number;
    /** New conditional-GET validators from a fully-stored 200 response. Only
     * the success path passes these, and only AFTER upsert_feed_items has
     * committed — see the ordering comment in pollOne. The 304/429 paths omit
     * them so the stored validators stay valid. */
    validators?: { etag: string | null; last_modified: string | null };
  },
): Promise<void> {
  const interval = clampInterval(opts.interval);
  await supabase
    .from('feeds')
    .update({
      next_fetch_at: new Date(Date.now() + interval * 1000).toISOString(),
      fetch_interval_s: interval,
      error_count: 0,
      last_error: null,
      // Stamp the successful check (incl. a 304 Not Modified) so feed-health
      // metadata reflects that the poller IS reaching the feed; otherwise a
      // feed that always 304s would look never-fetched. The failure path uses
      // recordFailure() and does not call this.
      ...(opts.ok ? { last_fetched_at: new Date().toISOString() } : {}),
      ...(opts.validators ?? {}),
    })
    .eq('id', feed.id);
}

export async function recordFailure(
  supabase: PollerDbClient,
  feed: PollerFeedRow,
  err: unknown,
): Promise<void> {
  const nextCount = (feed.error_count ?? 0) + 1;
  // Exponential backoff with jitter, capped, on the current interval.
  const backoff = clampInterval(
    feed.fetch_interval_s * Math.pow(2, Math.min(nextCount, 6)) *
      (0.75 + Math.random() * 0.5),
  );
  // Circuit breaker: after N consecutive failures, park the feed at the max
  // interval (surfaced to the user as a feed-health badge; "retry now" resets
  // error_count and next_fetch_at).
  const parked = nextCount >= CIRCUIT_BREAKER_FAILS;
  const { error: updateError } = await supabase
    .from('feeds')
    .update({
      error_count: nextCount,
      last_error: err instanceof Error ? err.message : String(err),
      next_fetch_at: new Date(
        Date.now() + (parked ? MAX_INTERVAL_S : backoff) * 1000,
      ).toISOString(),
    })
    .eq('id', feed.id);
  // If we can't even write the failure row, the feed-health UI will lie. Log
  // it loudly — silently dropping the write here is what hides "EDGE_FUNCTION
  // _ERROR with no logs" investigations.
  if (updateError) {
    console.error(`poll: recordFailure update for feed ${feed.id} failed:`, updateError);
  }
}
