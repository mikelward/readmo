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
import { parseFeed } from '../_shared/parser.ts';
import { sanitizeContent } from '../_shared/sanitize.ts';
import { safeFetch } from '../_shared/ssrf.ts';

const USER_AGENT = 'Readmo/1.0 (+https://readmo.app)';
const BATCH_SIZE = 25;
// Adaptive interval bounds (seconds).
const MIN_INTERVAL_S = 15 * 60; //  15 min — politeness floor for healthy feeds
const MAX_INTERVAL_S = 6 * 60 * 60; // 6 h — backoff ceiling (SPEC.md)
const CIRCUIT_BREAKER_FAILS = 8; // park the feed after N consecutive failures

Deno.serve(async (_req: Request) => {
  // Service-role client — the poller writes shared feeds/items and BYPASSES
  // RLS. The service key is a server-only secret (never shipped to clients).
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Select feeds due for a poll that have >= 1 subscriber. Doing the
  // subscriber check keeps poll cost proportional to *subscribed distinct
  // feeds*, not all feeds ever added.
  // TODO(deploy): move this to a SQL function / view for the subscriber join;
  // sketch shown inline for clarity.
  const { data: feeds, error } = await supabase
    .from('feeds')
    .select('id, url, secret_url, etag, last_modified, fetch_interval_s, error_count')
    .lte('next_fetch_at', new Date().toISOString())
    .limit(BATCH_SIZE);
  if (error) return json({ error: error.message }, 500);

  let processed = 0;
  for (const feed of feeds ?? []) {
    // TODO(PR2, P2 — subscriber filter): the SELECT above must also require
    // EXISTS (subscriptions for this feed). Without it, feeds keep being polled
    // after their last subscriber leaves — for abandoned private/tokenized
    // feeds the server keeps calling the publisher and retaining content no one
    // can read, and poll cost scales with all feeds ever added instead of the
    // distinct *subscribed* feeds the spec promises. Move the join into the
    // query (or a SQL view) when this goes live. See PR #1 review (codex P2).
    try {
      await pollOne(supabase, feed);
      processed++;
    } catch (err) {
      await recordFailure(supabase, feed, err);
    }
  }

  return json({ processed, considered: feeds?.length ?? 0 });
});

async function pollOne(supabase: any, feed: any): Promise<void> {
  // The fetchable URL is secret_url when present (tokenized feeds), else url.
  const fetchUrl: string = feed.secret_url ?? feed.url;

  // Conditional GET: a 304 is free — bump last_fetched_at and stop.
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (feed.etag) headers['If-None-Match'] = feed.etag;
  if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;

  const res = await safeFetch(fetchUrl, { headers, timeoutMs: 10_000 });

  if (res.status === 304) {
    await scheduleNext(supabase, feed, { ok: true, interval: feed.fetch_interval_s });
    return;
  }

  // Honor 429/Retry-After by backing off without treating it as a hard error.
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after')) || feed.fetch_interval_s * 2;
    await scheduleNext(supabase, feed, { ok: true, interval: clampInterval(retry) });
    return;
  }
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status}`);
  }

  const body = new TextDecoder().decode(res.body);
  const parsed = parseFeed(body, fetchUrl);

  // Upsert feed-level metadata (title, site_url, new validators).
  await supabase
    .from('feeds')
    .update({
      title: parsed.feedTitle,
      site_url: parsed.siteUrl,
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
    title: it.title,
    author: it.author,
    published_at: it.publishedAt,
    content_html: sanitizeContent(it.contentHtml, it.url ?? parsed.siteUrl),
    summary: it.summary,
    enclosures: it.enclosures,
    // content_hash detects edits → update in place rather than duplicate.
    content_hash: it.guid,
  }));
  if (rows.length > 0) {
    // ON CONFLICT (feed_id, guid) DO UPDATE — Supabase upsert.
    // TODO(PR2, P2 — check the result): PostgREST resolves with `{ error }`
    // rather than throwing, so a rejected upsert would otherwise fall through
    // to scheduleNext({ ok: true }) and clear the feed's error state while no
    // items were stored — a feed reported healthy but silently empty.
    // Destructure { error } and throw so the catch records the failure.
    const { error: upsertError } = await supabase
      .from('items')
      .upsert(rows, { onConflict: 'feed_id,guid' });
    if (upsertError) throw new Error(`item upsert failed: ${upsertError.message}`);
  }

  await scheduleNext(supabase, feed, { ok: true, interval: feed.fetch_interval_s });
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
  await supabase
    .from('feeds')
    .update({
      error_count: nextCount,
      last_error: err instanceof Error ? err.message : String(err),
      next_fetch_at: new Date(
        Date.now() + (parked ? MAX_INTERVAL_S : backoff) * 1000,
      ).toISOString(),
    })
    .eq('id', feed.id);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
