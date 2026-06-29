// Site-HTML favicon discovery.
//
// Many sites no longer keep a root `/favicon.ico`; they declare their icon
// only in the page <head> via `<link rel="icon" href="…">` (often a CDN SVG or
// PNG). The feed parser can't see that — it only knows the feed body and the
// `/favicon.ico` guess — so for feeds that advertise no icon the poller fetches
// the site's HTML and calls pickIconFromHtml() to recover a real icon before
// settling for the guess.
//
// PURE (string in, string out) so it unit-tests without network. The caller
// fetches the HTML through the SSRF-hardened safeFetch and passes it here. The
// result is screened by the parser's sanitizeFaviconUrl, so a tokenized or
// non-http(s) icon href is rejected exactly like a feed-advertised one.

import { sanitizeFaviconUrl } from './parser.ts';
import { safeFetch } from './ssrf.ts';

/**
 * The best `<link rel="…icon…">` href from an HTML page, absolutized against
 * `baseUrl` and screened, or null when none is usable.
 *
 * Preference order: a standard favicon (`rel="icon"` / `rel="shortcut icon"`)
 * first, then `apple-touch-icon`, then `mask-icon` — first match in document
 * order within each tier. Sizes are ignored; any declared icon beats the
 * `/favicon.ico` guess the caller falls back to.
 */
export function pickIconFromHtml(html: string, baseUrl: string): string | null {
  let standard: string | null = null;
  let appleTouch: string | null = null;
  let mask: string | null = null;

  for (const tag of iterateLinkTags(html)) {
    const relTokens = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
    // A standard favicon: rel includes the bare token "icon" (covers "icon"
    // and "shortcut icon"); apple-touch-icon / mask-icon are single tokens, so
    // these tiers are mutually exclusive.
    const isStandard = relTokens.includes('icon');
    const isApple =
      relTokens.includes('apple-touch-icon') ||
      relTokens.includes('apple-touch-icon-precomposed');
    const isMask = relTokens.includes('mask-icon');
    if (!isStandard && !isApple && !isMask) continue;
    // Screen each candidate AS WE SCAN and keep the first that survives per
    // tier — so a rejected href (data:/tokenized/non-http(s)) doesn't shadow a
    // valid icon declared later in the <head>.
    const clean = sanitizeFaviconUrl(attr(tag, 'href'), baseUrl);
    if (!clean) continue;
    if (isStandard) standard ??= clean;
    else if (isApple) appleTouch ??= clean;
    else mask ??= clean;
  }

  // Tier priority beats document order: a standard icon wins even if an
  // apple-touch/mask icon appeared earlier.
  return standard ?? appleTouch ?? mask;
}

/**
 * Fetch a site's HTML once (through the SSRF-hardened safeFetch) and return its
 * declared icon, or null. Best-effort: any failure — network, non-2xx, body cap,
 * or no `<link rel="icon">` — yields null so favicon discovery never breaks a
 * poll. Absolutizes against the FINAL URL after redirects.
 */
export async function fetchSiteIcon(siteUrl: string): Promise<string | null> {
  try {
    const res = await safeFetch(siteUrl, {
      headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      timeoutMs: 8000,
    });
    if (res.status < 200 || res.status >= 300) return null;
    return pickIconFromHtml(new TextDecoder().decode(res.body), res.url);
  } catch {
    return null;
  }
}

/** What {@link resolveFeedFavicon} needs from a ParsedFeed. */
interface FaviconInputs {
  faviconUrl: string | null;
  faviconFromFeed: boolean;
  siteUrl: string | null;
}

/** Outcome of {@link resolveFeedFavicon}. */
interface FaviconDecision {
  /** The favicon URL to store in `feeds.favicon_url`. */
  url: string | null;
  /** True when an HTML lookup was attempted this run — the caller MUST then set
   * `feeds.favicon_checked_at = now` so the result (even a negative one) is
   * cached and the homepage isn't re-fetched until the recheck window lapses. */
  stampCheckedAt: boolean;
}

/** How long a feed's HTML icon lookup is cached before the poller re-checks —
 * long, because a site's declared icon rarely changes and the negative case
 * (no usable icon) almost never does. A stale stamp lets a site that later adds
 * an icon get picked up. */
export const FAVICON_RECHECK_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Whether the site-HTML icon lookup is due: never run, an unparseable stamp,
 * or older than the recheck window. */
function htmlCheckDue(
  checkedAt: string | null | undefined,
  nowMs: number,
  recheckMs: number,
): boolean {
  if (!checkedAt) return true;
  const ms = Date.parse(checkedAt);
  if (Number.isNaN(ms)) return true;
  return nowMs - ms >= recheckMs;
}

