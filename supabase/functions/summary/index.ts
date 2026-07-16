// Readmo AI article summary — Edge Function.
//
// POST /functions/v1/summary { itemId }
// Returns a short AI summary of an article (mirrors newshacker's article
// summary). The reader asks for this when an ALLOWLISTED user PINS an article —
// the pin is the trigger and the allowlist is the boundary (enforced here).
// SPEC.md "AI article summaries".
//
// Two callers, one trigger (the pin):
//   - The CLIENT (reader pre-warm / on-open / "Generate summary" button), with
//     the user's JWT.
//   - The DATABASE: the pin trigger (0053/0054) POSTs { itemId, userId, email }
//     with the service-role bearer the moment a pin commits to item_state, so
//     the work happens even if the app closes right after pinning. Recognized
//     by resolveInternalCaller (_shared/internalCaller.ts): service bearer +
//     explicit userId; a client passing userId with its own JWT stays on the
//     user path. pg_net never reads the outcome, so this path answers as soon
//     as the gates pass and runs in the background (EdgeRuntime.waitUntil):
//     CONCURRENTLY (a) download + cache the full article (one internal call to
//     the `fulltext` function — truncation-gated there, mirroring the client's
//     pinned prefetch) and (b) generate the summary if it's still missing. The
//     two legs single-flight independently (fulltext's fetch lease; the summary's
//     Gemini lease) and converge only on the shared item row, so neither blocks
//     the other. The summary fetches its own text via Jina, so it doesn't need
//     the full-text step to finish first (the stored body is only its fallback).
//
// Trust + access:
//   - User path: the caller's forwarded JWT scopes the item lookup through RLS
//     (items_select, 0002): a user who can't see the item gets a 404. The
//     service-role client does the cached write (client item writes are revoked;
//     0002/0009).
//   - Internal path: the trigger names the pinning user; the allowlist is
//     REQUIRED for that identity — an EMPTY allowlist means the trigger works
//     for no one (isInternalCallerAllowed; the poller's cost-guard convention,
//     unlike the client paths' "empty = open") — and visibility is proven by
//     the pinned item_state row itself (the same permanent-state grant
//     items_select honors) — no pin row, no summary (404).
//   - Summaries are a generation-cost surface (each cache miss is a Jina fetch +
//     a Gemini call), so — like reading mode and Google News — they're gated on
//     the DB `allowlist` table (the shared trusted-user list, managed from
//     /admin; see _shared/allowlist.ts). Empty table → open to all; once armed, a
//     non-listed caller gets a silent `empty` before any item lookup, Jina, or
//     Gemini call, so they never spend the budget.
//
// Article text — Jina, deliberately:
//   Like newshacker, the summary's article text comes from Jina Reader
//   (r.jina.ai), which returns clean MARKDOWN and handles bot-blocked / paywalled
//   / JS-rendered pages. This is the deliberate split from reading mode: the
//   `fulltext` path FETCHES + SERVES + extracts the article itself, so it must
//   be a polite first-party citizen (our User-Agent via safeFetch; honoring
//   robots is the intended posture there). The summary is a transient short
//   gist — never stored/served verbatim — so it routes through Jina, a third-party
//   reader, instead of our own fetcher. Tokenized/secret-bearing item URLs are
//   screened out before forwarding to Jina (guardrail #6, same guards as
//   fulltext): we never hand a subscriber token to a third party. When Jina is
//   unconfigured / blocked (tokenized URL) / fails, we fall back to summarizing
//   the body we already store (`full_content_html` ?? `content_html`), so the
//   feature still works without a new fetch.
//
// Outcomes are reported as a 200 { status, summary } envelope so the reader can
// stay silent on a soft failure (it just shows no summary card):
//   ok          — summary is the summary string (fresh or cache hit).
//   empty       — nothing to summarize: no article text at all; OR only a
//                 truncated feed stub is available (Jina down/screened + no full
//                 body) — flagged `retryable`, with NO Gemini call spent, so a
//                 later mount re-checks once Jina/full text lands; OR the
//                 allowlist denial (also `retryable`).
//   unavailable — the Gemini key isn't configured. NOT retryable: polling can't
//                 set an API key, so the client treats it as terminal instead of
//                 re-polling an unconfigured deployment (new generations work as
//                 soon as the operator sets GOOGLE_API_KEY).
//   unreachable — a transient failure (allowlist read, auth lookup, or the Gemini
//                 call failed); retryable.
// Hard errors keep their HTTP status: 400 (bad request), 401 (no JWT — platform),
// 404 (item not visible/found), 405 (wrong method).
//
// Thin entrypoint — prompt/parse/select logic is unit-tested in _shared/summary.ts.
// Deno resolves bare specifiers via ../import_map.json.

