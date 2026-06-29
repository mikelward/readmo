// Readmo poller — scheduled Edge Function (cron skeleton).
//
// Runs ~every 5 min (wired to pg_cron in a later PR; see SETUP.md). It selects
// feeds due for a fetch with >= 1 subscriber, does a conditional GET through
// the SSRF-hardened fetcher with a descriptive User-Agent, parses + sanitizes,
// upserts new/edited items, and schedules the next fetch with adaptive backoff
// and a circuit breaker. SPEC.md "Polling (the cron)".
//
// This entrypoint is intentionally THIN — the tested logic lives in _shared.
// It is not executed in the unit-test sandbox (no Deno, no DB); the wiring is
// documented with TODOs for the deploy PR.
//
// Deno resolves the bare specifiers below via ../import_map.json (pass
// `--import-map supabase/functions/import_map.json` when serving/deploying).

// @ts-nocheck — this file runs under Deno, not node/tsc. The _shared modules
// it imports ARE type-checked + unit-tested.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { parseFeedBody } from '../_shared/parser.ts';
import { sanitizeContent } from '../_shared/sanitize.ts';
import { safeFetch, SsrfError } from '../_shared/ssrf.ts';
import { redactUrl } from '../_shared/urlSafety.ts';
import { faviconIsDarkOnTransparent } from '../_shared/faviconDarkness.ts';

const USER_AGENT = 'Readmo/1.0 (+https://readmo.app)';
const BATCH_SIZE = 25;
// Adaptive interval bounds (seconds).
const MIN_INTERVAL_S = 15 * 60; //  15 min — politeness floor for healthy feeds
const MAX_INTERVAL_S = 6 * 60 * 60; // 6 h — backoff ceiling (SPEC.md)
const CIRCUIT_BREAKER_FAILS = 8; // park the feed after N consecutive failures

