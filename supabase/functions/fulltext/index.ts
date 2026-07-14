// Readmo full-text (reading-mode) extraction — Edge Function.
//
// POST /functions/v1/fulltext { itemId }
// Fetches the article's own page, extracts the main body (Readability), and
// caches the SANITIZED result on the shared item so the reader can show a clean
// reading view instead of a truncated feed stub. SPEC.md "Full-text reading
// mode".
//
// Trust + access:
//   - The caller's forwarded JWT scopes the item lookup through RLS (items_select,
//     0002): a user who can't see the item gets a 404 — they cannot trigger a
//     fetch for an article they aren't entitled to. The service-role client does
//     the cached write (client item writes are revoked; 0002/0009).
//   - INTERNAL caller: the DB pin trigger — via the `summary` function's
//     pin-triggered work — calls this with the service-role bearer + the
//     pinning user's identity (resolveInternalCaller, _shared/internalCaller.ts),
//     so a pinned article's full body is downloaded even if the app closes
//     right after the pin. That path REQUIRES the named user on the allowlist
//     (empty list → no one; the server-initiated cost-guard convention),
//     proves visibility by the pinned item_state row itself, and only fetches
//     when the feed body looks truncated — the same gate the client's pinned
//     prefetch applies (useOfflineCacheLock), so a pin never downloads a page
//     whose feed body is already the whole article.
//   - Reading mode is the highest copyright-exposure surface (it fetches beyond
//     the feed AND stores a shared copy), so the DB `allowlist` table (the shared
//     trusted-user list, managed from /admin; see _shared/allowlist.ts) restricts
//     who may use it. Empty → open to all; once armed, a non-listed caller gets
//     the silent `empty` fallback before any item lookup or cache read, so they
//     never receive full content.
//   - The article fetch is a brand-new publisher fetch of a user-influenced URL,
//     so it goes through safeFetch (SSRF-hardened: scheme allow-list, resolved-IP
//     denylist incl. metadata, redirect re-validation, timeout + size cap, no
//     credential forwarding — guardrail #6).
//   - Extracted HTML is untrusted publisher content and is run through
//     sanitizeContent() before it is ever stored or returned. We never store or
//     serve raw publisher HTML.
//
// Outcomes are reported as a 200 { status, contentHtml } envelope so the client
// can render the right thing without treating "soft" results as hard errors:
//   ok          — extracted (or cache hit); contentHtml is sanitized HTML. When
//                 the body came from the bot-block fallback fetch (r.jina.ai)
//                 rather than a direct fetch, the envelope also carries
//                 `viaFallback:true` so the reader can show a "via fallback"
//                 provenance label. Additive field (omitted = direct fetch);
//                 only allowlisted callers ever receive an `ok` body, so
//                 fallback content stays restricted to them.
//   empty       — page fetched but no article-like body found (paywall/teaser);
//                 also the reading-mode allowlist denial, then flagged
//                 `retryable:true` so a later allowlist change un-sticks the
//                 caller (additive field; old clients still see plain `empty`)
//   auth        — the publisher gated the page (401/403) and Jina couldn't help
//   unreachable — the fetch failed (network/SSRF-blocked/non-2xx/oversized)
// Hard errors keep their HTTP status: 400 (bad request), 401 (no JWT — platform),
// 404 (item not visible/found), 405 (wrong method).
//
// Bot-blocking fallback (Jina Reader) — gated tighter than discover/index.ts.
// Many publishers 403 a plain server fetch (Cloudflare etc.), so a 403 retries
// via r.jina.ai. But full-text runs on per-item ARTICLE URLs, which — unlike the
// public site URL discovery sees — can embed a subscriber token, and there's no
// reliable "public feed" signal (a freshly-pasted tokenized feed URL lands in
// feeds.url with secret_url null; see 0004). So before forwarding to the third
// party we (a) skip feeds that DO carry a secret_url, and (b) screen the item
// URL with looksTokenized() and skip anything that looks like it embeds a secret
// (query string, long hex/base64url blob, credentials). A tokenized/private URL
// reports `auth` instead (guardrail #6). Heuristic, not a proof — see PR #56.
// Thin entrypoint — extraction/sanitization logic is unit-tested in _shared.
// Deno resolves bare specifiers via ../import_map.json.

