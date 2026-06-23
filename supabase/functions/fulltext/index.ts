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
//   ok          — extracted (or cache hit); contentHtml is sanitized HTML
//   empty       — page fetched but no article-like body found (paywall/teaser)
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
import { looksTokenized } from '../_shared/urlSafety.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';

const JINA_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB
const FETCH_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB — article pages can be large

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let itemId: string | undefined;
  try {
    ({ itemId } = await req.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof itemId !== 'string' || !itemId) {
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

  // RLS-scoped lookup: only resolves if the caller may see this item.
  const { data: item, error } = await userClient
    .from('items')
    .select('id, feed_id, url, title, full_content_html')
    .eq('id', itemId)
    .maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!item) return json({ error: 'Item not found' }, 404);

  // Cache hit — serve the previously extracted body without re-fetching.
  if (item.full_content_html) {
    return json({ status: 'ok', contentHtml: item.full_content_html });
  }
  if (!item.url) return json({ status: 'empty', contentHtml: null });

  let body: string;
  let finalUrl = item.url;
  try {
    const res = await safeFetch(item.url, {
      timeoutMs: 12_000,
      maxBytes: FETCH_MAX_BYTES,
    });
    if (res.status === 401 || res.status === 403) {
      // Login/bot wall. Retry via Jina ONLY for public feeds (no secret_url),
      // so we never forward a possibly-tokenized item URL to a third party.
      const jinaHtml = await maybeFetchViaJina(service, item.feed_id, item.url);
      if (jinaHtml === null) return json({ status: 'auth', contentHtml: null });
      body = jinaHtml;
    } else if (res.status >= 400) {
      return json({ status: 'unreachable', contentHtml: null });
    } else {
      body = new TextDecoder().decode(res.body);
      finalUrl = res.url;
    }
  } catch {
    // SSRF-blocked, DNS failure, timeout, oversized body — all "unreachable".
    return json({ status: 'unreachable', contentHtml: null });
  }

  // Pass the item's title so a body heading that just repeats the headline the
  // reader already renders above the body is dropped (no duplicated title).
  const extracted = extractArticle(body, finalUrl, item.title ?? undefined);
  if (!extracted) return json({ status: 'empty', contentHtml: null });

  // Sanitize the extracted body before it is stored OR returned (guardrail #6).
  const clean = sanitizeContent(extracted.contentHtml, finalUrl);
  if (!clean) return json({ status: 'empty', contentHtml: null });

  // Cache on the shared item (service role; client item writes are revoked).
  const { error: writeError } = await service
    .from('items')
    .update({
      full_content_html: clean,
      full_content_fetched_at: new Date().toISOString(),
    })
    .eq('id', itemId);
  if (writeError) {
    // The extraction still succeeded for this caller; surface it even if the
    // cache write failed (next caller just re-extracts).
    return json({ status: 'ok', contentHtml: clean });
  }

  return json({ status: 'ok', contentHtml: clean });
});

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