// @ts-nocheck — runs under Deno, not node/tsc.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { preflight } from '../_shared/cors.ts';
import { loadAllowlistFromDb, isAllowed } from '../_shared/allowlist.ts';
import { readItemIfPublicFeed, isTransientAuthError } from '../_shared/feedVisibility.ts';
import { looksTokenized, redactUrl } from '../_shared/urlSafety.ts';
import { assertSafeUrl } from '../_shared/ssrf.ts';
import {
  buildSummaryPrompt,
  clampSummaryText,
  coalesceSummaryGeneration,
  isBlockingHttpStatus,
  isSummaryOutcomeTransient,
  looksLikeBlockPage,
  parseGeminiText,
  pickStoredContent,
  siteLabel,
  stripSummaryPreamble,
} from '../_shared/summary.ts';
import type { SummaryLeaseClient, SummaryOutcome } from '../_shared/summary.ts';
import {
  isInternalCallerAllowed,
  resolveInternalCaller,
} from '../_shared/internalCaller.ts';
import type { InternalCaller } from '../_shared/internalCaller.ts';
import { retryWhile } from '../_shared/retry.ts';
import { jsonCors as json } from '../_shared/respond.ts';
import { recordAiCall } from '../_shared/aiCallLog.ts';

const MODEL = 'gemini-2.5-flash-lite';
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const GEMINI_TIMEOUT_MS = 20_000;
const JINA_TIMEOUT_MS = 15_000;
const JINA_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB, matching fulltext