// @ts-nocheck — runs under Deno, not node/tsc.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { extractArticle } from '../_shared/fulltext.ts';
import { sanitizeContent } from '../_shared/sanitize.ts';
import { safeFetch } from '../_shared/ssrf.ts';
import { robotsCheck } from '../_shared/robots.ts';
import { looksTokenized, redactUrl } from '../_shared/urlSafety.ts';
import { preflight } from '../_shared/cors.ts';
import { loadAllowlistFromDb, isAllowed } from '../_shared/allowlist.ts';
import {
  isInternalCallerAllowed,
  resolveInternalCaller,
} from '../_shared/internalCaller.ts';
import { looksTruncatedHtml } from '../_shared/summary.ts';
import { coalesceGeneration } from '../_shared/coalesce.ts';
import type { GenerationLeaseClient, GenerationOutcome } from '../_shared/coalesce.ts';
import { jsonCors as json } from '../_shared/respond.ts';

const JINA_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
const FETCH_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB — article pages can be large

// Single-flight lease timings (see coalesceGeneration). The lease TTL must exceed
// the worst-case in-lease work: safeFetch (≤12 s) + a redirect robots re-check
// (≤5 s) + the Jina bot-block fallback (≤15 s) + extraction ≈ 32 s. 60 s leaves
// headroom so a slow-but-alive fetch isn't preempted; a waiter blocks up to ~45 s
// before self-generating.
const FULLTEXT_LEASE_TTL_MS = 60_000;
const FULLTEXT_POLL_INTERVAL_MS = 750;
const FULLTEXT_MAX_WAIT_MS = 45_000;

/** The `fulltext` function's cached artifact + wire envelope: the extracted body
 * (or a soft-failure status). Mirrors the JSON response the reader reads. */
interface FullTextResult {
  status: 'ok' | 'empty' | 'auth' | 'unreachable';
  contentHtml: string | null;
  viaFallback?: boolean;
  retryable?: boolean;
}

