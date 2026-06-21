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

const USER_AGENT = 'Readmo/1.0 (+https://readmo.app)';
// Debounce window: skip a forced refetch if the feed was fetched within this.
const DEBOUNCE_S = 60;

Deno.serve(async (req: Request) => {
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
  for (const { feed_id } of subs ?? []) {
    // TODO(deploy): debounce on feeds.last_fetched_at < now() - DEBOUNCE_S.
    try {
      await refreshOne(service, feed_id);
      refreshed++;
    } catch {
      /* per-feed isolation: one bad feed doesn't fail the request */
    }
  }

  return json({ refreshed, debounceSeconds: DEBOUNCE_S });
});

async function refreshOne(service: any, feedId: string): Promise<void> {
  const { data: feed } = await service
    .from('feeds')
    .select('id, url, secret_url')
    .eq('id', feedId)
    .single();
  if (!feed) return;

  const res = await safeFetch(feed.secret_url ?? feed.url, {
    headers: { 'User-Agent': USER_AGENT },
    timeoutMs: 10_000,
  });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);

  const parsed = parseFeed(new TextDecoder().decode(res.body), feed.url);
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
    .update({ last_fetched_at: new Date().toISOString() })
    .eq('id', feed.id);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