Deno.serve(async (req: Request) => {
  // Every failure path below logs through console.error — Supabase ships those
  // to the Edge Function logs, where an "EDGE_FUNCTION_ERROR" without context
  // is otherwise unanalyzable. Don't add a silent catch anywhere in this file.
  try {
    return await handle(req);
  } catch (err) {
    console.error('poll: unhandled error:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!serviceKey || !supabaseUrl) {
    // Misconfiguration: the function is deployed without its env wired up.
    // Log the specific missing var so the operator can fix it from the log line
    // alone — without this, the createClient() call below would throw a generic
    // "Invalid URL" / undefined-bearer that's hard to interpret.
    console.error(
      'poll: missing required env:',
      !serviceKey ? 'SUPABASE_SERVICE_ROLE_KEY' : '',
      !supabaseUrl ? 'SUPABASE_URL' : '',
    );
    return json({ error: 'Server misconfigured' }, 500);
  }

  // Cron-only: this endpoint polls with the service role (RLS bypass), so it
  // must reject anyone who isn't the scheduler. The pg_cron job sends the
  // service-role key as a Bearer token (see SETUP.md); require it before we
  // ever touch the service client, otherwise any holder of a valid project JWT
  // could trigger service-role polling and hammer publishers / run up cost.
  if ((req.headers.get('Authorization') ?? '') !== `Bearer ${serviceKey}`) {
    console.warn('poll: rejected request without the service-role bearer');
    return json({ error: 'Unauthorized' }, 401);
  }

  // Service-role client — the poller writes shared feeds/items and BYPASSES
  // RLS. Disable autoRefreshToken/persistSession so the client doesn't drop
  // the service key. The service key is a server-only secret (never shipped
  // to clients).
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Select feeds due for a poll that have >= 1 subscriber. Doing the
  // subscriber check keeps poll cost proportional to *subscribed distinct
  // feeds*, not all feeds ever added.
  // TODO(deploy): move this to a SQL function / view for the subscriber join;
  // sketch shown inline for clarity.
  // Order by next_fetch_at so the most-overdue feeds poll first and the
  // feeds_next_fetch_idx btree (0032) serves both the range predicate and the
  // ordering — a bounded index range scan instead of a full-table scan + sort.
  const { data: feeds, error } = await supabase
    .from('feeds')
    .select('id, url, secret_url, etag, last_modified, fetch_interval_s, error_count, favicon_url, favicon_invert_dark')
    .lte('next_fetch_at', new Date().toISOString())
    .order('next_fetch_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (error) {
    console.error('poll: feed-select query failed:', error);
    return json({ error: error.message }, 500);
  }

  const considered = feeds?.length ?? 0;
  console.log(`poll: selected ${considered} feed(s) due for fetch`);

  let processed = 0;
  let failed = 0;
  // Favicon measurement is best-effort and needs a remote icon fetch, so it is
  // collected here and drained AFTER the article loop (bounded concurrency +
  // time budget). Keeping it out of the per-feed loop means a slow icon host
  // can never delay the next feed's article poll within the invocation.
  const faviconTasks: FaviconTask[] = [];
  for (const feed of feeds ?? []) {
    // TODO(PR2, P2 — subscriber filter): the SELECT above must also require
    // EXISTS (subscriptions for this feed). Without it, feeds keep being polled
    // after their last subscriber leaves — for abandoned private/tokenized
    // feeds the server keeps calling the publisher and retaining content no one
    // can read, and poll cost scales with all feeds ever added instead of the
    // distinct *subscribed* feeds the spec promises. Move the join into the
    // query (or a SQL view) when this goes live. See PR #1 review (codex P2).
    try {
      await pollOne(supabase, feed, faviconTasks);
      processed++;
    } catch (err) {
      failed++;
      // Log BEFORE recordFailure: a feed that's been hard-broken for hours
      // shouldn't have the log line obscured by what recordFailure does next.
      // feeds.url can hold a tokenized URL (the user pasted one directly and
      // secret_url stayed null; migration 0004 / guardrail #6) — redact to
      // scheme://host so a transient publisher failure doesn't persist the
      // user's feed token to Edge Function logs.
      console.error(`poll: feed ${feed.id} (${redactUrl(feed.url)}) failed:`, err);
      await recordFailure(supabase, feed, err);
    }
  }

  // Drain favicon measurements now that every feed's articles are stored.
  await runFaviconMeasurements(supabase, faviconTasks);

  console.log(`poll: done — processed=${processed} failed=${failed} considered=${considered}`);
  return json({ processed, failed, considered });
}

async function pollOne(
  supabase: any,
  feed: any,
  faviconTasks: FaviconTask[],
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
  const res = await safeFetch(fetchUrl, { headers, timeoutMs: 10_000 });
  console.log(`poll: feed ${feed.id} responded HTTP ${res.status}`);

  if (res.status === 304) {
    console.log(`poll: feed ${feed.id} not modified (304), skipping`);
    await scheduleNext(supabase, feed, { ok: true, interval: feed.fetch_interval_s });
    // A steady feed that always 304s never re-parses, so back-measure the
    // favicon for feeds carrying a favicon_url but no verdict yet (the common
    // state right after the 0037 migration) — otherwise auto-inversion would
    // stay off until the publisher next changes the feed body. Queued (not
    // awaited) so a slow icon host can't delay this or any later feed.
    enqueueFaviconTask(faviconTasks, feed, feed.favicon_url);
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

  // Upsert feed-level metadata (title, site_url, new validators). The favicon
  // dark-mode verdict is measured LATER (after items + schedule are persisted),
  // because that needs a remote icon fetch and must never delay or drop article
  // ingestion. If the icon URL changed, null the stale verdict now so a crash
  // before the deferred measure leaves "not measured" (client falls back to the
  // manual list) rather than the old icon's verdict against the new icon.
  const faviconChanged = parsed.faviconUrl !== feed.favicon_url;
  await supabase
    .from('feeds')
    .update({
      title: parsed.feedTitle,
      site_url: parsed.siteUrl,
      favicon_url: parsed.faviconUrl,
      ...(faviconChanged ? { favicon_invert_dark: null } : {}),
      etag: res.headers.get('etag'),
      last_modified: res.headers.get('last-modified'),
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

  await scheduleNext(supabase, feed, { ok: true, interval: feed.fetch_interval_s });

  // Articles are stored + the next fetch scheduled; queue the favicon measure to
  // run after the whole batch so it never delays this or another feed's poll.
  enqueueFaviconTask(faviconTasks, feed, parsed.faviconUrl);
}

// Cap on the favicon body we'll fetch+decode. Icons are tiny (a few KB); this
// just bounds a pathological "favicon" that's really a huge image.
const FAVICON_MAX_BYTES = 512 * 1024;

/** Decide the dark-mode inversion flag for a feed's favicon.
 *
 * Skips the fetch entirely when the icon URL is unchanged AND we already have a
 * verdict (a steady feed pays nothing per poll). Re-measures when the URL is new
 * or changed, or when we've never measured it.
 *
 * Returns a TERMINAL verdict (true/false) whenever we can reach a conclusion —
 * including "couldn't decode" cases (a 4xx like 404, or an undecodable format
 * such as SVG), which resolve to `false`. Persisting `false` there stops the
 * poller refetching a dead/undecodable icon on every cycle; the client treats
 * `false` as "defer to the manual host list" anyway, so known dark icons (vox,
 * abc) still invert via that list. Returns `null` only on a TRANSIENT failure
 * (timeout, network error, 429, 5xx) so it's retried next poll rather than
 * cemented. Never throws: a favicon problem must not fail an otherwise-good
 * poll. */
async function resolveFaviconInvertDark(
  feed: any,
  faviconUrl: string | null,
): Promise<boolean | null> {
  if (!faviconUrl) return null;
  const unchanged = faviconUrl === feed.favicon_url;
  const alreadyMeasured =
    feed.favicon_invert_dark === true || feed.favicon_invert_dark === false;
  if (unchanged && alreadyMeasured) return feed.favicon_invert_dark;
  try {
    const res = await safeFetch(faviconUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.8' },
      timeoutMs: 8_000,
      maxBytes: FAVICON_MAX_BYTES,
    });
    if (res.status === 429 || res.status >= 500) return null; // transient → retry
    if (res.status >= 400) return false; // terminal: bad icon URL (404, …)
    const verdict = await faviconIsDarkOnTransparent(res.body);
    // Undecodable format (SVG/exotic) is terminal — don't refetch it forever.
    return verdict === null ? false : verdict;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `poll: feed ${feed.id} favicon measure skipped (${redactUrl(faviconUrl)}): ${msg}`,
    );
    // A non-retryable URL-safety/DNS rejection (blocked/private IP, bad scheme,
    // missing DNS, oversized body — all SsrfError) won't change on an identical
    // retry, so persist a terminal false instead of refetching it every poll.
    // A timeout/abort, or any unknown network error, is transient → leave null.
    const aborted =
      (err instanceof Error && err.name === 'AbortError') ||
      /\babort|timed?\s*out|timeout\b/i.test(msg);
    if (!aborted && err instanceof SsrfError) return false; // terminal
    return null; // transient (timeout/abort or unknown error) → retry
  }
}

interface FaviconTask {
  feed: any;
  faviconUrl: string | null;
}

// How many favicon probes run at once, and the total wall-clock the favicon
// phase may consume. The phase runs after all article polls, so even if the
// budget is hit, only some verdicts are deferred to the next poll — articles are
// already stored. Bounds keep a batch of slow icon hosts from eating the
// invocation.
const FAVICON_CONCURRENCY = 5;
const FAVICON_PHASE_BUDGET_MS = 30_000;

/** Queue a favicon measurement, but only when one is actually warranted: there
 * is an icon URL AND it's either new/changed or never measured. The steady
 * state (unchanged URL with a terminal verdict) enqueues nothing. */
function enqueueFaviconTask(
  tasks: FaviconTask[],
  feed: any,
  faviconUrl: string | null,
): void {
  if (!faviconUrl) return;
  const unchanged = faviconUrl === feed.favicon_url;
  const alreadyMeasured =
    feed.favicon_invert_dark === true || feed.favicon_invert_dark === false;
  if (unchanged && alreadyMeasured) return;
  tasks.push({ feed, faviconUrl });
}

/** Drain queued favicon measurements with bounded concurrency and a total time
 * budget. Runs after the article loop, so it can never delay ingestion; any
 * tasks left when the budget is hit simply retry on the next poll. */
async function runFaviconMeasurements(
  supabase: any,
  tasks: FaviconTask[],
): Promise<void> {
  if (tasks.length === 0) return;
  const deadline = Date.now() + FAVICON_PHASE_BUDGET_MS;
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < tasks.length && Date.now() < deadline) {
      const task = tasks[next++];
      try {
        await measureAndStoreFaviconInvertDark(supabase, task.feed, task.faviconUrl);
        done++;
      } catch (err) {
        console.error(`poll: favicon measure failed for feed ${task.feed.id}:`, err);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FAVICON_CONCURRENCY, tasks.length) }, worker),
  );
  if (done < tasks.length) {
    console.log(
      `poll: favicon phase measured ${done}/${tasks.length} (budget/cap hit; rest retry next poll)`,
    );
  }
}

