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
import { reapOrphanFeeds } from '../_shared/reap.ts';
import { fetchViaJinaHtml } from '../_shared/jina.ts';
import { redactUrl } from '../_shared/urlSafety.ts';
import {
  buildSpoilerPrompt,
  generateSpoilerTitles,
  parseSpoilerResult,
  type SpoilerGeneration,
} from '../_shared/spoilerTitle.ts';
import { runTitleNormalizeBackfill } from '../_shared/titleNormalizeBackfill.ts';
import { jsonBare as json } from '../_shared/respond.ts';
import { rejectNonServiceCaller } from '../_shared/serviceAuth.ts';
import { recordAiCall } from '../_shared/aiCallLog.ts';

const BATCH_SIZE = 25;

// Spoiler-title generation (Gemini) — mirrors summary/index.ts's caller.
const SPOILER_MODEL = 'gemini-2.5-flash-lite';
const SPOILER_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${SPOILER_MODEL}:generateContent`;
const SPOILER_TIMEOUT_MS = 20_000;
// Cap the unprocessed items we classify per feed per poll — new/changed items
// carry a null generated_at, so steady state is just the poll's new items; this
// bounds the first-run backfill of a freshly-migrated backend.
const SPOILER_ITEMS_PER_FEED = 20;
// Global bounds on the whole spoiler pass (across all feeds this poll), so a
// batch full of allowlisted feeds can't fan out into hundreds of serial Gemini
// calls — the pass runs AFTER the items are stored, but it still shares the Edge
// Function's wall-clock, so an unbounded pass (worst case during a Gemini
// slowdown, each call taking its full timeout) could keep the function busy for
// minutes and overlap the next scheduled poll. Whatever we skip stays
// generated_at NULL and is picked up next poll.
const SPOILER_MAX_ITEMS_PER_RUN = 40;
const SPOILER_BUDGET_MS = 60_000;

// AI call log (0067) retention: the poll prunes rows older than this each run so
// the observability table stays bounded without a scheduled job.
const AI_CALL_LOG_KEEP_DAYS = 14;

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
  const denied = rejectNonServiceCaller(req, serviceKey, 'poll');
  if (denied) return denied;

  // Service-role client — the poller writes shared feeds/items and BYPASSES
  // RLS. Disable autoRefreshToken/persistSession so the client doesn't drop
  // the service key. The service key is a server-only secret (never shipped
  // to clients).
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Reap feeds nobody subscribes to anymore before selecting the batch, so an
  // abandoned feed is deleted rather than polled (and stops retaining content
  // no one can read). A feed kept alive only by someone's pinned/favorite/done
  // item is preserved — see reap_orphan_feeds() (0042). GC is not the fetch:
  // a reap failure is logged but never aborts the poll run.
  try {
    const reaped = await reapOrphanFeeds(supabase);
    if (reaped > 0) console.log(`poll: reaped ${reaped} orphan feed(s)`);
  } catch (err) {
    console.error('poll: reap_orphan_feeds failed:', err);
  }

  // Select the batch: the most-overdue feeds (next_fetch_at <= now()) that
  // still have >= 1 subscriber, via feeds_due_for_poll (0044). The subscriber
  // EXISTS is enforced in SQL (PostgREST can't express it cleanly), so we never
  // poll a feed nobody subscribes to — including one the reaper preserved
  // because a pin/favorite/done keeps its items alive. Ordered by next_fetch_at
  // in the function so feeds_next_fetch_idx (0032) serves the range + ordering.
  const { data: feeds, error } = await supabase.rpc('feeds_due_for_poll', {
    p_limit: BATCH_SIZE,
  });
  if (error) {
    console.error('poll: feeds_due_for_poll query failed:', error);
    return json({ error: error.message }, 500);
  }

  const considered = feeds?.length ?? 0;
  console.log(`poll: selected ${considered} feed(s) due for fetch`);

  let processed = 0;
  let failed = 0;
  const processedFeedIds: string[] = [];
  for (const feed of feeds ?? []) {
    try {
      // safeFetch for the feed + direct homepage GET; fetchViaJinaHtml is the
      // bot-block fallback for homepage favicon discovery (ft.com etc.), used
      // once per feed only when the direct homepage GET is blocked.
      await pollOne(supabase, feed, undefined, fetchViaJinaHtml);
      processed++;
      processedFeedIds.push(feed.id);
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

  // Spoiler-free sports headlines: for the feeds we just polled that have an
  // allowlisted subscriber, classify+rewrite any unprocessed headlines (Gemini,
  // title + stored RSS body only — no new fetch) and cache the result on the
  // shared item. Soft + off the critical path: a failure here never fails the
  // poll (items are already stored), and it no-ops when GOOGLE_API_KEY is unset.
  const spoiler = await runSpoilerTitles(supabase, processedFeedIds).catch((err) => {
    console.error('poll: spoiler-title pass failed:', err);
    return null;
  });

  // Fill items.title_normalized for any rows the writers didn't cover — rows
  // that predate the column, and rows left behind by a TITLE_NORMALIZED_VERSION
  // bump. Deliberately NOT scoped to processedFeedIds (see the module header):
  // paused and failing feeds are exactly the ones re-polling never reaches.
  // Soft — the items are already stored, so a failure here never fails the poll.
  const titleNormalize = await runTitleNormalizeBackfill(supabase).catch((err) => {
    console.error('poll: title-normalize backfill failed:', err);
    return null;
  });

  // Best-effort retention for the AI call log (0067) so it can't grow unbounded
  // without a scheduled job — one cheap indexed delete per poll. Soft: a failure
  // (or an old backend without the function) never affects the poll.
  try {
    await supabase.rpc('prune_ai_call_log', { p_keep_days: AI_CALL_LOG_KEEP_DAYS });
  } catch (err) {
    console.warn('poll: prune_ai_call_log failed (non-fatal):', err);
  }

  console.log(
    `poll: done — processed=${processed} failed=${failed} considered=${considered}` +
      (spoiler
        ? ` spoilerProcessed=${spoiler.processed} spoilerRewritten=${spoiler.rewritten}` +
          ` spoilerFailed=${spoiler.failed}${spoiler.budgetHit ? ' spoilerBudgetHit' : ''}`
        : '') +
      (titleNormalize
        ? ` titleNormalizeConsidered=${titleNormalize.considered}` +
          ` titleNormalizeWritten=${titleNormalize.written}` +
          ` titleNormalizeFailed=${titleNormalize.failed}`
        : ''),
  );
  return json({ processed, failed, considered, spoiler, titleNormalize });
}

/** Run the Gemini spoiler-title pass over the polled feeds. Wires the real
 * Supabase (RPC / item read / write) and Gemini calls into the injectable
 * orchestrator in _shared/spoilerTitle.ts (unit-tested there). No-ops silently
 * without a Gemini key, exactly like the summary function. */
async function runSpoilerTitles(
  supabase: any,
  feedIds: string[],
): Promise<{ processed: number; rewritten: number; failed: number; budgetHit: boolean } | null> {
  const apiKey = Deno.env.get('GOOGLE_API_KEY');
  if (!apiKey) {
    console.warn('poll: GOOGLE_API_KEY not set — skipping spoiler-title pass');
    return null;
  }
  const startedAt = Date.now();
  return generateSpoilerTitles(feedIds, {
    async allowlistedFeeds(ids) {
      const { data, error } = await supabase.rpc('feeds_with_allowlisted_subscriber', {
        p_feed_ids: ids,
      });
      if (error) {
        // Fail closed (generate for no one) on a gate-read error, so we never
        // spend Gemini for feeds we couldn't confirm are allowlisted.
        console.error('poll: allowlisted-feeds gate read failed:', error);
        return [];
      }
      // `returns setof uuid` comes back as scalars or single-key rows depending
      // on PostgREST version — normalize both to a string id.
      return (data ?? []).map((row: unknown) =>
        typeof row === 'string' ? row : String(Object.values(row as object)[0]),
      );
    },
    async unprocessedItems(feedId) {
      const { data, error } = await supabase
        .from('items')
        .select('id, title, content_html, summary, spoiler_free_title_generated_at')
        .eq('feed_id', feedId)
        .is('spoiler_free_title_generated_at', null)
        // Order by sort_at (not published_at): it matches items_feed_sort_idx
        // (feed_id, sort_at desc) from 0005, so taking the newest unprocessed
        // items is an index range scan — the same hot path the feed reads use —
        // rather than sorting the feed's whole unprocessed backlog.
        .order('sort_at', { ascending: false })
        .limit(SPOILER_ITEMS_PER_FEED);
      if (error) {
        console.error(`poll: unprocessed-items read for feed ${feedId} failed:`, error);
        return [];
      }
      return data ?? [];
    },
    async generate(title, content, itemId) {
      const { generation, httpStatus, error } = await classifyHeadline(
        apiKey,
        title,
        content,
      );
      // Best-effort observability (0067): record the outcome so /admin/ai can
      // show whether the spoiler classifier is producing rewrites, seeing
      // non-spoilers, or failing (and the model's HTTP code). Never blocks the
      // pass on a logging failure.
      await recordAiCall(supabase, {
        kind: 'spoiler',
        status: generation.status,
        httpStatus,
        itemId,
        error: generation.status === 'failed' ? error : null,
      });
      return generation;
    },
    async write(itemId, spoilerFreeTitle) {
      const { error } = await supabase
        .from('items')
        .update({
          spoiler_free_title: spoilerFreeTitle,
          spoiler_free_title_generated_at: new Date().toISOString(),
        })
        .eq('id', itemId);
      if (error) {
        console.error(`poll: spoiler-title write for item ${itemId} failed:`, error);
      }
    },
  }, {
    // Bound the pass per poll: at most SPOILER_MAX_ITEMS_PER_RUN classifications,
    // and stop starting new ones once the wall-clock budget is spent (guards the
    // Gemini-slowdown worst case). Leftovers stay unprocessed for the next poll.
    maxItems: SPOILER_MAX_ITEMS_PER_RUN,
    withinBudget: () => Date.now() - startedAt < SPOILER_BUDGET_MS,
  });
}

/** One Gemini call to classify a headline. Fixed Google host (the headline is in
 * the request body, never a URL → no SSRF surface); `thinkingBudget: 0` and JSON
 * response mode keep it fast and parseable. Returns a `SpoilerGeneration`:
 *   - `rewrite`/`none` on a completed classification (a 200 we parsed) — the
 *     caller caches it (rewrite or null) so it isn't re-billed;
 *   - `failed` on a TRANSIENT failure (non-2xx, timeout, network throw) — the
 *     caller leaves the item unprocessed so the next poll retries it, instead of
 *     letting one outage permanently skip the headline. */
/** The classification plus the observability fields the AI call log records
 * (the model's HTTP code when there was a response, and a short error on a
 * transient failure). `generation` is the only thing the orchestrator acts on. */
interface ClassifyResult {
  generation: SpoilerGeneration;
  httpStatus: number | null;
  error: string | null;
}

async function classifyHeadline(
  apiKey: string,
  title: string | null,
  content: string,
): Promise<ClassifyResult> {
  try {
    const res = await fetch(`${SPOILER_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildSpoilerPrompt(title, content) }] }],
        generationConfig: {
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(SPOILER_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`poll: spoiler Gemini responded HTTP ${res.status} — retry next poll`);
      return {
        generation: { status: 'failed' },
        httpStatus: res.status,
        error: `Gemini HTTP ${res.status}`,
      };
    }
    // A parsed 200 is a completed classification (a spoiler:false or garbage body
    // → no rewrite, cached so we don't re-bill it). Only a failed CALL retries.
    const { spoilerFreeTitle } = parseSpoilerResult(await res.json());
    const generation: SpoilerGeneration = spoilerFreeTitle
      ? { status: 'rewrite', title: spoilerFreeTitle }
      : { status: 'none' };
    return { generation, httpStatus: res.status, error: null };
  } catch (err) {
    console.warn('poll: spoiler Gemini call failed — retry next poll:', err);
    return {
      generation: { status: 'failed' },
      httpStatus: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
