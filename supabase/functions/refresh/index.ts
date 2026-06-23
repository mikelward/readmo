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
import { parseFeed } from '../_shared/parser.ts';
import { sanitizeContent } from '../_shared/sanitize.ts';
import { safeFetch } from '../_shared/ssrf.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';

const USER_AGENT = 'Readmo/1.0 (+https://readmo.app)';
// Debounce window: skip a forced refetch if the feed was fetched within this.
const DEBOUNCE_S = 60;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Authenticate the caller (forwarded JWT) so we only refresh feeds the user
  // actually subscribes to. The service-role client below does the writes.
  const authHeader = req.headers.get('Authorization') ?? '';

  let feedId: string | undefined;
  try {
    ({ feedId } = await req.json().catch(() => ({})));
  } catch {
    /* empty body == refresh all of the caller's subscriptions */
  }

  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const service = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Resolve which feeds to refresh — scoped to the caller's subscriptions via
  // their RLS-bound client (so a user can't force-poll a feed they don't have).
  let query = userClient.from('subscriptions').select('feed_id');
  if (feedId) query = query.eq('feed_id', feedId);
  const { data: subs, error } = await query;
  if (error) return json({ error: error.message }, 400);

  let refreshed = 0;
  let debounced = 0;
  for (const { feed_id } of subs ?? []) {
    try {
      // refreshOne enforces the DEBOUNCE_S throttle and reports whether it
      // actually hit the publisher, so spamming refresh doesn't inflate counts.
      if (await refreshOne(service, feed_id)) refreshed++;
      else debounced++;
    } catch {
      /* per-feed isolation: one bad feed doesn't fail the request */
    }
  }

  return json({ refreshed, debounced, debounceSeconds: DEBOUNCE_S });
});

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
    headers: { 'User-Agent': USER_AGENT },
    timeoutMs: 10_000,
  });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);

  const parsed = parseFeed(new TextDecoder().decode(res.body), feed.url);
  await service
    .from('feeds')
    .update({
      title: parsed.feedTitle,
      site_url: parsed.siteUrl,
    })
    .eq('id', feed.id);
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
  await service
    .from('feeds')
    .update({
      last_fetched_at: new Date().toISOString(),
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
  return true;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}
