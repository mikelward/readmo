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
import type { JinaHtmlFetch } from './jina.ts';
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
  jinaFetch: JinaHtmlFetch | null = null,
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
  // Never hand a secret-backed feed's homepage to the third-party Jina fallback:
  // parseFeedBody resolved against the tokenized secret_url, so parsed.siteUrl can
  // land under the secret path, and a short token might slip the URL screen. The
  // article Jina paths skip secret_url feeds for the same reason (guardrail #6);
  // favicon discovery still falls back to the origin-root /favicon.ico guess.
  const jina = feed.secret_url ? null : jinaFetch;
  const faviconUrl = await resolveStoredFavicon(parsed, feed.favicon_url, fetchFn, jina);

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
 *
 * When a `jinaFetch` is supplied and the direct homepage GET is bot-blocked
 * (non-2xx / network error — ft.com, economist.com and other publishers 403 a
 * plain server-side GET), discovery retries the homepage through Jina Reader
 * before falling back to the guess, mirroring `/api/discover`'s Jina-on-403
 * path. That's the case this whole fallback exists for: the guessed
 * `/favicon.ico` 404s AND the homepage that advertises the real icon is behind
 * the bot wall. The retry is still one-shot per feed (gated on "nothing stored
 * yet") and only fires on the blocked path, so it never touches the common feed.
 */
export async function resolveStoredFavicon(
  parsed: Pick<ParsedFeed, 'faviconUrl' | 'faviconAdvertised' | 'siteUrl'>,
  storedFaviconUrl: string | null,
  fetchFn: PollerFetch,
  jinaFetch: JinaHtmlFetch | null = null,
): Promise<string | null> {
  if (parsed.faviconAdvertised) return parsed.faviconUrl;
  const guess = parsed.faviconUrl;
  // Anything already stored (a discovered icon, or the guess we settled on)
  // is reused — discovery is one-shot, so later polls never re-fetch the page.
  if (storedFaviconUrl != null) return storedFaviconUrl;
  if (!parsed.siteUrl) return guess;
  const discovered = await discoverHomepageIcon(parsed.siteUrl, fetchFn, jinaFetch);
  return discovered ?? guess;
}

/** Fetch a site homepage and return the screened favicon URL it advertises via
 * `<link rel="icon">`, or null. Tries a direct, polite GET first; if that is
 * bot-blocked — a real non-2xx HTTP *status* from a host `safeFetch` actually
 * reached (ft.com/economist.com answer 403 to a plain server-side GET) — and a
 * `jinaFetch` is available, retries once through Jina Reader (the headless-
 * browser proxy) before giving up, so the real icon behind the bot wall is still
 * found. Two cases deliberately do NOT retry via Jina:
 *   - A reachable homepage (2xx) that simply advertises no usable icon — the
 *     `/favicon.ico` guess is the answer there, and every ordinary site would
 *     otherwise spend a needless third-party fetch.
 *   - A fetch that THREW rather than returning a status — an SSRF rejection
 *     (`safeFetch` fails closed on loopback/link-local/private/metadata hosts),
 *     DNS failure, or timeout. We must not hand a URL `safeFetch` refused for
 *     SSRF reasons to a third party, so a throw never triggers the Jina path
 *     (guardrail #6). `fetchViaJinaHtml` also screens the URL itself as a second
 *     layer.
 * Swallows every fetch/parse failure (returns null) so icon discovery is never
 * able to fail a poll — the article data is already parsed by the time this
 * runs. */
async function discoverHomepageIcon(
  pageUrl: string,
  fetchFn: PollerFetch,
  jinaFetch: JinaHtmlFetch | null,
): Promise<string | null> {
  const direct = await directHomepageHtml(pageUrl, fetchFn);
  if (direct.html !== null) {
    const icon = pickHomepageIcon(direct.html, direct.finalUrl);
    if (icon) return icon;
  }
  // Only an auth/bot-wall status (401/403) is worth a Jina retry — the same gate
  // /api/discover uses. Other non-2xx are deliberately NOT worked around: a 429
  // is an explicit publisher rate-limit (the feed-fetch path backs off on it;
  // proxying through a third party would bypass the throttle and burn Jina
  // quota), a 404/410 is dead, and a 5xx is transient. A 2xx (reachable), a
  // thrown fetch (SSRF/DNS/timeout — status null), or no Jina configured also
  // fall back to the guess without a Jina call.
  const botBlocked = direct.status === 401 || direct.status === 403;
  if (!botBlocked || !jinaFetch) return null;
  // Forward only the ORIGIN ROOT to the third party, never the full resolved
  // path. A feed whose fetch URL is tokenized — `secret_url`, or a token in
  // `feeds.url` with `secret_url` null (migration 0004) — can resolve
  // `parsed.siteUrl` under that token path, and a short token evades the URL
  // screen; the origin root carries no path secret (guardrail #6). The favicon
  // `<link>` is origin-wide, so the root is the right page to read anyway. We
  // take the origin of the POST-REDIRECT URL (`direct.finalUrl`), so a homepage
  // that redirects before blocking still probes — and absolutizes against — the
  // redirected host.
  let target: string;
  try {
    target = new URL(direct.finalUrl).origin + '/';
  } catch {
    return null;
  }
  let jinaHtml: string | null;
  try {
    jinaHtml = await jinaFetch(target);
  } catch {
    return null; // Jina failure never fails the poll.
  }
  if (jinaHtml === null) return null;
  console.log(`poll: homepage favicon discovery used Jina for ${redactUrl(target)}`);
  return pickHomepageIcon(jinaHtml, target);
}

/** Screen a homepage's advertised icons best-first and return the first URL that
 * survives {@link cleanFaviconUrl}, or null. Taking the first *survivor* (not
 * just the top pick) means a rejected candidate — a `data:` icon, a tokenized
 * `?v=…` URL — doesn't mask a later safe one and force the guess. */
function pickHomepageIcon(html: string, baseUrl: string): string | null {
  for (const candidate of discoverIconFromHtml(html, baseUrl)) {
    const cleaned = cleanFaviconUrl(candidate);
    if (cleaned) return cleaned;
  }
  return null;
}

interface DirectHomepage {
  /** The page HTML when we got a 2xx HTML response; null otherwise. */
  html: string | null;
  /** The final URL after redirects (for absolutizing hrefs). */
  finalUrl: string;
  /** The HTTP status when the fetch returned a response, or null when it THREW
   * (SSRF rejection / DNS failure / timeout). Only a non-2xx status marks a
   * bot-block worth a Jina retry; a null status must never reach Jina — the URL
   * may be one safeFetch refused for SSRF reasons (guardrail #6). */
  status: number | null;
}

/** Directly fetch a homepage and classify the result for {@link
 * discoverHomepageIcon}. Never throws — a fetch error is reported as a null
 * status (distinct from a real non-2xx, so an SSRF-refused URL is not treated as
 * a bot-block and forwarded to Jina). */
async function directHomepageHtml(
  pageUrl: string,
  fetchFn: PollerFetch,
): Promise<DirectHomepage> {
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
    if (res.status < 200 || res.status >= 300) {
      // Keep the post-redirect URL even on a bot-block: safeFetch already
      // followed + vetted every hop, and a homepage that redirects
      // (example.com -> www.example.com) before returning 403 must hand the
      // FINAL host to the Jina retry, so a relative <link rel="icon" href="/…">
      // in Jina's HTML absolutizes against the right origin.
      return { html: null, finalUrl: res.url || pageUrl, status: res.status };
    }
    const finalUrl = res.url || pageUrl;
    const ct = res.headers.get('content-type') ?? '';
    // Only parse HTML; a non-HTML 2xx homepage (rare) has no <link rel="icon">,
    // but it IS reachable — a Jina retry wouldn't help, so don't spend one.
    if (ct && !/html/i.test(ct)) return { html: null, finalUrl, status: res.status };
    return { html: new TextDecoder().decode(res.body), finalUrl, status: res.status };
  } catch (err) {
    console.warn(
      `poll: homepage favicon discovery failed for ${redactUrl(pageUrl)}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { html: null, finalUrl: pageUrl, status: null };
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