Deno.serve(async (req: Request) => {
  // Top-level guard so an unexpected throw produces an Edge Function log
  // line, not a bare EDGE_FUNCTION_ERROR.
  try {
    return await handle(req);
  } catch (err) {
    console.error('fulltext: unhandled error:', err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') {
    console.warn(`fulltext: rejected ${req.method} (POST only)`);
    return json({ error: 'POST only' }, 405);
  }

  let itemId: string | undefined;
  let bodyUserId: unknown;
  let bodyEmail: unknown;
  try {
    ({ itemId, userId: bodyUserId, email: bodyEmail } = await req.json());
  } catch {
    console.warn('fulltext: rejected request with invalid JSON body');
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof itemId !== 'string' || !itemId) {
    console.warn('fulltext: rejected request with missing itemId');
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

  // The pin trigger's internal call (relayed via the `summary` function) vs. a
  // normal user call. Internal requires the service-role bearer AND an explicit
  // userId; anything else is a user call and the body's identity fields are
  // ignored (never trusted).
  const caller = resolveInternalCaller({
    authHeader,
    serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    userId: bodyUserId,
    email: bodyEmail,
  });
  if (caller.internal) {
    console.log(`fulltext: pin-trigger call for item ${itemId}`);
  }

  // Reading-mode allowlist (guardrail #6's content-exposure cousin): full text
  // both fetches beyond the feed AND stores a shared copy, so the operator can
  // restrict it to themselves/family via the `allowlist` table (the shared
  // trusted-user list, managed from /admin — see _shared/allowlist.ts). Checked
  // BEFORE the item lookup and the cache-hit return, so a non-allowlisted caller
  // never receives full content — cached or fresh. An EMPTY list leaves the
  // feature open to all. A blocked caller gets a silent `empty` flagged
  // `retryable` so a later allowlist change un-sticks them, without a new wire
  // status old clients can't read (SPEC "Full-text reading mode").
  let allowlist: Set<string>;
  try {
    allowlist = await loadAllowlistFromDb(service);
  } catch (err) {
    // Fail CLOSED on a DB read error: don't serve full content if we can't
    // confirm the gate. `unreachable` is retryable and caches nothing, so an
    // allowlisted caller simply retries rather than being stranded or leaked to.
    console.error('fulltext: allowlist read failed — retryable unreachable:', err);
    return json({ status: 'unreachable', contentHtml: null });
  }
  if (caller.internal) {
    // The trigger names the pinning user; gate on THAT identity (the DB has no
    // user JWT to forward). Server-initiated work REQUIRES a listed user — an
    // empty allowlist triggers for no one (the cost-guard convention, unlike
    // the client path's "empty = open" below). Silent decline; nothing reads
    // this response but the summary function's log line.
    if (!isInternalCallerAllowed(caller, allowlist)) {
      console.log('fulltext: pinning user not on the allowlist — declining');
      return json({ status: 'empty', contentHtml: null, retryable: true });
    }
  } else if (allowlist.size > 0) {
    const { data: auth, error: authError } = await userClient.auth.getUser();
    if (authError || !auth?.user) {
      // A transient auth lookup failure must NOT be cached as the terminal
      // `empty` outcome (fullTextStaleTime treats `empty` as non-retryable),
      // or an allowlisted caller would be stuck on the feed body until the
      // local query cache clears. Report the retryable `unreachable` instead;
      // only a CONFIRMED non-allowlisted user (below) gets `empty`.
      console.warn('fulltext: auth lookup failed — retryable unreachable:', authError);
      return json({ status: 'unreachable', contentHtml: null });
    }
    if (!isAllowed({ id: auth.user.id, email: auth.user.email }, allowlist)) {
      // Confirmed non-allowlisted caller. Report the silent `empty` outcome (the
      // reader shows the feed body, no error) but flag it `retryable` so the
      // client keeps it stale: if the operator later adds this caller to the
      // allowlist, the next open re-checks the gate instead of staying stuck on
      // a forever-cached denial. `retryable` is an ADDITIVE field, so a
      // service-worker-cached older client that only reads `status` still
      // renders the plain silent `empty` (guardrail #11) — no error, no new
      // wire status to choke on.
      console.log('fulltext: caller not on the allowlist — feed-stub fallback');
      return json({ status: 'empty', contentHtml: null, retryable: true });
    }
  }

  // Item lookup. User path: RLS-scoped through the forwarded JWT — only
  // resolves if the caller may see this item. Internal path: the service role
  // bypasses RLS, so visibility is proven FIRST by the pinned item_state row
  // the trigger fired on (the same permanent-state grant items_select honors;
  // 0002) — no pin row (unpinned again before we ran, or a forged id) means no
  // fetch (fail closed, 404 like the user path). The internal read also pulls
  // content_html for the truncation gate below.
  const itemColumns = 'id, feed_id, url, title, full_content_html, full_content_via_fallback';
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
      console.error(`fulltext: pin lookup for item ${itemId} failed:`, pinError);
      return json({ status: 'unreachable', contentHtml: null });
    }
    if (!pin) {
      console.warn(`fulltext: item ${itemId} not pinned by the named user — declining`);
      return json({ error: 'Item not found' }, 404);
    }
    const { data, error } = await service
      .from('items')
      .select(`${itemColumns}, content_html`)
      .eq('id', itemId)
      .maybeSingle();
    if (error) {
      console.error(`fulltext: item lookup for ${itemId} failed:`, error);
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
      console.error(`fulltext: item lookup for ${itemId} failed:`, error);
      return json({ error: error.message }, 400);
    }
    item = data;
  }
  if (!item) {
    console.warn(`fulltext: item ${itemId} not found or not visible to caller`);
    return json({ error: 'Item not found' }, 404);
  }

  // Cache hit — serve the previously extracted body without re-fetching. A
  // fallback-sourced body carries `viaFallback` so the reader can label it; only
  // allowlisted callers reach this return (the gate above), so fallback content
  // never leaves through an open door. Additive (omitted = direct fetch).
  if (item.full_content_html) {
    console.log(`fulltext: item ${itemId} — cache hit`);
    return json({
      status: 'ok',
      contentHtml: item.full_content_html,
      ...(item.full_content_via_fallback ? { viaFallback: true } : {}),
    });
  }
  // Pin-triggered download: only fetch when the feed body looks truncated —
  // the same gate the client's pinned prefetch applies (useOfflineCacheLock /
  // looksTruncated), sharing the client's 600-char threshold via
  // looksTruncatedHtml. A complete feed body IS the article; the reader never
  // shows an extraction for it unless the user asks, so downloading the page
  // would spend a publisher fetch (and raise the stored-copy exposure) for
  // content nothing displays. A user-initiated call is unaffected — the client
  // already applied this gate (or the user asked explicitly via "Read more").
  // Not recorded as a download attempt: nothing was attempted.
  if (caller.internal && !looksTruncatedHtml(item.content_html)) {
    console.log(`fulltext: item ${itemId} — feed body not truncated, nothing to fetch`);
    return json({ status: 'empty', contentHtml: null, retryable: true });
  }
  // Paused feed → decline a NEW download (operator paused it from /admin/feeds).
  // Already-cached bodies still serve via the cache-hit return above; this only
  // blocks a fresh fetch. Silent `empty` (reader keeps the feed body), flagged
  // retryable so unpausing later re-checks. Not recorded as an attempt — the
  // feed's row already shows Paused, and we don't want to clobber its last real
  // download outcome.
  {
    const { data: feed } = await service
      .from('feeds')
      .select('paused')
      .eq('id', item.feed_id)
      .maybeSingle();
    if (feed?.paused) {
      console.log(`fulltext: item ${itemId} — feed paused, declining download`);
      return json({ status: 'empty', contentHtml: null, retryable: true });
    }
  }

  if (!item.url) {
    await recordAttempt(service, itemId, 'empty', { error: 'item has no URL' });
    return json({ status: 'empty', contentHtml: null });
  }

  // Reading mode crawls the article's OWN page (beyond the syndicated feed), so
  // ask the publisher's robots.txt first. Fail OPEN: a missing/unreachable/
  // unparseable robots.txt allows the fetch (robotsAllows handles that). Only a
  // robots.txt that explicitly disallows our crawler blocks it — reported as the
  // silent `empty` outcome (reader keeps the feed body + Open original), the same
  // UX as a paywall/teaser, so no new wire status for older clients to choke on.
  const robots = await robotsCheck(item.url);
  if (!robots.allowed) {
    console.log(`fulltext: item ${itemId} (${redactUrl(item.url)}) disallowed by robots.txt`);
    await recordAttempt(service, itemId, 'empty', {
      error: robotsReason(robots.matchedUserAgent),
      robotsRule: robots.rule,
    });
    return json({ status: 'empty', contentHtml: null });
  }

  // Single-flight the publisher fetch + extract + cache. Concurrent callers for
  // the same item — the pin-trigger internal call racing the reader's on-open
  // fetch, the same article open on phone + desktop — would otherwise EACH hit
  // the publisher. Only the elected caller fetches; the rest wait and return its
  // cached body the instant it lands (N misses → one fetch on the happy path).
  // The lease reuses `full_content_fetched_at` as the in-flight marker while
  // `full_content_html` is null — the same durable-row-marker pattern the summary
  // uses on `ai_summary_generated_at`, needing no migration: this function is the
  // only writer of the column and the poller never resets it, so the marker
  // neither leaks nor outlives an edit. See coalesceGeneration.
  const outcome = await coalesceGeneration<FullTextResult>({
    client: makeFullTextLeaseClient(service),
    itemId,
    generate: () => generateFullText(service, item, itemId),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    leaseTtlMs: FULLTEXT_LEASE_TTL_MS,
    pollIntervalMs: FULLTEXT_POLL_INTERVAL_MS,
    maxWaitMs: FULLTEXT_MAX_WAIT_MS,
  });
  return json(outcome.result);
}

/** The generation-lease operations backed by the service-role Supabase client.
 * The lease is `items.full_content_fetched_at` interpreted as "a download is in
 * flight" while `full_content_html` is still null (mirrors the summary's
 * `makeLeaseClient`). A caller that WINS the claim runs the real fetch; the rest
 * poll `full_content_html` and return it the instant it lands. */
function makeFullTextLeaseClient(service: any): GenerationLeaseClient<FullTextResult> {
  return {
    async claimLease(itemId, staleBeforeIso, nowIso) {
      // Atomic claim: stamp the marker iff the body is still null AND no fresh
      // marker exists (null, or older than the TTL cutoff). One concurrent
      // caller's UPDATE matches the row; the rest match zero rows and go wait.
      const { data, error } = await service
        .from('items')
        .update({ full_content_fetched_at: nowIso })
        .eq('id', itemId)
        .is('full_content_html', null)
        // Quote the timestamp: its ':'/'.' are reserved in the or() logic-tree
        // grammar, so an unquoted value could misparse.
        .or(`full_content_fetched_at.is.null,full_content_fetched_at.lt."${staleBeforeIso}"`)
        .select('id');
      if (error) {
        // Lease infra failed — fail OPEN to a fetch so the caller still gets a
        // body (worst case a redundant publisher fetch during a DB hiccup).
        console.error(`fulltext: lease claim for item ${itemId} failed, fetching anyway:`, error);
        return true;
      }
      return (data?.length ?? 0) > 0;
    },
    async readState(itemId) {
      const { data } = await service
        .from('items')
        .select('full_content_html, full_content_via_fallback, full_content_fetched_at')
        .eq('id', itemId)
        .maybeSingle();
      const html = data?.full_content_html ?? null;
      return {
        result: html
          ? {
              status: 'ok',
              contentHtml: html,
              ...(data?.full_content_via_fallback ? { viaFallback: true } : {}),
            }
          : null,
        leaseAt: data?.full_content_fetched_at ?? null,
      };
    },
    async releaseLease(itemId, claimStamp) {
      // Reset the marker to null ONLY if we still hold it (exact stamp match) and
      // no body landed — never clobber a written body or a re-claimed marker.
      const { error } = await service
        .from('items')
        .update({ full_content_fetched_at: null })
        .eq('id', itemId)
        .is('full_content_html', null)
        .eq('full_content_fetched_at', claimStamp);
      if (error) {
        console.error(`fulltext: lease release for item ${itemId} failed:`, error);
      }
    },
  };
}

/** Run the actual publisher fetch (+ redirect robots re-check + Jina bot-block
 * fallback) → Readability extraction → sanitize → cache write for one item, and
 * record the download attempt. Called only by the elected generator (or the
 * last-resort fallback) inside coalesceGeneration. `cached: true` iff the body
 * was persisted to `full_content_html` — so waiters can read it and the lease is
 * kept; every soft failure (and an `ok` whose write failed) returns `cached:
 * false` so the lease releases and a waiter regenerates. */
async function generateFullText(
  service: any,
  item: { feed_id: string; url: string; title: string | null },
  itemId: string,
): Promise<GenerationOutcome<FullTextResult>> {
  console.log(`fulltext: fetching item ${itemId} (${redactUrl(item.url)})`);
  let body: string;
  let finalUrl = item.url;
  // Whether this body came from the bot-block fallback fetch (r.jina.ai) rather
  // than a direct fetch — recorded on the cached row and surfaced to the reader
  // as a "via fallback" provenance label.
  let viaFallback = false;
  // The publisher's direct-fetch HTTP status, captured for the persisted
  // download-attempt record (/admin/feeds). Null until we get a response.
  let directHttp: number | null = null;
  try {
    const res = await safeFetch(item.url, {
      timeoutMs: 12_000,
      maxBytes: FETCH_MAX_BYTES,
    });
    directHttp = res.status;
    console.log(`fulltext: item ${itemId} responded HTTP ${res.status}`);
    // Re-check robots.txt on the FINAL URL after redirects, for EVERY status
    // branch and BEFORE the Jina fallback. safeFetch follows redirects
    // internally, so res.url can be a different origin/path than the item.url we
    // authorized above. This must run before the 401/403 Jina path too: an
    // allowed short link can redirect to a robots-disallowed bot-wall page, and
    // Jina would otherwise extract + cache that destination's body. A disallowed
    // destination drops everything (no Jina, no extract, no cache), reported as
    // the silent `empty`. (The accepted residual is only that the direct GET to
    // res.url already happened — we never store or serve it.)
    if (res.url !== item.url) {
      const finalRobots = await robotsCheck(res.url);
      if (!finalRobots.allowed) {
        console.log(`fulltext: item ${itemId} final URL (${redactUrl(res.url)}) disallowed by robots.txt`);
        await recordAttempt(service, itemId, 'empty', {
          httpStatus: res.status,
          error: `redirect destination ${robotsReason(finalRobots.matchedUserAgent)}`,
          robotsRule: finalRobots.rule,
        });
        return { result: { status: 'empty', contentHtml: null }, cached: false };
      }
    }
    if (res.status === 401 || res.status === 403) {
      // Login/bot wall. Retry via Jina ONLY for public feeds (no secret_url),
      // so we never forward a possibly-tokenized item URL to a third party.
      console.log(`fulltext: item ${itemId} HTTP ${res.status} — trying Jina fallback`);
      const jinaHtml = await maybeFetchViaJina(service, item.feed_id, item.url);
      if (jinaHtml === null) {
        console.log(`fulltext: item ${itemId} — Jina unavailable or URL tokenized`);
        await recordAttempt(service, itemId, 'auth', { httpStatus: res.status });
        return { result: { status: 'auth', contentHtml: null }, cached: false };
      }
      console.log(`fulltext: item ${itemId} — Jina returned HTML`);
      body = jinaHtml;
      viaFallback = true;
    } else if (res.status >= 400) {
      await recordAttempt(service, itemId, 'unreachable', { httpStatus: res.status });
      return { result: { status: 'unreachable', contentHtml: null }, cached: false };
    } else {
      body = new TextDecoder().decode(res.body);
      finalUrl = res.url;
    }
  } catch (err) {
    // SSRF-blocked, DNS failure, timeout, oversized body — all "unreachable"
    // to the caller, but log so a publisher that always fails is diagnosable.
    // Article URLs can embed a subscriber token (the file-level comment calls
    // this out for the Jina path); redact to scheme://host before logging.
    console.warn(`fulltext: fetch for item ${itemId} (${redactUrl(item.url)}) failed:`, err);
    await recordAttempt(service, itemId, 'unreachable', {
      httpStatus: directHttp,
      error: err instanceof Error ? err.message : String(err),
    });
    return { result: { status: 'unreachable', contentHtml: null }, cached: false };
  }

  // Pass the item's title so a body heading that just repeats the headline the
  // reader already renders above the body is dropped (no duplicated title).
  const extracted = extractArticle(body, finalUrl, item.title ?? undefined);
  if (!extracted) {
    console.log(`fulltext: item ${itemId} — no article body extracted (paywall/teaser?)`);
    await recordAttempt(service, itemId, 'empty', {
      httpStatus: directHttp,
      error: 'no article body extracted (paywall/teaser?)',
    });
    return { result: { status: 'empty', contentHtml: null }, cached: false };
  }

  // Sanitize the extracted body before it is stored OR returned (guardrail #6).
  const clean = sanitizeContent(extracted.contentHtml, finalUrl);
  if (!clean) {
    console.log(`fulltext: item ${itemId} — sanitized body empty`);
    await recordAttempt(service, itemId, 'empty', {
      httpStatus: directHttp,
      error: 'sanitized body empty',
    });
    return { result: { status: 'empty', contentHtml: null }, cached: false };
  }
  console.log(`fulltext: item ${itemId} — extracted ${clean.length} chars, caching`);

  // Cache on the shared item (service role; client item writes are revoked).
  const { error: writeError } = await service
    .from('items')
    .update({
      full_content_html: clean,
      full_content_fetched_at: new Date().toISOString(),
      full_content_via_fallback: viaFallback,
    })
    .eq('id', itemId);
  // Record the successful download. On the Jina fallback path the direct fetch
  // was a 401/403, so its status would misrepresent the (successful) outcome —
  // omit the HTTP code there; the reader/admin see 'ok' regardless.
  await recordAttempt(service, itemId, 'ok', {
    httpStatus: viaFallback ? null : directHttp,
  });
  const okBody: FullTextResult = {
    status: 'ok',
    contentHtml: clean,
    ...(viaFallback ? { viaFallback: true } : {}),
  };
  if (writeError) {
    // The extraction still succeeded for this caller; surface it even if the
    // cache write failed (next caller just re-extracts). `cached` stays false so
    // the coalescer releases the lease and a waiter regenerates rather than
    // blocking on a body that never landed. Log so a persistently failing cache
    // write doesn't stay invisible.
    console.error(`fulltext: cache write for item ${itemId} failed:`, writeError);
    return { result: okBody, cached: false };
  }

  return { result: okBody, cached: true };
}

/** Fetch via Jina, but only for URLs we're reasonably sure carry no secret.
 * Two gates: (a) skip feeds that carry a secret_url (definitely private; the
 * server-only column is read via the service-role client), and (b) screen the
 * item URL itself with looksTokenized() — query strings, long hex/base64url
 * blobs, embedded credentials. Either trips → don't forward (return null). */
async function maybeFetchViaJina(
  service: any,
  feedId: string,
  url: string,
): Promise<string | null> {
  if (looksTokenized(url)) return null; // URL looks secret-bearing → never forward
  const { data: feed } = await service
    .from('feeds')
    .select('secret_url')
    .eq('id', feedId)
    .maybeSingle();
  if (!feed || feed.secret_url) return null; // private/tokenized feed → skip
  return fetchViaJina(url);
}

/** Fetch a page via Jina Reader (r.jina.ai) to bypass bot-blocking. The fetch
 * target is always the fixed host r.jina.ai (the article URL only appears in the
 * path), so there's no redirect-based SSRF here. Returns the raw HTML, or null
 * if Jina is unconfigured or the request fails / exceeds the size cap. The URL
 * has already been screened by maybeFetchViaJina. */
async function fetchViaJina(target: string): Promise<string | null> {
  const apiKey = Deno.env.get('JINA_API_KEY');
  if (!apiKey) return null;

  try {
    const res = await fetch(`https://r.jina.ai/${target}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Return-Format': 'html',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const reader = res.body?.getReader();
    if (!reader) return await res.text();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      total += value.byteLength;
      if (total > JINA_MAX_BYTES) {
        reader.cancel();
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
    return new TextDecoder().decode(out);
  } catch {
    return null;
  }
}

/** Persist the outcome of one full-text download attempt on the shared item, for
 * the /admin/feeds download-status console. Best-effort and service-role (client
 * writes are RLS-locked): a failure here must never change the caller's result,
 * so it's logged and swallowed. Upsert keyed on item_id so the row always holds
 * the LATEST attempt. */
async function recordAttempt(
  service: any,
  itemId: string,
  status: 'ok' | 'auth' | 'unreachable' | 'empty',
  opts: {
    httpStatus?: number | null;
    error?: string | null;
    robotsRule?: string | null;
  } = {},
): Promise<void> {
  try {
    const { error } = await service.from('item_fulltext_status').upsert(
      {
        item_id: itemId,
        status,
        http_status: opts.httpStatus ?? null,
        error: opts.error ?? null,
        robots_rule: opts.robotsRule ?? null,
        attempted_at: new Date().toISOString(),
      },
      { onConflict: 'item_id' },
    );
    if (error) {
      console.error(`fulltext: recording ${status} for item ${itemId} failed:`, error);
    }
  } catch (err) {
    console.error(`fulltext: recording ${status} for item ${itemId} threw:`, err);
  }
}

/** Human reason for a robots.txt disallow, naming the matched user-agent group
 * when known (the specific matching rule is recorded separately). */
function robotsReason(matchedUserAgent: string | null): string {
  return matchedUserAgent
    ? `disallowed by robots.txt (User-agent: ${matchedUserAgent})`
    : 'disallowed by robots.txt';
}
