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
import { pollOne, recordFailure } from '../_shared/poller.ts';
import { redactUrl } from '../_shared/urlSafety.ts';

const BATCH_SIZE = 25;

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
    .select('id, url, secret_url, etag, last_modified, fetch_interval_s, error_count, favicon_url')
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

  console.log(`poll: done — processed=${processed} failed=${failed} considered=${considered}`);
  return json({ processed, failed, considered });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
