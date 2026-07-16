// Readmo on-demand refresh — Edge Function.
//
// POST /functions/v1/refresh { feedId }  (or { folder } / no body for "all my
// subscriptions"). Triggered by "add feed" and pull-to-refresh — an immediate
// server-side fetch of the relevant feed(s), debounced server-side so a burst
// of PTRs doesn't hammer a publisher. SPEC.md "Polling … On-demand".
//
// Thin entrypoint reusing the same poll path as the cron. Not run in the test
// sandbox. Deno resolves bare specifiers via ../import_map.json.

// @ts-nocheck — runs under Deno, not node/tsc.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { parseFeedBody } from '../_shared/parser.ts';
import { clampInterval, recordFailure, resolveStoredFavicon } from '../_shared/poller.ts';
import { fetchViaJinaHtml } from '../_shared/jina.ts';
import { sanitizeContent } from '../_shared/sanitize.ts';
import { safeFetch } from '../_shared/ssrf.ts';
import { feedsToRefresh } from '../_shared/refreshScope.ts';
import { preflight } from '../_shared/cors.ts';
import { RateLimiter, rateLimitKey } from '../_shared/rateLimit.ts';
import { CLIENT_BUILD_HEADER, checkClientBuild } from '../_shared/clientVersion.ts';
import { jsonCors as json } from '../_shared/respond.ts';

const USER_AGENT = 'Readmo/1.0 (+https://readmo.app)';
// Debounce window: skip a forced refetch if the feed was fetched within this.
const DEBOUNCE_S = 60;

// Per-caller in-memory rate limit, checked BEFORE any DB work so a client stuck
// on a buggy version that pull-to-refreshes in a loop is shed at the door
// instead of spending a `subscriptions` select + a `feeds` read per call. Burst
// of 10 with sustained ~12/min (1 token / 5s) — far above any human's
// pull-to-refresh cadence, well below a refetch loop's. Best-effort per warm
// isolate; see rateLimit.ts for scope and the gateway note. Module scope so the
// bucket survives across requests on the same isolate.
const REFRESH_LIMIT = new RateLimiter({ capacity: 10, refillPerSec: 0.2 });