Deno.serve(async (req: Request) => {
  // Top-level guard so an unexpected throw produces an Edge Function log line,
  // not a bare EDGE_FUNCTION_ERROR.
  try {
    return await handle(req);
  } catch (err) {
    console.error('summary: unhandled error:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') {
    console.warn(`summary: rejected ${req.method} (POST only)`);
    return json({ error: 'POST only' }, 405);
  }

  let itemId: string | undefined;
  let bodyUserId: unknown;
  let bodyEmail: unknown;
  try {
    ({ itemId, userId: bodyUserId, email: bodyEmail } = await req.json());
  } catch {
    console.warn('summary: rejected request with invalid JSON body');
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof itemId !== 'string' || !itemId) {
    console.warn('summary: rejected request with missing itemId');
    return json({ error: 'Missing itemId' }, 400);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const service = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // The DB pin trigger (0053/0054) vs. a normal user call. Internal requires
  // the service-role bearer AND an explicit userId; anything else is a user
  // call and the body's identity fields are ignored (never trusted).
  const caller = resolveInternalCaller({
    authHeader,
    serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    userId: bodyUserId,
    email: bodyEmail,
  });
  if (caller.internal) {
    console.log(`summary: pin-trigger call for item ${itemId}`);
  }

  // Allowlist gate (same list as reading mode / Google News). Checked BEFORE the
  // item lookup, the cache read, and any Jina/Gemini call, so a non-listed caller
  // never spends the generation budget. An EMPTY list leaves the feature open to
  // all. A blocked caller gets a silent `empty` flagged `retryable` so a later
  // allowlist change un-sticks them (additive field; old clients still see plain
  // `empty`). Fail CLOSED on a DB read error.
  let allowlist: Set<string>;
  try {
    allowlist = await loadAllowlistFromDb(service);
  } catch (err) {
    console.error('summary: allowlist read failed — retryable unreachable:', err);
    return json({ status: 'unreachable', summary: null });
  }
  if (caller.internal) {
    // The trigger names the pinning user; gate on THAT identity (the DB has no
    // user JWT to forward). Server-initiated work REQUIRES a listed user — an
    // empty allowlist triggers for no one (the poller's cost-guard convention,
    // unlike the client paths' "empty = open" below). Silent decline; the
    // outcome is discarded by pg_net anyway.
    if (!isInternalCallerAllowed(caller, allowlist)) {
      console.log('summary: pinning user not on the allowlist — no summary');
      return json({ status: 'empty', summary: null, retryable: true });
    }
  } else if (allowlist.size > 0) {
    const { data: auth, error: authError } = await userClient.auth.getUser();
    if (authError || !auth?.user) {
      // A transient auth lookup failure must not be cached as the terminal
      // `empty`; report the retryable `unreachable` so an allowlisted caller
      // retries instead of being stuck with no summary.
      console.warn('summary: auth lookup failed — retryable unreachable:', authError);
      return json({ status: 'unreachable', summary: null });
    }
    if (!isAllowed({ id: auth.user.id, email: auth.user.email }, allowlist)) {
      console.log('summary: caller not on the allowlist — no summary');
      return json({ status: 'empty', summary: null, retryable: true });
    }
  }

  // Item lookup. User path: RLS-scoped through the forwarded JWT — only
  // resolves if the caller may see this item. Internal path: the service role
  // bypasses RLS, so visibility is proven FIRST by the pinned item_state row
  // the trigger fired on (the same permanent-state grant items_select honors;
  // 0002). No pin row — e.g. unpinned again before we ran, or a forged id —
  // means no read (fail closed, 404 like the user path).
  const itemColumns =
    'id, feed_id, url, title, content_html, full_content_html, ai_summary';
  let item;
  if (caller.internal) {
    const { data: pin, error: pinError } = await service
      .from('item_state')
      .select('item_id')
      .eq('user_id', caller.userId)
      .eq('item_id', itemId)
      .eq('pinned', true)
      .maybeSingle();
    if (pinError) {
      console.error(`summary: pin lookup for item ${itemId} failed:`, pinError);
      return json({ status: 'unreachable', summary: null });
    }
    if (!pin) {
      console.warn(`summary: item ${itemId} not pinned by the named user — declining`);
      return json({ error: 'Item not found' }, 404);
    }
    const { data, error } = await service
      .from('items')
      .select(itemColumns)
      .eq('id', itemId)
      .maybeSingle();
    if (error) {
      console.error(`summary: item lookup for ${itemId} failed:`, error);
      return json({ error: error.message }, 400);
    }
    item = data;
  } else {
    const { data, error } = await userClient
      .from('items')
      .select(itemColumns)
      .eq('id', itemId)
      .maybeSingle();
    if (error) {
      console.error(`summary: item lookup for ${itemId} failed:`, error);
      return json({ error: error.message }, 400);
    }
    item = data;
    // Shared /item/<id> link: a PUBLIC feed's item is shareable by its
    // unguessable uuid (0068). Re-read via the service role and accept it only when
    // the parent feed is public, so an allowlisted family member sees a summary on a
    // link to a feed they don't subscribe to. A transient lookup blip throws →
    // report retryable unreachable.
    //
    // REQUIRE a real signed-in user first: the shared-link surfaces are
    // signed-in-only, and in DISARMED (empty-allowlist) mode the auth.getUser gate
    // above is skipped — so without this an anon caller with a public item uuid
    // could reach this service-role read and get/generate a summary (spending
    // Gemini). No user → leave `item` null so the 404 miss stands.
    if (!item) {
      const { data: authData, error: authErr } = await userClient.auth.getUser();
      if (authErr && isTransientAuthError(authErr)) {
        // Only a TRANSIENT auth OUTAGE (5xx / network) is retryable. A definitive
        // 4xx rejection is the anon / invalid-JWT case (the anon-key caller 401s
        // here, since this function is deployed with jwt verification) and must
        // stay WITHHELD (fall through to the 404), not retried.
        console.warn(`summary: shared-item auth lookup for ${itemId} failed — retryable:`, authErr);
        return json({ status: 'unreachable', summary: null });
      }
      if (authData?.user) {
        try {
          item = await readItemIfPublicFeed(service, itemId, itemColumns);
        } catch (err) {
          console.error(`summary: shared-item fallback lookup for ${itemId} failed:`, err);
          return json({ status: 'unreachable', summary: null });
        }
      }
      // else: confirmed anon (no user, no error) → item stays null → 404 withheld.
    }
  }
  if (!item) {
    console.warn(`summary: item ${itemId} not found or not visible to caller`);
    return json({ error: 'Item not found' }, 404);
  }

  if (caller.internal) {
    // The pin trigger's call is fire-and-forget: nothing reads the outcome, and
    // pg_net aborts the request at its timeout — well inside the fulltext +
    // Jina + Gemini work. So answer now (every gate above passed) and do the
    // real work in the background: the full-text download and the summary run
    // concurrently (see runPinTriggeredWork). Fall back to a synchronous run on a
    // runtime without waitUntil (the request may then be aborted mid-work, which
    // is no worse than the pre-trigger status quo).
    const work = runPinTriggeredWork(service, caller, itemId);
    if (globalThis.EdgeRuntime?.waitUntil) {
      globalThis.EdgeRuntime.waitUntil(work);
    } else {
      await work;
    }
    return json({ status: 'accepted', summary: null }, 202);
  }

  // Cache hit — the summary lives on the shared item, so one caller's generation
  // serves every subscriber who later pins the same article. Run the preamble
  // strip on the cached value too: rows cached BEFORE the strip existed still
  // carry a "tl;dr:" / "Here's a tl;dr…" preamble, and the cache-hit path returns
  // before generateSummary's strip. When cleaning actually changes the stored
  // value (a legacy row), rewrite it once so every later reader gets the fixed
  // text without re-stripping; fresh post-deploy summaries are already clean, so
  // this is a no-op write for them.
  if (item.ai_summary) {
    const cleaned = stripSummaryPreamble(item.ai_summary) || item.ai_summary;
    if (cleaned !== item.ai_summary) {
      console.log(`summary: item ${itemId} — cache hit, cleaning legacy preamble`);
      // Compare-and-swap on the exact value we read: if the poller nulled the
      // summary (title/body change) or another request wrote a newer one between
      // our RLS read and here, the WHERE won't match and we leave that value
      // alone instead of clobbering it with stale cleaned text.
      const { error: rewriteError } = await service
        .from('items')
        .update({ ai_summary: cleaned })
        .eq('id', itemId)
        .eq('ai_summary', item.ai_summary);
      if (rewriteError) {
        console.error(`summary: legacy preamble rewrite for item ${itemId} failed:`, rewriteError);
      }
    } else {
      console.log(`summary: item ${itemId} — cache hit`);
    }
    return json({ status: 'ok', summary: cleaned });
  }

  // Paused feed → decline generation (operator paused it from /admin/feeds). A
  // cached summary still serves via the hit above; this only blocks a new Gemini
  // call. Silent `empty`, retryable so unpausing later re-checks.
  {
    const { data: feed } = await service
      .from('feeds')
      .select('paused')
      .eq('id', item.feed_id)
      .maybeSingle();
    if (feed?.paused) {
      console.log(`summary: item ${itemId} — feed paused, declining generation`);
      return json({ status: 'empty', summary: null, retryable: true });
    }
  }

  const apiKey = Deno.env.get('GOOGLE_API_KEY');
  if (!apiKey) {
    // Not configured — deliberately NOT retryable: only the operator setting
    // the secret can change this, and a retryable flag here had the client's
    // retry-until-settled prewarm polling the function once a minute per pinned
    // item on an unconfigured deployment (Codex P2 on #506). The client treats
    // an unflagged `unavailable` as settled (no polling loop) but keeps it
    // stale, so once the key IS set, a saved article recovers on its next
    // boot/open/Generate rather than waiting on cache eviction.
    console.warn('summary: GOOGLE_API_KEY not set — unavailable');
    // Record the key-unset outcome (0067): "unavailable" is the single clearest
    // /admin/ai signal for "the AI features are configured off", so surface it
    // even though no Gemini call was made.
    await recordAiCall(service, { kind: 'summary', status: 'unavailable', itemId });
    return json({ status: 'unavailable', summary: null });
  }

  // Single-flight the generation: only one concurrent caller runs the Jina +
  // Gemini work; the rest wait and return its result the instant it's cached
  // (see coalesceSummaryGeneration in _shared/summary.ts). The lease lives on
  // `ai_summary_generated_at` (set while `ai_summary` is null = in flight),
  // claimed by the atomic conditional UPDATE below. This is what collapses N
  // simultaneous misses for the same shared item into a single Gemini call.
  const outcome = await coalesceSummaryGeneration({
    client: makeLeaseClient(service),
    itemId,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    generate: () => generateAndCacheLogged(service, apiKey, item, itemId),
  });
  // `cached` is internal to the coalescer (drives lease release); keep the wire
  // envelope exactly `{ status, summary, retryable? }` for older clients.
  const { cached: _cached, ...body } = outcome;
  return json(body);
}

// How long the pin-triggered work waits for the internal fulltext call. Its
// pipeline can run ~30 s worst case (12 s direct fetch + 15 s Jina fallback +
// robots reads + extraction); give it headroom rather than abandoning a fetch
// that's about to land.
const FULLTEXT_KICK_TIMEOUT_MS = 60_000;

// Transient-failure retry for the pin-triggered legs (both the full-text kick and
// the summary generation). Each leg reports a single boolean: whether its outcome
// was TRANSIENT — a passing blip a retry shortly could resolve. That bit is owned
// by the PRODUCER (the summary outcome via isSummaryOutcomeTransient; the fulltext
// function via the `transient` field on its envelope), so this retry consumes one
// authoritative signal instead of reconstructing intent from HTTP codes or status
// strings. Terminal outcomes (a paywall, a missing key, an allowlist denial, an
// item that's gone) report false and stop. 3 attempts (1 + 2 retries) with
// exponential backoff (1 s, 2 s), all inside waitUntil and off the user's path.
// Its value is latency: the server's own attempt lands more often, so the summary
// is ready before the reader opens rather than being regenerated lazily. The
// stub-defer "full content first" fallback is the post-settle re-check in
// runPinTriggeredWork, distinct from this transient retry.
const PIN_RETRY_ATTEMPTS = 3;
const PIN_RETRY_BASE_MS = 1_000;
const pinRetrySleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The pin trigger's background work (runs under EdgeRuntime.waitUntil after the
 * 202 is sent). The full-text download and the summary generation run
 * CONCURRENTLY: they share no in-memory state and don't block each other —
 * `fulltext` single-flights its own publisher fetch (its lease) and the summary
 * single-flights its Gemini call (coalesceSummaryGeneration), converging only on
 * the shared item row. (Previously sequential — full text first so the summary
 * could fall back to the freshly-stored full body when Jina failed. Parallelized
 * for latency; the accepted trade is that a Jina failure now falls back to the
 * stored feed body/stub rather than the just-downloaded full article — that path
 * defers with a retryable `empty` and re-checks on a later reader mount.) Each
 * leg retries a TRANSIENT failure a couple of times with backoff (see
 * PIN_RETRY_*); beyond that it's best-effort — the pg_net trigger is one-shot,
 * and the client pre-warm / on-open generation remain the durable retry paths. */
async function runPinTriggeredWork(
  service: any,
  caller: InternalCaller,
  itemId: string,
): Promise<void> {
  // Each leg retries while it reports its outcome was TRANSIENT (see PIN_RETRY_*).
  // The two legs still run concurrently and don't block each other; a failed
  // attempt releases its lease, so the backoff sleep never holds the lease
  // against a concurrent caller.
  const retryCfg = {
    attempts: PIN_RETRY_ATTEMPTS,
    baseMs: PIN_RETRY_BASE_MS,
    sleep: pinRetrySleep,
  };
  const retryWhileTransient = (t: boolean) => t;
  const results = await Promise.allSettled([
    retryWhile(() => ensureFullTextForPin(caller, itemId), retryWhileTransient, retryCfg),
    retryWhile(() => generateSummaryForPin(service, itemId), retryWhileTransient, retryCfg),
  ]);
  const [full, summary] = results;
  if (full.status === 'rejected') {
    console.error(`summary: item ${itemId} — pin-triggered full-text leg failed:`, full.reason);
  }
  if (summary.status === 'rejected') {
    console.error(`summary: item ${itemId} — pin-triggered summary leg failed:`, summary.reason);
  }

  // Fallback re-attempt for the no-Jina path. Because the two legs run
  // concurrently, if Jina was unavailable/screened (key unset, down, or a
  // tokenized URL) AND the full body wasn't cached yet when the summary leg read
  // the item, the summary deferred on the truncated feed stub (a retryable
  // `empty`, uncached) — and nothing else re-invokes it server-side. Now that the
  // full-text leg has settled, retry the summary ONCE if it's still missing AND a
  // full body is now stored: that body is the summary's fallback text, restoring
  // the guarantee the old full-text-first sequencing gave. A no-op cache hit when
  // Jina already produced the summary (ai_summary set → generateSummaryForPin
  // returns early), and skipped entirely when no full body was downloaded (the
  // stub is all there is, so a retry can't do better).
  try {
    const { data } = await service
      .from('items')
      .select('ai_summary, full_content_html')
      .eq('id', itemId)
      .maybeSingle();
    if (data && !data.ai_summary && data.full_content_html) {
      console.log(`summary: item ${itemId} — pin-triggered: retrying summary now that full text landed`);
      // Wrap in the same transient retry as the initial leg: this is where the
      // no-Jina/stub path actually generates (from the now-landed full body), so
      // a Gemini/cache-write blip here must retry too, not silently lose the warm.
      await retryWhile(() => generateSummaryForPin(service, itemId), retryWhileTransient, retryCfg);
    }
  } catch (err) {
    console.error(`summary: item ${itemId} — pin-triggered fallback retry failed:`, err);
  }
}

/** Generate + cache the AI summary for a just-pinned item, if one isn't already
 * cached. Same generation guards as the user path (which the pin trigger's call
 * bypassed by returning its 202 before them): re-read the item, skip if it's
 * already summarized / the feed is paused / the key is unset, then single-flight
 * the Jina + Gemini pass. Runs CONCURRENTLY with the full-text download, so it
 * reads whatever body is stored now — Jina is its primary source anyway, and the
 * stored body is only the fallback. Best-effort (a throw surfaces as the summary
 * leg's rejection in runPinTriggeredWork).
 *
 * Returns whether the outcome was TRANSIENT (the caller retries iff true): a DB
 * read error, or a transient generation outcome (`unreachable`, a retryable
 * `empty` Jina-blip/stub-defer, or an uncached `ok` write-blip — see
 * isSummaryOutcomeTransient). A gone/paused/URL-less/cached result and an unset
 * key are terminal (false). */
async function generateSummaryForPin(service: any, itemId: string): Promise<boolean> {
  const { data: item, error } = await service
    .from('items')
    .select('id, feed_id, url, title, content_html, full_content_html, ai_summary')
    .eq('id', itemId)
    .maybeSingle();
  if (error) {
    // Transient DB read failure — worth a retry (the row is presumably there).
    console.error(`summary: item ${itemId} — pin-triggered re-read failed:`, error);
    return true;
  }
  if (!item) {
    // Row genuinely gone (unpinned + swept between the trigger and here) — terminal.
    console.warn(`summary: item ${itemId} — pin-triggered: item not found`);
    return false;
  }
  if (item.ai_summary) {
    console.log(`summary: item ${itemId} — pin-triggered: summary already cached`);
    return false;
  }
  const { data: feed } = await service
    .from('feeds')
    .select('paused')
    .eq('id', item.feed_id)
    .maybeSingle();
  if (feed?.paused) {
    console.log(`summary: item ${itemId} — pin-triggered: feed paused, declining`);
    return false;
  }
  const apiKey = Deno.env.get('GOOGLE_API_KEY');
  if (!apiKey) {
    console.warn('summary: pin-triggered: GOOGLE_API_KEY not set — skipping');
    await recordAiCall(service, { kind: 'summary', status: 'unavailable', itemId });
    return false;
  }
  const outcome = await coalesceSummaryGeneration({
    client: makeLeaseClient(service),
    itemId,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    generate: () => generateAndCacheLogged(service, apiKey, item, itemId),
  });
  console.log(`summary: item ${itemId} — pin-triggered generation: ${outcome.status}`);
  return isSummaryOutcomeTransient(outcome);
}

/** Make sure the pinned article's full body is downloaded + cached, via one
 * internal call to the `fulltext` function (same service bearer + named-user
 * shape as the trigger's own call; fulltext re-checks the allowlist and the
 * pin, then applies its usual truncation gate, robots checks, SSRF-hardened
 * fetch, sanitization, and cache write). An HTTP hop rather than an import so
 * the whole reading-mode pipeline stays in one place. Best-effort: any failure
 * is logged and the summary still generates from what's stored.
 *
 * Returns whether the outcome was TRANSIENT (the caller retries iff true). The
 * `fulltext` function OWNS that judgment and reports it as the `transient` field
 * on its envelope (a failed publisher fetch, its own DB-read blip, an uncached
 * `ok` write-blip, or a transient Jina fallback → true; a paywall, an auth wall,
 * a gone item → false). This hop just reads that bit — it doesn't second-guess it
 * from HTTP codes. The only thing it decides itself is a bodyless TRANSPORT
 * failure (network/timeout, or a platform 5xx with no envelope), which is
 * transient by nature. */
async function ensureFullTextForPin(
  caller: InternalCaller,
  itemId: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/fulltext`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ itemId, userId: caller.userId, email: caller.email }),
      signal: AbortSignal.timeout(FULLTEXT_KICK_TIMEOUT_MS),
    });
    const rec = await res.json().catch(() => null);
    console.log(
      `summary: item ${itemId} — pin-triggered full-text: HTTP ${res.status}, status ${rec?.status ?? 'n/a'}, transient ${rec?.transient ?? 'n/a'}`,
    );
    // The function declared its own retryability — trust it.
    if (typeof rec?.transient === 'boolean') return rec.transient;
    // No usable envelope (a platform error / non-JSON body): a 5xx is a transient
    // transport failure worth a retry; any other bodyless status is terminal.
    return res.status >= 500;
  } catch (err) {
    // Network / timeout / abort on the hop — transient.
    console.warn(`summary: item ${itemId} — pin-triggered full-text failed:`, err);
    return true;
  }
}

/** Run the actual Jina fetch + stored-body fallback + Gemini call + cache write
 * for one item, returning the normalized outcome. Called only by the elected
 * generator (or the last-resort fallback) inside coalesceSummaryGeneration. */
/** {@link generateAndCache} plus best-effort AI-call logging (0067). Wraps the
 * real generation so every ACTUAL summary Gemini call — on-demand and
 * pin-triggered alike — records its outcome to `ai_call_log` for /admin/ai,
 * without threading logging through the coalescer. Passed as the coalescer's
 * `generate`, which invokes it only for the caller that actually generates (a
 * coalesced WAIT for another caller's result never calls this), so only real
 * calls are logged, never cache hits or waits. */
async function generateAndCacheLogged(
  service: any,
  apiKey: string,
  item: { feed_id: string; url: string | null; title: string | null; content_html: string | null; full_content_html: string | null },
  itemId: string,
): Promise<SummaryOutcome> {
  const { outcome, httpStatus, logDetail } = await generateAndCache(service, apiKey, item, itemId);
  await recordAiCall(service, {
    kind: 'summary',
    status: outcome.status,
    // The model's response code when the call reached Gemini (e.g. 429/503), so
    // a summary failure is diagnosable from /admin/ai; null for a pre-call
    // outcome (no article text) or a transport-level failure (timeout/network).
    // For an HTTP-status block it's the publisher's access code (403/401/…).
    httpStatus,
    itemId,
    // A short reason for /admin/ai: the block detail (why a page was blocked)
    // when present, else the generic generation-failure note for `unreachable`.
    error: logDetail ?? (outcome.status === 'unreachable' ? 'summary generation failed' : null),
  });
  return outcome;
}

/** {@link generateAndCache}'s result: the wire {@link SummaryOutcome} plus two
 * fields kept OUT of the outcome so they never leak into the client envelope,
 * for the AI call log only. `httpStatus` is the model's (or, for an HTTP-status
 * block, the publisher's) HTTP code, null for an outcome decided before any
 * fetch/call. `logDetail` is a short human reason (e.g. why a page was
 * `blocked`) surfaced on /admin/ai, null when the status is self-explanatory. */
interface GenerateResult {
  outcome: SummaryOutcome;
  httpStatus: number | null;
  logDetail?: string | null;
}

async function generateAndCache(
  service: any,
  apiKey: string,
  item: { feed_id: string; url: string | null; title: string | null; content_html: string | null; full_content_html: string | null },
  itemId: string,
): Promise<GenerateResult> {
  // Article text: Jina markdown is the primary source (handles bot-blocked /
  // paywalled / JS-rendered pages, and keeps the summary off our polite
  // first-party fetcher). Fall back to the body we already store when Jina is
  // unconfigured, the URL looks secret-bearing, or the fetch fails.
  const jina = await maybeFetchViaJinaMarkdown(service, item.feed_id, item.url);
  let content = jina.text;
  let source = 'jina';
  if (!content) {
    const stored = pickStoredContent({
      contentHtml: item.content_html,
      fullContentHtml: item.full_content_html,
    });
    if (!stored) {
      // No Jina text AND no stored body. If Jina reported a stable non-2xx
      // ACCESS status (403/401/404/410/451), the page can't be read at all — show
      // the "Summary blocked by …" card instead of a silent `empty`, and spend no
      // Gemini call. (A transient 429/5xx isn't a block and falls through to the
      // retryable path below.)
      if (jina.status != null && isBlockingHttpStatus(jina.status)) {
        console.log(
          `summary: item ${itemId} — Jina HTTP ${jina.status}, no fallback body → blocked`,
        );
        return {
          outcome: { status: 'blocked', summary: null, site: siteLabel(item.url) },
          httpStatus: jina.status,
          logDetail: `blocked: fetch returned HTTP ${jina.status}`,
        };
      }
      // Otherwise TRANSIENT when the item has a URL — Jina may be unconfigured /
      // down / screened now (or a full body could be extracted later), so flag
      // `retryable` and the reader re-checks on a later mount once it can yield
      // text. Only a URL-less, body-less item is truly terminal.
      console.log(`summary: item ${itemId} — no article text from Jina or storage`);
      return {
        outcome: {
          status: 'empty',
          summary: null,
          ...(item.url ? { retryable: true } : {}),
        },
        httpStatus: null,
      };
    }
    if (!stored.cacheable) {
      // Only a truncated feed stub is available (Jina down/screened AND no full
      // body extracted yet). Don't spend a Gemini call summarizing a teaser that
      // can't improve until Jina or full-text extraction lands — a summary of the
      // stub would be both low-quality and uncacheable, so we'd re-pay Gemini on
      // every reader mount. Defer with a retryable `empty` instead (no card, no
      // spend); the next mount re-checks once better content exists.
      console.log(`summary: item ${itemId} — only a stub available, deferring (retryable empty)`);
      return { outcome: { status: 'empty', summary: null, retryable: true }, httpStatus: null };
    }
    content = stored.text;
    source = 'stored';
  }

  // The fetch returned text, but that "article" may itself be a block page —
  // r.jina.ai commonly returns a 403 wall / bot-block notice as 200 markdown, and
  // a feed body can be a "you don't have permission" stub. Detect that up front
  // and show "Summary blocked by …" rather than spending a Gemini call to produce
  // a verbose "there's no content to summarize" paragraph. Conservative (see
  // looksLikeBlockPage) so a real article isn't misread.
  if (looksLikeBlockPage(item.title, content)) {
    console.log(`summary: item ${itemId} — ${source} content looks like a block page → blocked`);
    return {
      outcome: { status: 'blocked', summary: null, site: siteLabel(item.url) },
      httpStatus: null,
      logDetail: `blocked: ${source} content looks like a block page`,
    };
  }

  // Content here is always the full article (Jina markdown, the extraction, or a
  // non-truncated feed body), so the generated summary is always safe to cache.
  const { text: summary, httpStatus } = await generateSummary(apiKey, item.title, content);
  if (!summary) {
    console.warn(`summary: item ${itemId} — generation failed`);
    return { outcome: { status: 'unreachable', summary: null }, httpStatus };
  }
  console.log(`summary: item ${itemId} — generated ${summary.length} chars from ${source}, caching`);

  // Cache on the shared item (service role; client item writes are revoked).
  const { error: writeError } = await service
    .from('items')
    .update({
      ai_summary: summary,
      ai_summary_generated_at: new Date().toISOString(),
    })
    .eq('id', itemId);
  if (writeError) {
    // The summary still succeeded for this caller; surface it even if the cache
    // write failed. `cached` stays false so the coalescer releases the lease and
    // a waiter regenerates rather than blocking on a summary that never landed.
    console.error(`summary: cache write for item ${itemId} failed:`, writeError);
    return { outcome: { status: 'ok', summary, cached: false }, httpStatus };
  }
  return { outcome: { status: 'ok', summary, cached: true }, httpStatus };
}

/** The generation-lease operations backed by the service-role Supabase client.
 * The lease is `items.ai_summary_generated_at` interpreted as "generation in
 * flight" while `ai_summary` is still null (see coalesceSummaryGeneration). */
function makeLeaseClient(service: any): SummaryLeaseClient {
  return {
    async claimLease(itemId, staleBeforeIso, nowIso) {
      // Atomic claim: stamp the lease iff the summary is still null AND no fresh
      // lease exists (null, or older than the TTL cutoff). One concurrent
      // caller's UPDATE matches the row; the rest match zero rows and go wait.
      const { data, error } = await service
        .from('items')
        .update({ ai_summary_generated_at: nowIso })
        .eq('id', itemId)
        .is('ai_summary', null)
        // Quote the timestamp: its ':'/'.' are reserved in the or() logic-tree
        // grammar, so an unquoted value could misparse.
        .or(`ai_summary_generated_at.is.null,ai_summary_generated_at.lt."${staleBeforeIso}"`)
        .select('id');
      if (error) {
        // Lease infra failed — fail OPEN to generation so the caller still gets a
        // summary (worst case a redundant Gemini call during a DB hiccup).
        console.error(`summary: lease claim for item ${itemId} failed, generating anyway:`, error);
        return true;
      }
      return (data?.length ?? 0) > 0;
    },
    async readState(itemId) {
      const { data } = await service
        .from('items')
        .select('ai_summary, ai_summary_generated_at')
        .eq('id', itemId)
        .maybeSingle();
      return {
        aiSummary: data?.ai_summary ?? null,
        leaseAt: data?.ai_summary_generated_at ?? null,
      };
    },
    async releaseLease(itemId, claimStamp) {
      // Reset the lease to null ONLY if we still hold it (exact stamp match) and
      // no summary landed — never clobber a written summary or a re-claimed lease.
      const { error } = await service
        .from('items')
        .update({ ai_summary_generated_at: null })
        .eq('id', itemId)
        .is('ai_summary', null)
        .eq('ai_summary_generated_at', claimStamp);
      if (error) {
        console.error(`summary: lease release for item ${itemId} failed:`, error);
      }
    },
  };
}

/** Fetch the article as Jina markdown, but only for URLs we're reasonably sure
 * carry no secret — the same two guards fulltext uses (guardrail #6):
 *   (a) skip feeds that carry a secret_url (definitely private; read with the
 *       service-role client), and
 *   (b) screen the item URL with looksTokenized() (query strings, long
 *       hex/base64url blobs, embedded credentials).
 * Either trips → return no text (don't forward to the third party), and the
 * caller falls back to the stored body. Returns the {@link JinaFetch} — clamped
 * markdown plus Jina's HTTP status (both null on a screen-out, since no request
 * is made). */
async function maybeFetchViaJinaMarkdown(
  service: any,
  feedId: string,
  url: string | null,
): Promise<JinaFetch> {
  if (!url) return { text: null, status: null };
  // Obey the same URL policy as our other server-side fetches before handing a
  // publisher-controlled URL to a third party (guardrail #6): http/https only,
  // no embedded credentials, and reject internal-address IP literals
  // (loopback / link-local incl. 169.254.169.254 / RFC1918). assertSafeUrl does
  // the scheme + IP-literal checks synchronously (no DNS — we don't connect to
  // the target ourselves; Jina does). Unsafe → don't forward; fall back to the
  // stored body. Note this is the URL screen the fulltext path gets for free via
  // safeFetch on its direct fetch; here Jina is the primary path, so we apply it
  // explicitly.
  try {
    assertSafeUrl(url);
  } catch {
    return { text: null, status: null };
  }
  // URL looks secret-bearing → never forward.
  if (looksTokenized(url)) return { text: null, status: null };
  const { data: feed } = await service
    .from('feeds')
    .select('secret_url')
    .eq('id', feedId)
    .maybeSingle();
  // Private/tokenized feed → skip.
  if (!feed || feed.secret_url) return { text: null, status: null };
  return fetchViaJinaMarkdown(url);
}

/** What a Jina fetch attempt yields: the clamped markdown (null when Jina is
 * unconfigured, the request failed, or the size cap was hit) plus the HTTP
 * `status` Jina returned — null on a transport failure (timeout/network) or when
 * no request was made. A stable non-2xx access status with no text lets the
 * caller show "Summary blocked by …" instead of a bare `empty`. */
interface JinaFetch {
  text: string | null;
  status: number | null;
}

/** Fetch a page via Jina Reader (r.jina.ai) as markdown. The fetch target is
 * always the fixed host r.jina.ai (the article URL only appears in the path), so
 * there's no redirect-based SSRF here. Returns the clamped markdown and Jina's
 * HTTP status (see {@link JinaFetch}). The URL has already been screened by
 * maybeFetchViaJinaMarkdown. */
async function fetchViaJinaMarkdown(target: string): Promise<JinaFetch> {
  const apiKey = Deno.env.get('JINA_API_KEY');
  if (!apiKey) return { text: null, status: null };
  try {
    const res = await fetch(`https://r.jina.ai/${target}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Return-Format': 'markdown',
        'Accept': 'text/markdown',
      },
      signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`summary: Jina responded HTTP ${res.status} for ${redactUrl(target)}`);
      return { text: null, status: res.status };
    }
    const reader = res.body?.getReader();
    let text: string;
    if (!reader) {
      text = await res.text();
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        total += value.byteLength;
        if (total > JINA_MAX_BYTES) {
          reader.cancel();
          console.warn(`summary: Jina body exceeded ${JINA_MAX_BYTES} bytes for ${redactUrl(target)}`);
          return { text: null, status: res.status };
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      text = new TextDecoder().decode(out);
    }
    return { text: clampSummaryText(text), status: res.status };
  } catch (err) {
    console.warn(`summary: Jina fetch failed for ${redactUrl(target)}:`, err);
    return { text: null, status: null };
  }
}

