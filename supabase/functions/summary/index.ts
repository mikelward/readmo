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
//     FIRST make sure the full article is downloaded + cached (one internal
//     call to the `fulltext` function — truncation-gated there, mirroring the
//     client's pinned prefetch), THEN generate the summary if it's still
//     missing. Full text first on purpose: the pin should leave the article
//     readable offline, and the stored full body is the summary's fallback
//     text when Jina fails — sequencing keeps this one-shot kick from
//     deferring on a feed stub.
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
//   unavailable — the Gemini key isn't configured (`retryable:true`: re-checks
//                 once the operator sets GOOGLE_API_KEY).
//   unreachable — a transient failure (allowlist read, auth lookup, or the Gemini
//                 call failed); retryable.
// Hard errors keep their HTTP status: 400 (bad request), 401 (no JWT — platform),
// 404 (item not visible/found), 405 (wrong method).
//
// Thin entrypoint — prompt/parse/select logic is unit-tested in _shared/summary.ts.
// Deno resolves bare specifiers via ../import_map.json.

// @ts-nocheck — runs under Deno, not node/tsc.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { loadAllowlistFromDb, isAllowed } from '../_shared/allowlist.ts';
import { looksTokenized, redactUrl } from '../_shared/urlSafety.ts';
import { assertSafeUrl } from '../_shared/ssrf.ts';
import {
  buildSummaryPrompt,
  clampSummaryText,
  coalesceSummaryGeneration,
  parseGeminiText,
  pickStoredContent,
  stripSummaryPreamble,
} from '../_shared/summary.ts';
import type { SummaryLeaseClient, SummaryOutcome } from '../_shared/summary.ts';
import {
  isInternalCallerAllowed,
  resolveInternalCaller,
} from '../_shared/internalCaller.ts';
import type { InternalCaller } from '../_shared/internalCaller.ts';

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
  }
  if (!item) {
    console.warn(`summary: item ${itemId} not found or not visible to caller`);
    return json({ error: 'Item not found' }, 404);
  }

  if (caller.internal) {
    // The pin trigger's call is fire-and-forget: nothing reads the outcome, and
    // pg_net aborts the request at its timeout — well inside the fulltext +
    // Jina + Gemini work. So answer now (every gate above passed) and do the
    // real work in the background: full-text download first, then the summary
    // (see runPinTriggeredWork). Fall back to a synchronous run on a runtime
    // without waitUntil (the request may then be aborted mid-work, which is no
    // worse than the pre-trigger status quo).
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
    // Not configured. Retryable so the reader re-checks once the operator sets
    // the secret, rather than caching "no summary" forever.
    console.warn('summary: GOOGLE_API_KEY not set — unavailable');
    return json({ status: 'unavailable', summary: null, retryable: true });
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
    generate: () => generateAndCache(service, apiKey, item, itemId),
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

/** The pin trigger's background work (runs under EdgeRuntime.waitUntil after
 * the 202 is sent). Full text FIRST — the pin should leave the article fully
 * readable offline, and the stored full body is the summary's fallback text
 * when Jina fails — then the summary, if one is still missing. Every step is
 * best-effort: the trigger is one-shot, and the client pre-warm / on-open
 * generation remain the retry paths. */
async function runPinTriggeredWork(
  service: any,
  caller: InternalCaller,
  itemId: string,
): Promise<void> {
  try {
    await ensureFullTextForPin(caller, itemId);

    // Re-read the item AFTER the full-text step: the row may now carry
    // full_content_html (a better Gemini fallback than the pre-fulltext read),
    // or a summary another caller cached while we fetched.
    const { data: item, error } = await service
      .from('items')
      .select('id, feed_id, url, title, content_html, full_content_html, ai_summary')
      .eq('id', itemId)
      .maybeSingle();
    if (error || !item) {
      console.error(`summary: item ${itemId} — pin-triggered re-read failed:`, error);
      return;
    }
    if (item.ai_summary) {
      console.log(`summary: item ${itemId} — pin-triggered: summary already cached`);
      return;
    }

    // Same generation guards as the user path (which this call bypassed by
    // returning its 202 before them).
    const { data: feed } = await service
      .from('feeds')
      .select('paused')
      .eq('id', item.feed_id)
      .maybeSingle();
    if (feed?.paused) {
      console.log(`summary: item ${itemId} — pin-triggered: feed paused, declining`);
      return;
    }
    const apiKey = Deno.env.get('GOOGLE_API_KEY');
    if (!apiKey) {
      console.warn('summary: pin-triggered: GOOGLE_API_KEY not set — skipping');
      return;
    }

    const outcome = await coalesceSummaryGeneration({
      client: makeLeaseClient(service),
      itemId,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      generate: () => generateAndCache(service, apiKey, item, itemId),
    });
    console.log(`summary: item ${itemId} — pin-triggered generation: ${outcome.status}`);
  } catch (err) {
    console.error(`summary: item ${itemId} — pin-triggered work failed:`, err);
  }
}

/** Make sure the pinned article's full body is downloaded + cached, via one
 * internal call to the `fulltext` function (same service bearer + named-user
 * shape as the trigger's own call; fulltext re-checks the allowlist and the
 * pin, then applies its usual truncation gate, robots checks, SSRF-hardened
 * fetch, sanitization, and cache write). An HTTP hop rather than an import so
 * the whole reading-mode pipeline stays in one place. Best-effort: any failure
 * is logged and the summary still generates from what's stored. */
async function ensureFullTextForPin(
  caller: InternalCaller,
  itemId: string,
): Promise<void> {
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
    const rec = res.ok ? await res.json().catch(() => null) : null;
    console.log(
      `summary: item ${itemId} — pin-triggered full-text: HTTP ${res.status}, status ${rec?.status ?? 'n/a'}`,
    );
  } catch (err) {
    console.warn(`summary: item ${itemId} — pin-triggered full-text failed:`, err);
  }
}

