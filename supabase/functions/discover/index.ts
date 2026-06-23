// Readmo feed discovery — Edge Function.
//
// POST /functions/v1/discover { url }
// Accepts a site or feed URL. For an HTML page it extracts candidate feeds
// (<link rel="alternate"> + path fallbacks, plus derived Reddit .rss); each
// candidate is fetched + parsed through the SSRF-hardened path before being
// offered. Discovery is the highest-risk fetch (brand-new user-supplied URL),
// so EVERY outbound request goes through safeFetch. SPEC.md "Feed discovery".
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

  try {
    // The settings form accepts bare site names (e.g. "example.com"), so
    // normalize a missing scheme to https:// before anything touches the URL —
    // otherwise assertSafeUrl/safeFetch reject it as "Invalid URL".
    const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;

    // Reddit short-circuit: derive the .rss form directly (its pages don't
    // reliably advertise the feed).
    const reddit = redditFeedFor(target);
    if (reddit) {
      const feed = await tryParse(reddit);
      if (feed) return json({ candidates: [feed] });
    }

    // Fetch the target. It may itself be a feed or an HTML page.
    const res = await safeFetch(target, { timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024 });
    const body = new TextDecoder().decode(res.body);

    // If the target parses as a feed, offer it directly.
    const asFeed = await tryParse(res.url, body);
    if (asFeed) return json({ candidates: [asFeed] });

    // Not a feed itself. If the fetch didn't actually succeed, report WHY
    // rather than falling through to a misleading "no feed found": a
    // login-gated feed (401/403), a dead URL (404/410), or any other non-2xx.
    // The `code` lets the client pick the right message (see classifyFunctionError).
    if (res.status === 401 || res.status === 403) {
      return json(
        { error: "That feed requires a login, so it can't be added.", code: 'auth' },
        422,
      );
    }
    if (res.status === 404 || res.status === 410) {
      return json({ error: 'That URL could not be found.', code: 'not-found' }, 422);
    }
    if (res.status >= 400) {
      return json(
        { error: `That URL returned HTTP ${res.status}.`, code: 'unreachable' },
        502,
      );
    }

    // Otherwise treat it as HTML and probe each candidate.
    const candidates = discoverFromHtml(body, res.url);
    const validated = [];
    for (const c of candidates as FeedCandidate[]) {
      const feed = await tryParse(c.url);
      if (feed) validated.push(feed);
    }
    return json({ candidates: validated });
  } catch (err) {
    // SSRF-blocked (private/loopback address) or any fetch/parse failure: the
    // URL couldn't be reached. Tag it so the client says so.
    if (err instanceof SsrfError) return json({ error: err.message, code: 'unreachable' }, 400);
    return json(
      { error: err instanceof Error ? err.message : String(err), code: 'unreachable' },
      502,
    );
  }
});

/** Fetch (if needed) + parse a candidate; return a summary or null on failure. */
async function tryParse(candidateUrl: string, prefetchedBody?: string) {
  try {
    let body = prefetchedBody;
    let finalUrl = candidateUrl;
    if (body == null) {
      const res = await safeFetch(candidateUrl, { timeoutMs: 10_000 });
      if (res.status >= 400) return null;
      body = new TextDecoder().decode(res.body);
      finalUrl = res.url;
    }
    const parsed = parseFeed(body, finalUrl);
    return {
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
    };
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
