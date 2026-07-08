// Readmo feed discovery — Edge Function.
//
// POST /functions/v1/discover { url }
// Accepts a site or feed URL. For an HTML page it extracts candidate feeds
// (<link rel="alternate"> + path fallbacks, plus derived Reddit .rss); each
// candidate is fetched + parsed through the SSRF-hardened path before being
// offered. Discovery is the highest-risk fetch (brand-new user-supplied URL),
// so EVERY outbound request goes through safeFetch. SPEC.md "Feed discovery".
//
// Deep-link fallback: a pasted article rarely advertises the site's feed in its
// own <head>, so when the page yields nothing we re-probe the site home page.
// Last-resort fallback: if neither advertises a feed, we offer a Google News
// `site:<domain>` RSS search so the reader still gets *something*. The
// publisher's own feed always wins when one exists.
//
// Google News RSS feeds (news.google.com/rss/…) are gated on the shared
// trusted-user allowlist (the DB `allowlist` table; see _shared/allowlist.ts)
// because they are a Google-ToS gray area. Empty → open to all. Once armed: an explicit
// paste of a Google News feed by a non-listed caller is `blocked`, while
// discovered or synthesized Google News candidates (an advertised alternate or
// the last-resort search above) are silently dropped for non-listed callers so
// a normal add just falls back to "no feed found". Plain feeds are unaffected.
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
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  discoverFromHtml,
  googleNewsFeedFor,
  homePageUrl,
  redditFeedFor,
  type FeedCandidate,
} from '../_shared/discover.ts';
import { parseFeed } from '../_shared/parser.ts';
import { fetchViaJinaHtml } from '../_shared/jina.ts';
import { safeFetch, SsrfError } from '../_shared/ssrf.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { redactUrl } from '../_shared/urlSafety.ts';
import { loadAllowlistFromDb, isAllowed } from '../_shared/allowlist.ts';
import { isGoogleNewsFeedUrl } from '../_shared/googleNews.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') {
    console.warn(`discover: rejected ${req.method} (POST only)`);
    return json({ error: 'POST only' }, 405);
  }

  let url: string;
  try {
    ({ url } = await req.json());
  } catch {
    console.warn('discover: rejected request with invalid JSON body');
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof url !== 'string' || !url) {
    console.warn('discover: rejected request with missing url');
    return json({ error: 'Missing url' }, 400);
  }

  try {
    // The settings form accepts bare site names (e.g. "example.com"), so
    // normalize a missing scheme to https:// before anything touches the URL —
    // otherwise assertSafeUrl/safeFetch reject it as "Invalid URL".
    const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;

    console.log(`discover: probing ${redactUrl(target)}`);

    // Explicit Google News paste: block a non-listed caller up front (before any
    // fetch) with a clear message. Discovered/synthesized Google News candidates
    // are handled differently — dropped silently — in respondWithCandidates and
    // the last-resort fallback below. Unset allowlist → open to all.
    if (isGoogleNewsFeedUrl(target) && !(await callerAllowsGoogleNews(req))) {
      return googleNewsBlockedResponse();
    }

    // Reddit short-circuit: derive the .rss form directly (its pages don't
    // reliably advertise the feed).
    const reddit = redditFeedFor(target);
    if (reddit) {
      console.log(`discover: Reddit short-circuit → ${redactUrl(reddit)}`);
      const { feed } = await tryParse(reddit);
      if (feed) {
        console.log(`discover: Reddit feed validated`);
        return await respondWithCandidates(req, [feed]);
      }
    }

    // Fetch the target. It may itself be a feed or an HTML page.
    const res = await safeFetch(target, { timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024 });
    console.log(`discover: target responded HTTP ${res.status}`);
    const body = new TextDecoder().decode(res.body);

    // If the target parses as a feed, offer it directly.
    const { feed: asFeed } = await tryParse(res.url, body);
    if (asFeed) {
      console.log(`discover: URL is a feed`);
      return await respondWithCandidates(req, [asFeed]);
    }

    // Not a feed itself. If the fetch didn't actually succeed, report WHY
    // rather than falling through to a misleading "no feed found": a
    // login-gated feed (401/403), a dead URL (404/410), or any other non-2xx.
    // The `code` lets the client pick the right message (see classifyFunctionError).
    const targetCode = codeForStatus(res.status);
    if (targetCode === 'auth') {
      // 403 often means bot-blocking (Cloudflare etc.) rather than a real auth
      // wall. Try via Jina Reader — a headless-browser proxy that bypasses
      // bot protection — before giving up.
      console.log(`discover: HTTP ${res.status} — trying Jina fallback`);
      const jinaHtml = await fetchViaJinaHtml(target);
      if (jinaHtml !== null) {
        console.log('discover: Jina returned HTML, probing for feed candidates');
        const result = await probeHtml(jinaHtml, target);
        console.log(`discover: Jina path — ${result.validated.length} candidate(s) validated`);
        if (result.validated.length > 0) return await respondWithCandidates(req, result.validated);
        if (result.candidateFail) return feedErrorResponse(result.candidateFail);
        return feedErrorResponse(targetCode);
      }
      console.log('discover: Jina unavailable or skipped, returning auth error');
      return feedErrorResponse(targetCode);
    }
    if (targetCode) return feedErrorResponse(targetCode);

    // Otherwise treat it as HTML and probe each candidate.
    let result = await probeHtml(body, res.url);
    console.log(`discover: HTML path — ${result.validated.length} candidate(s) validated`);

    // Deep-link fallback: a pasted article (e.g. .../news/123/story-slug)
    // usually doesn't advertise the site's feed in its own <head>, but the home
    // page almost always does. Re-probe the origin root before giving up. Gated
    // on `!candidateFail` for the same reason as the Google News block below:
    // when the page *advertises* a feed that's gated/dead/5xx, surface that
    // specific reason rather than masking it with the site's generic home feed
    // (SPEC.md "discovery reports *why* a URL yields no feed").
    if (result.validated.length === 0 && !result.candidateFail) {
      const home = homePageUrl(res.url);
      if (home) {
        console.log(`discover: no feed on page — probing home page ${redactUrl(home)}`);
        const homeResult = await fetchAndProbe(home);
        if (homeResult) {
          result = {
            validated: homeResult.validated,
            candidateFail: mergeFail(result.candidateFail, homeResult.candidateFail),
          };
          console.log(`discover: home page — ${result.validated.length} candidate(s) validated`);
        }
      }
    }

    // Last-resort fallback: the page advertises NO feed at all (none on the
    // page, none on its home page), so offer a Google News `site:` search feed
    // of the publisher's recent articles — better than "no feed found". Gated on
    // `!candidateFail`: when an *advertised* feed exists but is gated/dead/5xx we
    // surface that specific reason below instead of silently diverting the reader
    // to a Google News search (SPEC.md "discovery reports *why* a URL yields no
    // feed"). The publisher's own feed always wins.
    // Skip this Google News fallback entirely for non-allowlisted callers (the
    // feature is gated) — they fall through to the "no feed found" path rather
    // than a confusing block, since they never asked for Google News.
    if (
      result.validated.length === 0 &&
      !result.candidateFail &&
      (await callerAllowsGoogleNews(req))
    ) {
      const gnews = googleNewsFeedFor(res.url);
      if (gnews) {
        console.log(`discover: falling back to Google News for ${redactUrl(res.url)}`);
        const { feed } = await tryParse(gnews);
        // Require a non-empty sample so we don't subscribe the reader to a feed
        // that's empty for this domain (Google indexes nothing for it).
        if (feed && feed.sample.length > 0) {
          console.log('discover: Google News feed validated');
          return json({ candidates: [feed] });
        }
      }
    }

    if (result.validated.length === 0 && result.candidateFail) {
      return feedErrorResponse(result.candidateFail);
    }
    return await respondWithCandidates(req, result.validated);
  } catch (err) {
    // SSRF-blocked (private/loopback address) or any fetch/parse failure: the
    // URL couldn't be reached. Tag it so the client says so. SsrfError is an
    // expected outcome (sketchy URL) so it logs at debug-ish detail; anything
    // else is unexpected and gets a louder line so it surfaces in the Edge
    // Function log when a user reports "discover never worked".
    if (err instanceof SsrfError) {
      console.warn('discover: blocked by SSRF guard:', err.message);
      return json({ error: err.message, code: 'unreachable' }, 400);
    }
    console.error('discover: unhandled error:', err);
    return json(
      { error: err instanceof Error ? err.message : String(err), code: 'unreachable' },
      502,
    );
  }
});

