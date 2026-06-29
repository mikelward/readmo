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
import { robotsAllows } from '../_shared/robots.ts';
import { looksTokenized, redactUrl } from '../_shared/urlSafety.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { loadAllowlistFromDb, parseAllowlist, isAllowed } from '../_shared/allowlist.ts';

const JINA_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
const FETCH_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB — article pages can be large

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
  try {
    ({ itemId } = await req.json());
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
  // Transitional cutover safety: union with the legacy READMO_ALLOWLIST env var,
  // so an install that armed the OLD secret stays gated until it seeds the DB
  // table and unsets the secret — deploying these functions before seeding can't
  // briefly fling the gate open. (No-op once the secret is unset / never set.)
  for (const e of parseAllowlist(Deno.env.get('READMO_ALLOWLIST'))) allowlist.add(e);
  if (allowlist.size > 0) {
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

  // RLS-scoped lookup: only resolves if the caller may see this item.
  const { data: item, error } = await userClient
    .from('items')
    .select('id, feed_id, url, title, full_content_html, full_content_via_fallback')
    .eq('id', itemId)
    .maybeSingle();
  if (error) {
    console.error(`fulltext: item lookup for ${itemId} failed:`, error);
    return json({ error: error.message }, 400);
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
  if (!item.url) return json({ status: 'empty', contentHtml: null });

  // Reading mode crawls the article's OWN page (beyond the syndicated feed), so
  // ask the publisher's robots.txt first. Fail OPEN: a missing/unreachable/
  // unparseable robots.txt allows the fetch (robotsAllows handles that). Only a
  // robots.txt that explicitly disallows our crawler blocks it — reported as the
  // silent `empty` outcome (reader keeps the feed body + Open original), the same
  // UX as a paywall/teaser, so no new wire status for older clients to choke on.
  if (!(await robotsAllows(item.url))) {
    console.log(`fulltext: item ${itemId} (${redactUrl(item.url)}) disallowed by robots.txt`);
    return json({ status: 'empty', contentHtml: null });
  }

  console.log(`fulltext: fetching item ${itemId} (${redactUrl(item.url)})`);
  let body: string;
  let finalUrl = item.url;
  // Whether this body came from the bot-block fallback fetch (r.jina.ai) rather
  // than a direct fetch — recorded on the cached row and surfaced to the reader
  // as a "via fallback" provenance label.
  let viaFallback = false;
  try {
    const res = await safeFetch(item.url, {
      timeoutMs: 12_000,
      maxBytes: FETCH_MAX_BYTES,
    });
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
    if (res.url !== item.url && !(await robotsAllows(res.url))) {
      console.log(`fulltext: item ${itemId} final URL (${redactUrl(res.url)}) disallowed by robots.txt`);
      return json({ status: 'empty', contentHtml: null });
    }
    if (res.status === 401 || res.status === 403) {
      // Login/bot wall. Retry via Jina ONLY for public feeds (no secret_url),
      // so we never forward a possibly-tokenized item URL to a third party.
      console.log(`fulltext: item ${itemId} HTTP ${res.status} — trying Jina fallback`);
      const jinaHtml = await maybeFetchViaJina(service, item.feed_id, item.url);
      if (jinaHtml === null) {
        console.log(`fulltext: item ${itemId} — Jina unavailable or URL tokenized`);
        return json({ status: 'auth', contentHtml: null });
      }
      console.log(`fulltext: item ${itemId} — Jina returned HTML`);
      body = jinaHtml;
      viaFallback = true;
    } else if (res.status >= 400) {
      return json({ status: 'unreachable', contentHtml: null });
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
    return json({ status: 'unreachable', contentHtml: null });
  }

  // Pass the item's title so a body heading that just repeats the headline the
  // reader already renders above the body is dropped (no duplicated title).
  const extracted = extractArticle(body, finalUrl, item.title ?? undefined);
  if (!extracted) {
    console.log(`fulltext: item ${itemId} — no article body extracted (paywall/teaser?)`);
    return json({ status: 'empty', contentHtml: null });
  }

  // Sanitize the extracted body before it is stored OR returned (guardrail #6).
  const clean = sanitizeContent(extracted.contentHtml, finalUrl);
  if (!clean) {
    console.log(`fulltext: item ${itemId} — sanitized body empty`);
    return json({ status: 'empty', contentHtml: null });
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
  const okBody = {
    status: 'ok',
    contentHtml: clean,
    ...(viaFallback ? { viaFallback: true } : {}),
  };
  if (writeError) {
    // The extraction still succeeded for this caller; surface it even if the
    // cache write failed (next caller just re-extracts). Log so a persistently
    // failing cache write doesn't stay invisible.
    console.error(`fulltext: cache write for item ${itemId} failed:`, writeError);
    return json(okBody);
  }

  return json(okBody);
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}