/**
 * Decide the favicon to store for a feed after parsing, upgrading the
 * `/favicon.ico` guess with the site's HTML-declared icon when needed:
 *
 *   1. The feed advertised an icon → use it (no HTML fetch).
 *   2. Else, a real icon is already stored → keep it (no fetch); the
 *      steady-state cache once one is found. "Real" = stored differs from the
 *      derived `/favicon.ico` guess (`parsed.faviconUrl`); compared by value,
 *      NOT a `/favicon.ico` suffix, so a discovered icon that happens to be
 *      named `…/assets/favicon.ico` is preserved, not mistaken for the guess.
 *   3. Else, if `allowHtmlLookup` AND the lookup is DUE (never run / older than
 *      the recheck window) → fetch the site's HTML `<link rel="icon">` via
 *      `fetchIcon`; use that when found, else the `/favicon.ico` guess. Either
 *      way the caller stamps `favicon_checked_at`, so a negative result is
 *      cached and the homepage isn't re-fetched until the window lapses.
 *   4. Else (lookup disallowed, checked recently, nothing found, or no site
 *      URL) → keep the guess, don't stamp.
 *
 * `allowHtmlLookup` lets the cron poller cap homepage fetches per run (a
 * per-run budget) without stamping the feeds it defers — they stay due and get
 * picked up on a later run. `nowMs` and the recheck window are injected (not
 * read from the clock here) so the decision unit-tests deterministically;
 * `fetchIcon` defaults to the real {@link fetchSiteIcon} and tests pass a stub.
 */
export async function resolveFeedFavicon(
  parsed: FaviconInputs,
  storedFaviconUrl: string | null | undefined,
  storedCheckedAt: string | null | undefined,
  nowMs: number,
  allowHtmlLookup: boolean,
  fetchIcon: (siteUrl: string) => Promise<string | null> = fetchSiteIcon,
  recheckMs: number = FAVICON_RECHECK_MS,
): Promise<FaviconDecision> {
  if (parsed.faviconFromFeed) return { url: parsed.faviconUrl, stampCheckedAt: false };
  // Past step 1, parsed.faviconUrl is the derived /favicon.ico guess (or null),
  // so "stored differs from it" means a real advertised/HTML-discovered icon —
  // keep it. Value comparison, not a suffix, so /assets/favicon.ico is kept.
  if (storedFaviconUrl && storedFaviconUrl !== parsed.faviconUrl) {
    return { url: storedFaviconUrl, stampCheckedAt: false };
  }
  if (allowHtmlLookup && parsed.siteUrl && htmlCheckDue(storedCheckedAt, nowMs, recheckMs)) {
    const fromHtml = await fetchIcon(parsed.siteUrl);
    return { url: fromHtml ?? parsed.faviconUrl, stampCheckedAt: true };
  }
  return { url: parsed.faviconUrl, stampCheckedAt: false };
}

/**
 * Whether a feed still needs the site-HTML favicon lookup — i.e. it has no real
 * (non-derived) icon yet AND the recheck window has lapsed. The cron poller
 * uses this to decide whether to SKIP its conditional-GET validators: a feed
 * that always replies `304 Not Modified` would otherwise return before the
 * favicon step and never get backfilled. Forcing a `200` (a one-time full feed
 * download per feed) lets the normal parse → resolveFeedFavicon path run and
 * stamp `favicon_checked_at`, after which this goes false and conditional GETs
 * resume. Returns false when there's no `siteUrl` (nothing to look up) so such
 * feeds keep their conditional requests.
 */
/** Whether a feed's site origin changed between the stored `site_url` and the
 * freshly-parsed one — the signal to DROP a cached favicon, which may belong to
 * the old publisher (a migrated feed must not keep showing the old site's
 * icon). Returns false when either side is missing or unparseable (e.g. a feed's
 * first successful parse) so we don't needlessly invalidate. */
export function siteOriginChanged(
  storedSiteUrl: string | null | undefined,
  parsedSiteUrl: string | null | undefined,
): boolean {
  if (!storedSiteUrl || !parsedSiteUrl) return false;
  try {
    return new URL(storedSiteUrl).origin !== new URL(parsedSiteUrl).origin;
  } catch {
    return false;
  }
}

export function faviconLookupDue(
  storedFaviconUrl: string | null | undefined,
  storedCheckedAt: string | null | undefined,
  siteUrl: string | null | undefined,
  nowMs: number,
  recheckMs: number = FAVICON_RECHECK_MS,
): boolean {
  if (!siteUrl) return false;
  // A real icon (advertised or HTML-discovered) is already stored → not due.
  const derived = sanitizeFaviconUrl('/favicon.ico', siteUrl);
  if (storedFaviconUrl && storedFaviconUrl !== derived) return false;
  return htmlCheckDue(storedCheckedAt, nowMs, recheckMs);
}

// ---------------------------------------------------------------------------
// Tiny HTML scanner (no DOM dependency) — mirrors discover.ts so this module
// stays self-contained and node/Deno-portable.
// ---------------------------------------------------------------------------

/** Yield the raw text of each <link …> tag in the document. */
function* iterateLinkTags(html: string): Generator<string> {
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    yield m[0];
  }
}

/** Read an attribute value from a single tag's text, or null. Handles single,
 * double, and unquoted values. */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  const val = m[2] ?? m[3] ?? m[4] ?? '';
  return decodeEntities(val.trim());
}

/** Decode the handful of HTML entities that appear in URLs. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
