// Readmo feed discovery — Edge Function.
//
// POST /functions/v1/discover { url }
// Accepts a site or feed URL. For an HTML page it extracts candidate feeds
// (<link rel="alternate"> + path fallbacks, plus derived Reddit .rss); each
// candidate is fetched + parsed through the SSRF-hardened path before being
// offered. Discovery is the highest-risk fetch (brand-new user-supplied URL),
// so EVERY outbound request goes through safeFetch. SPEC.md "Feed discovery".
//
// Bot-blocking fallback: if the direct fetch returns 403 (Cloudflare etc.),
// we retry via Jina Reader (r.jina.ai) which uses a headless browser. Jina
// is a fixed trusted host — the user-supplied URL only appears in the path,
// never as the fetch target itself, so the SSRF surface is unchanged. The
// target URL is already validated by the preceding safeFetch call.
// Requires JINA_API_KEY env secret; skipped silently if absent.
//
// Thin entrypoint — discovery/parse/sanitize logic is tested in _shared.
// Deno resolves bare specifiers via ../import_map.json.

// @ts-nocheck — runs under Deno, not node/tsc.
import { discoverFromHtml, redditFeedFor, type FeedCandidate } from '../_shared/discover.ts';
import { parseFeed } from '../_shared/parser.ts';
import { safeFetch, SsrfError } from '../_shared/ssrf.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let url: string;
  try {
    ({ url } = await req.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof url !== 'string' || !url) return json({ error: 'Missing url' }, 400);

  try { console.log(`[discover] host=${new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).host}`); } catch { console.log('[discover] invalid url'); }
  try {
    // The settings form accepts bare site names (e.g. "example.com"), so
    // normalize a missing scheme to https:// before anything touches the URL —
    // otherwise assertSafeUrl/safeFetch reject it as "Invalid URL".
    const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;

    // Reddit short-circuit: derive the .rss form directly (its pages don't
    // reliably advertise the feed).
    const reddit = redditFeedFor(target);
    if (reddit) {
      const { feed } = await tryParse(reddit);
      if (feed) { console.log(`[discover] ok path=reddit`); return json({ candidates: [feed] }); }
    }

    // Fetch the target. It may itself be a feed or an HTML page.
    const res = await safeFetch(target, { timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024 });
    const body = new TextDecoder().decode(res.body);

    // If the target parses as a feed, offer it directly.
    const { feed: asFeed } = await tryParse(res.url, body);
    if (asFeed) { console.log(`[discover] ok path=direct`); return json({ candidates: [asFeed] }); }

    // Not a feed itself. If the fetch didn't actually succeed, report WHY
    // rather than falling through to a misleading "no feed found": a
    // login-gated feed (401/403), a dead URL (404/410), or any other non-2xx.
    // The `code` lets the client pick the right message (see classifyFunctionError).
    const targetCode = codeForStatus(res.status);
    if (targetCode === 'auth') {
      // 403 often means bot-blocking (Cloudflare etc.) rather than a real auth
      // wall. Try via Jina Reader — a headless-browser proxy that bypasses
      // bot protection — before giving up.
      const jinaHtml = await fetchViaJina(target);
      if (jinaHtml !== null) {
        const result = await probeHtml(jinaHtml, target);
        if (result.validated.length > 0) { console.log(`[discover] ok path=jina candidates=${result.validated.length}`); return json({ candidates: result.validated }); }
        if (result.candidateFail) { console.error(`[discover] error path=jina candidateFail=${result.candidateFail}`); return feedErrorResponse(result.candidateFail); }
        console.error(`[discover] error path=jina code=${targetCode}`);
        return feedErrorResponse(targetCode);
      }
      console.error(`[discover] error code=${targetCode} (no jina)`);
      return feedErrorResponse(targetCode);
    }
    if (targetCode) { console.error(`[discover] error code=${targetCode} status=${res.status}`); return feedErrorResponse(targetCode); }

    // Otherwise treat it as HTML and probe each candidate.
    const result = await probeHtml(body, res.url);
    if (result.validated.length === 0 && result.candidateFail) {
      console.error(`[discover] no feeds candidateFail=${result.candidateFail}`);
      return feedErrorResponse(result.candidateFail);
    }
    console.log(`[discover] ok path=html candidates=${result.validated.length}`);
    return json({ candidates: result.validated });
  } catch (err) {
    // SSRF-blocked (private/loopback address) or any fetch/parse failure: the
    // URL couldn't be reached. Tag it so the client says so.
    const msg = err instanceof Error ? err.message : String(err);
    // Redact URLs from error messages before logging — assertSafeUrl formats
    // errors as "Invalid URL: <url>" and the URL may carry auth tokens.
    const redacted = msg.replace(/https?:\/\/\S+/g, '<url>');
    console.error(`[discover] error:`, redacted);
    if (err instanceof SsrfError) return json({ error: err.message, code: 'unreachable' }, 400);
    return json({ error: msg, code: 'unreachable' }, 502);
  }
});

/** Discover + validate feed candidates from an HTML string.
 * Shared between the direct path and the Jina fallback. */