/** Measure the favicon and persist its dark-mode verdict — called AFTER items +
 * schedule are written, so a slow/dead icon host can't delay article ingestion.
 * Skips entirely (no fetch, no write) when the icon URL is unchanged and already
 * has a terminal verdict — the steady-state path costs nothing. Otherwise it
 * measures and writes the result (true/false terminal, or null = transient,
 * retried next poll). `faviconUrl` is the freshly-parsed URL on the 200 path, or
 * the cached `feed.favicon_url` on the 304 path. */
async function measureAndStoreFaviconInvertDark(
  supabase: any,
  feed: any,
  faviconUrl: string | null,
): Promise<void> {
  const unchanged = faviconUrl === feed.favicon_url;
  const alreadyMeasured =
    feed.favicon_invert_dark === true || feed.favicon_invert_dark === false;
  if (unchanged && alreadyMeasured) return; // DB already correct
  const verdict = await resolveFaviconInvertDark(feed, faviconUrl);
  // Measurement is deferred, so a refresh or later poll may have changed the
  // icon URL since this task was queued. Guard the write on favicon_url still
  // matching what we measured — otherwise we'd stamp the old icon's verdict onto
  // the new URL. If the URL moved on, this matches no row (no-op) and the next
  // poll re-measures the current icon.
  await supabase
    .from('feeds')
    .update({ favicon_invert_dark: verdict })
    .eq('id', feed.id)
    .eq('favicon_url', faviconUrl);
}

// --- Scheduling, backoff, circuit breaker ----------------------------------

function clampInterval(seconds: number): number {
  return Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, Math.round(seconds)));
}

async function scheduleNext(
  supabase: any,
  feed: any,
  opts: { ok: boolean; interval: number },
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
    })
    .eq('id', feed.id);
}

async function recordFailure(supabase: any, feed: any, err: unknown): Promise<void> {
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
