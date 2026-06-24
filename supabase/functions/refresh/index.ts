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
import { sanitizeContent } from '../_shared/sanitize.ts';
import { safeFetch } from '../_shared/ssrf.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { RateLimiter, rateLimitKey } from '../_shared/rateLimit.ts';
import { CLIENT_BUILD_HEADER, checkClientBuild } from '../_shared/clientVersion.ts';

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
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Turn away known-bad old builds first — the targeted kill switch for a
  // client shipped with a refetch-loop bug. Cheapest possible reject (a header
  // compare), before auth or any DB work. Read the floor from the env on every
  // request, not at module load: raising the MIN_CLIENT_BUILD secret must take
  // effect on an already-warm isolate (which would otherwise keep the captured
  // value, usually 0) for the no-redeploy kill switch to actually work.
  const minClientBuild = Number(Deno.env.get('MIN_CLIENT_BUILD') ?? '0');
  const gate = checkClientBuild(req.headers.get(CLIENT_BUILD_HEADER), minClientBuild);
  if (!gate.allowed) {
    return json({ error: 'client too old, please update', minBuild: gate.floor }, 426);
  }

  // Authenticate the caller (forwarded JWT) so we only refresh feeds the user
  // actually subscribes to. The service-role client below does the writes.
  const authHeader = req.headers.get('Authorization') ?? '';

  // Shed abusive callers before touching Postgres.
  const limit = REFRESH_LIMIT.take(rateLimitKey(authHeader), Date.now());
  if (!limit.allowed) {
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

  let refreshed = 0;
  let debounced = 0;
  let failed = 0;
  for (const { feed_id } of subs ?? []) {
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

  return json({ refreshed, debounced, failed, debounceSeconds: DEBOUNCE_S });
}

/** Refresh one feed. Returns true if it actually fetched, false if skipped by
 * the debounce (or the feed no longer exists). */
async function refreshOne(service: any, feedId: string): Promise<boolean> {
  const { data: feed } = await service
    .from('feeds')
    .select('id, url, secret_url, last_fetched_at, fetch_interval_s')
    .eq('id', feedId)
    .single();
  if (!feed) return false;

  // Server-side debounce: skip a feed fetched within the last DEBOUNCE_S so a
  // user spamming pull-to-refresh / add-feed can't bypass the throttle and
  // hammer the publisher. (The cron poller has its own schedule.)
  if (
    feed.last_fetched_at &&
    Date.now() - Date.parse(feed.last_fetched_at) < DEBOUNCE_S * 1000
  ) {
    return false;
  }

  const res = await safeFetch(feed.secret_url ?? feed.url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/rdf+xml, application/xml, text/xml, */*;q=0.8',
    },
    timeoutMs: 10_000,
  });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  const parsed = parseFeedBody(new TextDecoder().decode(res.body), feed.url, ct);
  const { error: metaError } = await service
    .from('feeds')
    .update({
      title: parsed.feedTitle,
      site_url: parsed.siteUrl,
    })
    .eq('id', feed.id);
  if (metaError) throw new Error(`feed meta update failed: ${metaError.message}`);
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
    content_hash: it.guid,
  }));
  if (rows.length > 0) {
    // PostgREST resolves with { error } rather than throwing, so a rejected
    // upsert must be surfaced — otherwise refreshOne resolves "successfully"
    // and the caller reports a refresh that stored nothing.
    const { error: upsertError } = await service
      .from('items')
      .upsert(rows, { onConflict: 'feed_id,guid' });
    if (upsertError) throw new Error(`item upsert failed: ${upsertError.message}`);
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

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders, ...extraHeaders },
  });
}