async function probeHtml(html: string, baseUrl: string) {
  const candidates = discoverFromHtml(html, baseUrl);
  const validated = [];
  let candidateFail: 'auth' | 'not-found' | 'unreachable' | null = null;
  for (const c of candidates as FeedCandidate[]) {
    const { feed, status } = await tryParse(c.url);
    if (feed) {
      validated.push(feed);
      continue;
    }
    if (c.type != null) {
      candidateFail = mergeFail(candidateFail, candidateFailCode(status));
    }
  }
  return { validated, candidateFail };
}

const JINA_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB — enough for any HTML head

/** Fetch a page via Jina Reader (r.jina.ai) to bypass bot-blocking.
 * Returns the raw HTML string on success, null if Jina is not configured,
 * the request fails, or the URL looks like it could carry auth secrets.
 *
 * Security notes:
 * - URLs with a query string are skipped: query params often carry auth
 *   tokens (e.g. ?token=…) and must not be forwarded to a third party.
 * - The response body is capped at JINA_MAX_BYTES to prevent memory
 *   exhaustion from a large or slow Jina response.
 * - The fetch target is always the fixed host r.jina.ai (not user-
 *   controlled), so redirect-based SSRF is not a concern here. */
async function fetchViaJina(target: string): Promise<string | null> {
  const apiKey = Deno.env.get('JINA_API_KEY');
  if (!apiKey) return null;

  // Don't send URLs that could carry auth secrets to a third party:
  // - Query string: ?token=… style secrets.
  // - Path extension: /feeds/<secret>.xml or similar tokenized resource URLs.
  //   Website pages that need Jina (apnews.com, theguardian.com/tech) never
  //   have a file extension; feed/resource URLs always do.
  try {
    const parsed = new URL(target);
    if (parsed.search !== '') return null;
    const lastSegment = parsed.pathname.split('/').pop() ?? '';
    if (lastSegment.includes('.')) return null;
  } catch {
    return null;
  }

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

    // Read body with a size cap to prevent memory exhaustion.
    const reader = res.body?.getReader();
    if (!reader) return await res.text();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      total += value.byteLength;
      if (total > JINA_MAX_BYTES) { reader.cancel(); return null; }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return new TextDecoder().decode(out);
  } catch {
    return null;
  }
}


/** Fetch (if needed) + parse a candidate. Returns `{ feed }` on success, else
 * `{ feed: null, status }` carrying the upstream HTTP status (when we got one)
 * so the caller can tell a login-gated/dead candidate apart from a reachable
 * page that simply isn't a feed. `status` is null when we never reached a
 * response (network error / SSRF block) or when the body was prefetched. */
async function tryParse(candidateUrl: string, prefetchedBody?: string) {
  let status: number | null = null;
  try {
    let body = prefetchedBody;
    let finalUrl = candidateUrl;
    if (body == null) {
      const res = await safeFetch(candidateUrl, { timeoutMs: 10_000 });
      status = res.status;
      if (res.status >= 400) return { feed: null, status };
      body = new TextDecoder().decode(res.body);
      finalUrl = res.url;
    }
    const parsed = parseFeed(body, finalUrl);
    return {
      feed: {
        feedUrl: finalUrl,
        title: parsed.feedTitle,
        siteUrl: parsed.siteUrl,
        // A small sample so the UI can preview before subscribing (SPEC.md
        // "Add feed … shows title + a sample of recent items").
        sample: parsed.items.slice(0, 5).map((i) => ({
          title: i.title,
          url: i.url,
          publishedAt: i.publishedAt,
        })),
      },
      status,
    };
  } catch {
    return { feed: null, status };
  }
}

/** Map an upstream HTTP status to the client error `code`, or null when the
 * status isn't itself a failure (e.g. 200 that just didn't parse as a feed). */
function codeForStatus(status: number | null): 'auth' | 'not-found' | 'unreachable' | null {
  if (status == null) return null;
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || status === 410) return 'not-found';
  if (status >= 400) return 'unreachable';
  return null;
}

/** Failure code for an *advertised* candidate we couldn't turn into a feed.
 * A null status means the fetch threw before any response existed (DNS failure,
 * timeout, SSRF block, oversized body) → `unreachable`. A reachable 2xx that
 * simply didn't parse is NOT a failure (null) — the page just has no feed
 * there. 4xx/5xx map via codeForStatus. */
function candidateFailCode(status: number | null): 'auth' | 'not-found' | 'unreachable' | null {
  if (status === null) return 'unreachable';
  if (status >= 200 && status < 300) return null;
  return codeForStatus(status);
}

/** Keep the most actionable failure reason across candidates: a login wall is
 * more useful to surface than a dead URL, which beats a generic 5xx. */
function mergeFail(
  a: 'auth' | 'not-found' | 'unreachable' | null,
  b: 'auth' | 'not-found' | 'unreachable' | null,
): 'auth' | 'not-found' | 'unreachable' | null {
  const rank = { auth: 3, 'not-found': 2, unreachable: 1 } as const;
  if (!b) return a;
  if (!a) return b;
  return rank[b] > rank[a] ? b : a;
}

/** The error response for a classified discovery failure (matches the client's
 * classifyFunctionError mapping). */
function feedErrorResponse(code: 'auth' | 'not-found' | 'unreachable'): Response {
  if (code === 'auth') {
    return json({ error: "That feed requires a login, so it can't be added.", code }, 422);
  }
  if (code === 'not-found') {
    return json({ error: 'That URL could not be found.', code }, 422);
  }
  return json({ error: "That URL couldn't be reached.", code }, 502);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}