/** Call Gemini's `generateContent` REST endpoint for a short summary.
 * The target is the fixed Google host (the article is in the request body, never
 * a URL), so there's no SSRF surface. Returns the summary `text` (null on
 * timeout / non-2xx / unparseable response so the handler reports a soft
 * failure) plus the model's `httpStatus` when the call got a response — null on
 * a transport-level failure (timeout / network) — so the AI call log can record
 * a 429/503 etc. for /admin/ai (0067). `thinkingBudget: 0` disables the hidden
 * reasoning tokens that otherwise dominate latency for a task this small
 * (matches newshacker). */
async function generateSummary(
  apiKey: string,
  title: string | null,
  content: string,
): Promise<{ text: string | null; httpStatus: number | null }> {
  try {
    const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildSummaryPrompt(title, content) }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`summary: Gemini responded HTTP ${res.status}`);
      return { text: null, httpStatus: res.status };
    }
    const parsed = parseGeminiText(await res.json());
    if (!parsed) return { text: null, httpStatus: res.status };
    // Peel off any "tl;dr:" / "Here's a tl;dr of the article:" framing the model
    // echoed back before the gist (the prompt is deliberately unsteered). If
    // nothing but the preamble came back, treat it as a soft failure.
    return { text: stripSummaryPreamble(parsed) || null, httpStatus: res.status };
  } catch (err) {
    console.warn('summary: Gemini call failed:', err);
    return { text: null, httpStatus: null };
  }
}