Deno.serve(async (req: Request) => {
  // Wrap the whole handler so an unexpected throw produces an Edge Function
  // log line, not a bare EDGE_FUNCTION_ERROR with nothing to look at.
  try {
    return await handle(req);
  } catch (err) {
    console.error('refresh: unhandled error:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') {
    console.warn(`refresh: rejected ${req.method} (POST only)`);
    return json({ error: 'POST only' }, 405);
  }

  // Turn away known-bad old builds first — the targeted kill switch for a
  // client shipped with a refetch-loop bug. Cheapest possible reject (a header
  // compare), before auth or any DB work. Read the floor from the env on every
  // request, not at module load: raising the MIN_CLIENT_BUILD secret must take
  // effect on an already-warm isolate (which would otherwise keep the captured
  // value, usually 0) for the no-redeploy kill switch to actually work.
  const minClientBuild = Number(Deno.env.get('MIN_CLIENT_BUILD') ?? '0');
  const gate = checkClientBuild(req.headers.get(CLIENT_BUILD_HEADER), minClientBuild);
  if (!gate.allowed) {
    console.warn(`refresh: rejected stale client build (floor ${gate.floor})`);
    return json({ error: 'client too old, please update', minBuild: gate.floor }, 426);
  }

  // Authenticate the caller (forwarded JWT) so we only refresh feeds the user
  // actually subscribes to. The service-role client below does the writes.
  const authHeader = req.headers.get('Authorization') ?? '';

  // Shed abusive callers before touching Postgres.
  const limit = REFRESH_LIMIT.take(rateLimitKey(authHeader), Date.now());
  if (!limit.allowed) {
    console.warn(`refresh: rate-limited caller (retry after ${limit.retryAfterS}s)`);
    return json({ error: 'rate limited', retryAfterSeconds: limit.retryAfterS }, 429, {
      'Retry-After': String(limit.retryAfterS),
    });
  }

  let feedId: string | undefined;
  try {
    ({ feedId } = await req.json().catch(() => ({})));
  } catch {
    /* empty body == refresh all of the caller's subscriptions */
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    console.error(
      'refresh: missing required env:',
      !supabaseUrl ? 'SUPABASE_URL' : '',
      !anonKey ? 'SUPABASE_ANON_KEY' : '',
      !serviceKey ? 'SUPABASE_SERVICE_ROLE_KEY' : '',
    );
    return json({ error: 'Server misconfigured' }, 500);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const service = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve which feeds to refresh — scoped to the caller's subscriptions via
  // their RLS-bound client (so a user can't force-poll a feed they don't have).
  let query = userClient.from('subscriptions').select('feed_id');
  if (feedId) query = query.eq('feed_id', feedId);
  const { data: subs, error } = await query;
  if (error) {
    console.error('refresh: subscription lookup failed:', error);
    return json({ error: error.message }, 400);
  }

  const subscribedFeedIds = (subs ?? []).map((s) => s.feed_id);
  // The /admin/feeds console lists every system feed, so an admin may refresh a
  // specific feed they don't subscribe to. Only pay for the admin check when it
  // could matter (a named feed with no matching subscription). Use the existing
  // `get_capabilities()` RPC — a SECURITY DEFINER function granted to
  // `authenticated` that resolves `is_admin()` from the caller's JWT — rather
  // than reading `admin_users` directly (service_role has no grant on that table;
  // it's read only through the DEFINER path, per 0028/0009).
  let isAdmin = false;
  if (feedId && subscribedFeedIds.length === 0) {
    const { data: caps, error: capsError } = await userClient.rpc('get_capabilities');
    if (capsError) {
      console.error('refresh: capability lookup failed:', capsError);
    } else {
      const row = Array.isArray(caps) ? caps[0] : caps;
      isAdmin = row?.admin === true;
    }
  }

  const feedIds = feedsToRefresh({ subscribedFeedIds, feedId, isAdmin });
  console.log(
    `refresh: ${feedIds.length} feed(s) to refresh` +
      (isAdmin ? ' (admin)' : ''),
  );

  let refreshed = 0;
  let debounced = 0;
  let failed = 0;
  for (const feed_id of feedIds) {
    try {
      // refreshOne enforces the DEBOUNCE_S throttle and reports whether it
      // actually hit the publisher, so spamming refresh doesn't inflate counts.
      if (await refreshOne(service, feed_id)) refreshed++;
      else debounced++;
    } catch (err) {
      // Per-feed isolation: one bad feed doesn't fail the request — but log
      // the failure so a feed that silently never refreshes is diagnosable.
      failed++;
      console.error(`refresh: feed ${feed_id} failed:`, err);
    }
  }

  console.log(`refresh: done — refreshed=${refreshed} debounced=${debounced} failed=${failed}`);
  return json({ refreshed, debounced, failed, debounceSeconds: DEBOUNCE_S });
}

/** Refresh one feed. Returns true if it actually fetched, false if skipped by
 * the debounce (or the feed no longer exists). */
async function refreshOne(service: any, feedId: string): Promise<boolean> {
  const { data: feed } = await service
    .from('feeds')
    // error_count is read by recordFailure() below so an immediate poll that
    // fails records the failure (and backs off) exactly like the cron poller.
    .select('id, url, secret_url, last_fetched_at, fetch_interval_s, error_count, favicon_url, paused')
    .eq('id', feedId)
    .single();
  if (!feed) return false;

  // Paused feeds do no server-side work (operator paused them from
  // /admin/feeds); a manual refresh is a no-op until they're unpaused.
  if (feed.paused) {
    console.log(`refresh: feed ${feedId} is paused — skipping`);
    return false;
  }

  // Server-side debounce: skip a feed fetched within the last DEBOUNCE_S so a
  // user spamming pull-to-refresh / add-feed can't bypass the throttle and
  // hammer the publisher. (The cron poller has its own schedule.)
  if (
    feed.last_fetched_at &&
    Date.now() - Date.parse(feed.last_fetched_at) < DEBOUNCE_S * 1000
  ) {
    console.log(`refresh: feed ${feedId} debounced (fetched ${Math.round((Date.now() - Date.parse(feed.last_fetched_at)) / 1000)}s ago)`);
    return false;
  }

  console.log(`refresh: fetching feed ${feedId}`);
  try {
    return await fetchAndStore(service, feed);
  } catch (err) {
    // Record the failure (error_count/last_error + backoff) so the immediate
    // on-add / pull-to-refresh poll surfaces as "Poll failed" with the reason on
    // /admin/feeds, instead of "Not tried" until the cron next records it. This
    // mirrors the cron poller (poll/index.ts), which already calls recordFailure
    // on a per-feed throw; the refresh path historically swallowed it, so a feed
    // whose ONLY attempt so far was its immediate poll looked untried. Re-throw
    // so the caller still counts it as failed and logs the redacted URL.
    await recordFailure(service, feed, err);
    throw err;
  }
}

/** Fetch, parse, sanitize, and store one feed's items + metadata, then schedule
 * the next poll. Split out from refreshOne so a throw anywhere here is funneled
 * through recordFailure by the caller. Returns true (it always fetched — the
 * debounce/paused short-circuits happen before this runs). */
async function fetchAndStore(service: any, feed: any): Promise<boolean> {
  const res = await safeFetch(feed.secret_url ?? feed.url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/rdf+xml, application/xml, text/xml, */*;q=0.8',
    },
    timeoutMs: 10_000,
  });
  console.log(`refresh: feed ${feed.id} responded HTTP ${res.status}`);
  // Honor 429/Retry-After like the cron poller (poller.ts): a rate-limit is a
  // backoff/scheduling signal, NOT a feed failure. Falling through to the
  // generic >=400 throw would route it into the caller's recordFailure(),
  // bumping error_count and eventually parking a healthy feed a user merely
  // pulled-to-refresh too often. Back off next_fetch_at and stop, without
  // touching error_count.
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after')) || (feed.fetch_interval_s ?? 1800) * 2;
    const { error: backoffError } = await service
      .from('feeds')
      .update({
        next_fetch_at: new Date(Date.now() + clampInterval(retry) * 1000).toISOString(),
        // A 429 means the feed is reachable, just throttled — not a failure. Clear
        // any prior circuit-breaker state and stamp the check, exactly as the cron
        // poller's 429 path does (scheduleNext with ok:true). Without this an admin
        // hitting "Retry now" on a PARKED feed that answers 429 would keep its
        // stale "Poll failed" badge and stay parked despite a non-terminal response.
        error_count: 0,
        last_error: null,
        last_fetched_at: new Date().toISOString(),
      })
      .eq('id', feed.id);
    if (backoffError) throw new Error(`feed 429 backoff update failed: ${backoffError.message}`);
    console.log(`refresh: feed ${feed.id} rate-limited (429), backing off`);
    return false;
  }
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  const parsed = parseFeedBody(new TextDecoder().decode(res.body), feed.url, ct);
  console.log(`refresh: feed ${feed.id} parsed — ${parsed.items.length} item(s)`);
  // Same favicon resolution as the cron poller: reuse an already-discovered
  // icon, else discover from the homepage <link rel="icon"> once, else the
  // /favicon.ico guess — so a manual refresh never clobbers a real icon.
  // Skip the third-party Jina fallback for secret-backed feeds — parsed.siteUrl
  // can resolve under the tokenized secret_url path, so forwarding it could leak
  // a secret (guardrail #6; matches the cron poller and the article Jina paths).
  const faviconUrl = await resolveStoredFavicon(
    parsed,
    feed.favicon_url,
    safeFetch,
    feed.secret_url ? null : fetchViaJinaHtml,
  );
  const { error: metaError } = await service
    .from('feeds')
    .update({
      title: parsed.feedTitle,
      site_url: parsed.siteUrl,
      favicon_url: faviconUrl,
    })
    .eq('id', feed.id);
  if (metaError) throw new Error(`feed meta update failed: ${metaError.message}`);
  const rows = parsed.items.map((it) => ({
    feed_id: feed.id,
    guid: it.guid,
    url: it.url,
    comments_url: it.commentsUrl,
    title: it.title,
    author: it.author,
    published_at: it.publishedAt,
    content_html: sanitizeContent(it.contentHtml, it.url ?? parsed.siteUrl),
    // The summary is publisher HTML too — never stored raw (same as poller.ts).
    summary:
      it.summary == null
        ? null
        : sanitizeContent(it.summary, it.url ?? parsed.siteUrl),
    enclosures: it.enclosures,
    content_hash: it.guid,
  }));
  if (rows.length > 0) {
    // Same RPC the cron poller uses (migration 0013): ON CONFLICT can only
    // target one index, but items has TWO unique constraints — (feed_id, guid)
    // and (feed_id, url) — so a direct .upsert(...) would fail when a
    // publisher re-issues an existing URL under a new guid. The RPC catches
    // the (feed_id, url) unique_violation and updates the existing row in
    // place. PostgREST still resolves with { error }, surface it.
    const itemsPayload = rows.map(({ feed_id: _fid, ...rest }) => rest);
    const { error: upsertError } = await service.rpc('upsert_feed_items', {
      p_feed_id: feed.id,
      p_items: itemsPayload,
    });
    if (upsertError) throw new Error(`item upsert failed: ${upsertError.message}`);
    console.log(`refresh: feed ${feed.id} — upserted ${rows.length} item(s)`);
  } else {
    console.log(`refresh: feed ${feed.id} — 0 items to upsert, skipping`);
  }
  // Validators (etag/last_modified) are written only after items are stored.
  // Writing them before the upsert would cause the next cron poll to send
  // If-None-Match / If-Modified-Since and receive a 304, permanently skipping
  // items that were never actually persisted.
  const { error: scheduleError } = await service
    .from('feeds')
    .update({
      last_fetched_at: new Date().toISOString(),
      etag: res.headers.get('etag'),
      last_modified: res.headers.get('last-modified'),
      // Mirror the poller's success path: a successful manual refresh clears the
      // circuit breaker (error_count/last_error) and reschedules, so "Retry now"
      // on a parked feed actually un-parks it instead of leaving the badge stuck.
      error_count: 0,
      last_error: null,
      next_fetch_at: new Date(
        Date.now() + (feed.fetch_interval_s ?? 1800) * 1000,
      ).toISOString(),
    })
    .eq('id', feed.id);
  if (scheduleError) throw new Error(`feed schedule update failed: ${scheduleError.message}`);
  return true;
}