/** Whether the caller may receive Google News feeds. True when the allowlist
 * table is empty (disarmed) or the caller's email is on it. The reads only
 * happen when a Google News URL is actually in play, so a normal add never pays
 * for them. Fail-closed: if the allowlist read throws, or auth resolves no user,
 * the caller is treated as NOT allowed, which here just drops/blocks the Google
 * News candidate (retryable by the user, nothing cached). */
async function callerAllowsGoogleNews(req: Request): Promise<boolean> {
  const service = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  let allowlist: Set<string>;
  try {
    allowlist = await loadAllowlistFromDb(service);
  } catch (err) {
    console.error('discover: allowlist read failed — treating as not allowed:', err);
    return false; // fail closed → drop/block the Google News candidate
  }
  if (allowlist.size === 0) return true; // disarmed → open to all
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
  );
  const { data: auth } = await userClient.auth.getUser();
  return isAllowed({ id: auth?.user?.id, email: auth?.user?.email }, allowlist);
}

/** The `blocked` add-feed response for a Google News feed the caller may not add
 * (an explicit paste of a gated Google News URL). */
function googleNewsBlockedResponse(): Response {
  console.log('discover: Google News feed blocked for non-allowlisted caller');
  return json(
    { error: "Google News feeds aren't available on this account.", code: 'blocked' },
    422,
  );
}

/** Return the discovered candidates. A non-Google page can advertise (or
 * redirect to) a news.google.com feed, so re-check candidate feed URLs: when the
 * caller isn't allowed Google News, DROP those candidates (offer the rest, or
 * fall through to "no feed found") rather than erroring — the user didn't paste
 * Google News, so a block here would be confusing. */
async function respondWithCandidates(
  req: Request,
  candidates: Array<{ feedUrl: string }>,
): Promise<Response> {
  if (
    candidates.some((c) => isGoogleNewsFeedUrl(c.feedUrl)) &&
    !(await callerAllowsGoogleNews(req))
  ) {
    return json({ candidates: candidates.filter((c) => !isGoogleNewsFeedUrl(c.feedUrl)) });
  }
  return json({ candidates });
}

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

/** Fetch a URL through the SSRF-hardened path and probe its HTML for feed
 * candidates. Returns null on a non-2xx response or any fetch failure — the
 * caller treats that as "no extra candidates" and falls through. Used by the
 * deep-link home-page fallback. */
async function fetchAndProbe(url: string) {
  try {
    const res = await safeFetch(url, { timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024 });
    if (res.status >= 400) return null;
    const body = new TextDecoder().decode(res.body);
    return await probeHtml(body, res.url);
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