/** Run the actual Jina fetch + stored-body fallback + Gemini call + cache write
 * for one item, returning the normalized outcome. Called only by the elected
 * generator (or the last-resort fallback) inside coalesceSummaryGeneration. */
async function generateAndCache(
  service: any,
  apiKey: string,
  item: { feed_id: string; url: string | null; title: string | null; content_html: string | null; full_content_html: string | null },
  itemId: string,
): Promise<SummaryOutcome> {
  // Article text: Jina markdown is the primary source (handles bot-blocked /
  // paywalled / JS-rendered pages, and keeps the summary off our polite
  // first-party fetcher). Fall back to the body we already store when Jina is
  // unconfigured, the URL looks secret-bearing, or the fetch fails.
  let content = await maybeFetchViaJinaMarkdown(service, item.feed_id, item.url);
  let source = 'jina';
  if (!content) {
    const stored = pickStoredContent({
      contentHtml: item.content_html,
      fullContentHtml: item.full_content_html,
    });
    if (!stored) {
      // No Jina text AND no stored body. If the item has a URL this is
      // TRANSIENT — Jina may be unconfigured / down / screened now (or a full
      // body could be extracted later), so flag `retryable` and the reader
      // re-checks on a later mount once it can yield text. Only a URL-less,
      // body-less item is truly terminal (nothing to ever summarize).
      console.log(`summary: item ${itemId} — no article text from Jina or storage`);
      return {
        status: 'empty',
        summary: null,
        ...(item.url ? { retryable: true } : {}),
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
      return { status: 'empty', summary: null, retryable: true };
    }
    content = stored.text;
    source = 'stored';
  }

  // Content here is always the full article (Jina markdown, the extraction, or a
  // non-truncated feed body), so the generated summary is always safe to cache.
  const summary = await generateSummary(apiKey, item.title, content);
  if (!summary) {
    console.warn(`summary: item ${itemId} — generation failed`);
    return { status: 'unreachable', summary: null };
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
    return { status: 'ok', summary, cached: false };
  }
  return { status: 'ok', summary, cached: true };
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
 * Either trips → return null (don't forward to the third party), and the caller
 * falls back to the stored body. Returns clamped markdown, or null. */
async function maybeFetchViaJinaMarkdown(
  service: any,
  feedId: string,
  url: string | null,
): Promise<string | null> {
  if (!url) return null;
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
    return null;
  }
  if (looksTokenized(url)) return null; // URL looks secret-bearing → never forward
  const { data: feed } = await service
    .from('feeds')
    .select('secret_url')
    .eq('id', feedId)
    .maybeSingle();
  if (!feed || feed.secret_url) return null; // private/tokenized feed → skip
  return fetchViaJinaMarkdown(url);
}

/** Fetch a page via Jina Reader (r.jina.ai) as markdown. The fetch target is
 * always the fixed host r.jina.ai (the article URL only appears in the path), so
 * there's no redirect-based SSRF here. Returns clamped markdown, or null if Jina
 * is unconfigured or the request fails / exceeds the size cap. The URL has
 * already been screened by maybeFetchViaJinaMarkdown. */
async function fetchViaJinaMarkdown(target: string): Promise<string | null> {
  const apiKey = Deno.env.get('JINA_API_KEY');
  if (!apiKey) return null;
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
      return null;
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
          return null;
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
    return clampSummaryText(text);
  } catch (err) {
    console.warn(`summary: Jina fetch failed for ${redactUrl(target)}:`, err);
    return null;
  }
}

/** Call Gemini's `generateContent` REST endpoint for a short summary.
 * The target is the fixed Google host (the article is in the request body, never
 * a URL), so there's no SSRF surface. Returns the summary text, or null on
 * timeout / non-2xx / unparseable response so the handler reports a soft failure.
 * `thinkingBudget: 0` disables the hidden reasoning tokens that otherwise
 * dominate latency for a task this small (matches newshacker). */
async function generateSummary(
  apiKey: string,
  title: string | null,
  content: string,
): Promise<string | null> {
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
      return null;
    }
    const parsed = parseGeminiText(await res.json());
    if (!parsed) return null;
    // Peel off any "tl;dr:" / "Here's a tl;dr of the article:" framing the model
    // echoed back before the gist (the prompt is deliberately unsteered). If
    // nothing but the preamble came back, treat it as a soft failure.
    return stripSummaryPreamble(parsed) || null;
  } catch (err) {
    console.warn('summary: Gemini call failed:', err);
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}
