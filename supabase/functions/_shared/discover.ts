// Readmo feed discovery.
//
// Given an HTML page (and the URL it came from), find candidate feed URLs from
// <link rel="alternate"> tags plus common path fallbacks. Reddit is a
// first-class source: its pages don't reliably advertise their feeds, so we
// DERIVE the `.rss` form from the URL shape instead of relying on autodiscovery
// (SPEC.md "Feed discovery").
//
// Both exported functions are PURE (string in, string[]/string out) so they
// unit-test without network. The caller is responsible for fetching each
// candidate through the SSRF-hardened safeFetch and validating it parses
// before offering it to the user.

/** Common path fallbacks tried when a page advertises no <link> feeds. */
const FALLBACK_PATHS = ['/feed', '/rss', '/atom.xml', '/feed.json', '/rss.xml'];

/**
 * Cap on how many feed-looking `<a href>` links `discoverAnchorFeeds` harvests
 * from a directory-style page. Bounds the extra validation fetches on the
 * no-advertised-feed path while sitting comfortably above real directory sizes
 * (Fox Sports lists ~27 per-sport feeds; a big publisher might list ~40). The
 * caller stops harvesting once it hits this many candidates, so a link-heavy
 * page can't fan out unboundedly.
 */
export const MAX_ANCHOR_CANDIDATES = 50;

/**
 * A URL (host + path + query, lowercased) that looks like a feed: an `rss`/
 * `atom`/`feed(s)` token bounded by a URL separator, or an `.xml`/`.rss`/`.atom`
 * file. The separator classes include `?=&` so query-string feeds (`?feed=rss2`)
 * match and `-._/` so a hyphenated segment (`/content-feeds/afl`) matches, while
 * a boundary requirement keeps `/feedback` (feed + letter) from matching.
 *
 * The **host** is included so a feed-hosted link with an opaque path still
 * matches on its subdomain — `feeds.feedburner.com/x`, `feeds.simplecast.com/x`,
 * `rss.cnn.com/x` — where the path alone carries no feed token. This is a
 * permissive *pre-filter* only: every survivor is still fetched + parsed before
 * being offered, so a false positive costs one wasted fetch, not a bad candidate.
 */
const FEED_HREF_RE =
  /(?:^|[/._\-?=&])(?:rss|atom|feeds?)(?:[/._\-?=&#]|$)|\.(?:xml|rss|atom)(?:[?#]|$)/i;

/** Feed MIME types we recognize in <link type="…">. */
const FEED_TYPES = [
  'application/rss+xml',
  'application/atom+xml',
  'application/feed+json',
  'application/json',
];

export interface FeedCandidate {
  url: string;
  /** The advertised MIME type, or null for path fallbacks. */
  type: string | null;
  /** A human label from the <link title="…"> when present. */
  title: string | null;
}

/**
 * Discover feed candidates from an HTML page.
 *
 * @param html    The page's HTML source.
 * @param baseUrl The URL the page was fetched from (for absolutizing hrefs and
 *                deriving fallback paths). Also used to detect Reddit.
 * @returns De-duplicated, absolutized candidates. <link>-advertised feeds come
 *          first (in document order), then path fallbacks. For Reddit URLs the
 *          derived `.rss` form is prepended.
 */
export function discoverFromHtml(html: string, baseUrl: string): FeedCandidate[] {
  const candidates: FeedCandidate[] = [];
  const seen = new Set<string>();

  const push = (url: string | null, type: string | null, title: string | null) => {
    if (!url) return;
    const abs = absolutize(url, baseUrl);
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    candidates.push({ url: abs, type, title });
  };

  // Reddit takes precedence — derive the canonical .rss feed for the URL.
  const reddit = redditFeedFor(baseUrl);
  if (reddit) push(reddit, 'application/atom+xml', 'Reddit feed');

  // Parse <link rel="alternate" type="<feed mime>" href="…" title="…">.
  // We scan <link …> tags with a regex rather than a full DOM parser to keep
  // the module dependency-free and node/Deno-portable.
  for (const tag of iterateLinkTags(html)) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    const type = (attr(tag, 'type') ?? '').toLowerCase();
    if (!rel.split(/\s+/).includes('alternate')) continue;
    if (!FEED_TYPES.includes(type)) continue;
    push(attr(tag, 'href'), type, attr(tag, 'title'));
  }

  // Common path fallbacks, resolved against the origin.
  for (const path of FALLBACK_PATHS) {
    push(path, null, null);
  }

  return candidates;
}

/**
 * Harvest feed-looking `<a href>` links from a page body, for the case
 * `discoverFromHtml` can't cover: a "here are our RSS feeds" *directory* page
 * (e.g. foxsports.com.au/about-us/rss-feeds) that lists its feeds as ordinary
 * body hyperlinks rather than advertising them via `<link rel="alternate">`
 * autodiscovery tags. Autodiscovery misses every one of them; scraping the
 * anchors recovers them.
 *
 * Lower-confidence than `discoverFromHtml`, so the caller uses this only as a
 * fallback when `<link>`/path discovery validated nothing, and every returned
 * URL is still fetched + parsed through the SSRF-hardened path before being
 * offered. Only hrefs whose path/query looks feed-shaped (`FEED_HREF_RE`) are
 * kept, and the result is de-duplicated, absolutized, and capped at
 * `MAX_ANCHOR_CANDIDATES` (document order) to bound the follow-up fetches.
 *
 * `type`/`title` are null — like path fallbacks, an anchor is a guess, so a
 * candidate that fails to parse is NOT reported as a discovery failure reason.
 */
export function discoverAnchorFeeds(html: string, baseUrl: string): FeedCandidate[] {
  const candidates: FeedCandidate[] = [];
  const seen = new Set<string>();
  // The page's own address, sans fragment — used to drop self-referential
  // anchors (a bare `#anchor` or a link back to this page) that would otherwise
  // match when the page's own path is feed-shaped (e.g. `/about-us/rss-feeds`).
  let selfKey: string | null = null;
  try {
    const b = new URL(baseUrl);
    selfKey = `${b.origin}${b.pathname}${b.search}`;
  } catch {
    selfKey = null;
  }
  for (const tag of iterateAnchorTags(html)) {
    if (candidates.length >= MAX_ANCHOR_CANDIDATES) break;
    const href = attr(tag, 'href');
    if (!href) continue;
    const abs = absolutize(href, baseUrl);
    if (!abs || seen.has(abs)) continue;
    let parsed: URL;
    try {
      parsed = new URL(abs);
    } catch {
      continue;
    }
    // http(s) only — mailto:, javascript:, and the like aren't fetch targets.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    // Skip a link back to this same page (a `#fragment` or self-link): it can't
    // be a different feed, and re-fetching the directory page is wasted work.
    if (selfKey !== null && `${parsed.origin}${parsed.pathname}${parsed.search}` === selfKey) {
      continue;
    }
    // Match on host + path + query so a feed-hosted link with an opaque path
    // (feeds.feedburner.com/x) still passes on its subdomain (see FEED_HREF_RE).
    if (!FEED_HREF_RE.test(`${parsed.hostname}${parsed.pathname}${parsed.search}`.toLowerCase())) {
      continue;
    }
    seen.add(abs);
    candidates.push({ url: abs, type: null, title: null });
  }
  return candidates;
}

/** <link rel> tokens that name a site icon, in preference order: the standard
 * `icon`/`shortcut icon` favicon first, then the (usually higher-res PNG)
 * apple-touch variants, then Safari's `mask-icon`. `shortcut icon` splits into
 * the `icon` token, so tier 0 matches both. */
const ICON_REL_TIERS: readonly (readonly string[])[] = [
  ['icon'],
  ['apple-touch-icon', 'apple-touch-icon-precomposed'],
  ['mask-icon'],
];

/**
 * Every site icon a page advertises via `<link rel="icon" href="…">` (or an
 * apple-touch / mask-icon variant), absolutized against `baseUrl`, ordered
 * best-first: standard `icon`s before apple-touch before mask-icon, and within
 * a tier in document order. Empty when the page names none. This is the poller's
 * homepage-discovery fallback for the common case where a feed advertises no
 * icon of its own and the guessed `/favicon.ico` 404s (e.g. ft.com) but the
 * site's HTML head still points at a real icon.
 *
 * Scans only the `<head>` (icons live there) so a `<link>` in the body can't
 * masquerade as the favicon and the regex work stays bounded on large pages.
 * The returned URLs are NOT screened here — the caller runs each through the
 * same `cleanFaviconUrl` scheme/tokenization gate every stored favicon passes,
 * taking the first that survives. Returning the full list (not just the top
 * pick) lets the caller skip past a rejected candidate — a `data:` icon or a
 * tokenized `?v=…` URL — to a later safe one instead of giving up.
 */
export function discoverIconFromHtml(html: string, baseUrl: string): string[] {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  // Advertised hrefs per tier, in document order.
  const perTier: string[][] = ICON_REL_TIERS.map(() => []);
  for (const tag of iterateLinkTags(head)) {
    const rels = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (rels.length === 0) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    for (let tier = 0; tier < ICON_REL_TIERS.length; tier++) {
      if (ICON_REL_TIERS[tier].some((r) => rels.includes(r))) {
        perTier[tier].push(href);
        break; // a tag belongs to its highest-priority matching tier only
      }
    }
  }
  const candidates: string[] = [];
  for (const tier of perTier) {
    for (const href of tier) {
      const abs = absolutize(href, baseUrl);
      if (abs) candidates.push(abs);
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Deep-link & last-resort fallbacks
// ---------------------------------------------------------------------------

/**
 * The site home page for a pasted deep link, or null when there's nothing new
 * to gain by probing it. A pasted article (e.g. `/football/news/123/story`)
 * usually doesn't advertise the site's feed in its own <head>, but the home
 * page almost always does — so when the page itself yields no feed we re-probe
 * the origin root. Returns null when `pageUrl` is already the root (no path, no
 * query) or isn't an http(s) URL, so the caller skips a redundant fetch.
 */
export function homePageUrl(pageUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  // Already at the root with no query — the page we just probed *is* the home
  // page, so there's nothing further to discover here.
  if (path === '' && parsed.search === '') return null;
  return `${parsed.protocol}//${parsed.host}/`;
}

/** Locale knobs for the Google News RSS endpoint. US English by default
 * (US-English-everywhere house rule). */
export const GOOGLE_NEWS_LOCALE = { hl: 'en-US', gl: 'US', ceid: 'US:en' } as const;

/**
 * A Google News RSS search feed scoped to the pasted page's domain
 * (`site:<host>`), or null when the URL isn't usable. This is the last-resort
 * fallback: when neither the pasted page nor the site home page advertises a
 * real feed, a `site:` search still gives the reader *something* — a
 * continuously-updated feed of that publisher's recent articles, assembled by
 * Google rather than the publisher. The publisher's own feed always wins when
 * one exists; this only fires when discovery would otherwise come up empty.
 *
 * Returns null for non-http(s) URLs, hostless inputs, and Google's own hosts
 * (so we never aggregate Google News over itself).
 */
export function googleNewsFeedFor(
  pageUrl: string,
  locale: { hl: string; gl: string; ceid: string } = GOOGLE_NEWS_LOCALE,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  // Need a real registrable domain; bare hostnames (localhost) can't be a
  // meaningful `site:` filter.
  if (!host || !host.includes('.')) return null;
  if (host === 'google.com' || host === 'news.google.com') return null;
  const params = new URLSearchParams({
    q: `site:${host}`,
    hl: locale.hl,
    gl: locale.gl,
    ceid: locale.ceid,
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Reddit
// ---------------------------------------------------------------------------

/**
 * Derive the canonical `.rss` feed URL for a Reddit page, or null if `url` is
 * not a recognized Reddit shape. Handles (per SPEC.md):
 *   - subreddit         /r/<sub>            -> /r/<sub>.rss
 *   - sorted subreddit  /r/<sub>/top|new|hot|rising -> /r/<sub>/<sort>.rss
 *   - subreddit search  /r/<sub>/search?q=… -> /r/<sub>/search.rss?q=…&restrict_sr=1
 *   - multireddit       /user/<u>/m/<name>  -> /user/<u>/m/<name>.rss
 *   - user posts        /user/<u> (or /u/<u>) -> /user/<u>.rss
 *   - logged-out home   /  or  /r/popular   -> /.rss  (or /r/popular.rss)
 * An already-`.rss` URL is returned normalized. The query string is preserved
 * for search.
 */
export function redditFeedFor(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  // Match reddit.com and its subdomains (www., old., np., new.).
  if (host !== 'reddit.com' && !host.endsWith('.reddit.com')) return null;

  // Canonicalize to https://www.reddit.com so derived feeds hit a stable host.
  const origin = 'https://www.reddit.com';

  // Strip a trailing slash (but keep root "/" meaningful) and any existing
  // .rss suffix so we can re-derive cleanly.
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path === '') path = '/';
  const search = parsed.search; // includes leading '?' or ''

  const withRss = (p: string, extraQuery = ''): string => {
    const q = mergeQuery(search, extraQuery);
    return `${origin}${p}.rss${q}`;
  };

  // Already a feed URL → normalize host/scheme, keep as-is.
  if (path.endsWith('.rss')) {
    return `${origin}${path}${search}`;
  }

  const SORTS = ['top', 'new', 'hot', 'rising', 'controversial', 'best'];

  // /r/<sub>/search
  let m = path.match(/^\/r\/([^/]+)\/search$/i);
  if (m) {
    // restrict_sr=1 keeps the search scoped to the subreddit (SPEC.md).
    return withRss(`/r/${m[1]}/search`, 'restrict_sr=1');
  }

  // /r/<sub>/<sort>
  m = path.match(/^\/r\/([^/]+)\/([^/]+)$/i);
  if (m && SORTS.includes(m[2].toLowerCase())) {
    return withRss(`/r/${m[1]}/${m[2].toLowerCase()}`);
  }

  // /r/<sub>
  m = path.match(/^\/r\/([^/]+)$/i);
  if (m) return withRss(`/r/${m[1]}`);

  // /user/<u>/m/<name>  (multireddit) — accept /u/ alias too.
  m = path.match(/^\/(?:user|u)\/([^/]+)\/m\/([^/]+)$/i);
  if (m) return withRss(`/user/${m[1]}/m/${m[2]}`);

  // /user/<u>  or  /u/<u>
  m = path.match(/^\/(?:user|u)\/([^/]+)$/i);
  if (m) return withRss(`/user/${m[1]}`);

  // Logged-out home / popular / all roots: /, /r/popular, /r/all.
  // The home feed lives at /.rss (note the leading slash is preserved).
  if (path === '/') return withRss('/');
  m = path.match(/^\/r\/(popular|all)$/i);
  if (m) return withRss(`/r/${m[1].toLowerCase()}`);

  return null;
}

/** Merge an existing "?a=b" search string with extra "k=v" params, avoiding
 * duplicate keys already present. */
function mergeQuery(search: string, extra: string): string {
  const params = new URLSearchParams(search.replace(/^\?/, ''));
  if (extra) {
    for (const [k, v] of new URLSearchParams(extra)) {
      if (!params.has(k)) params.set(k, v);
    }
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------------------
// Tiny HTML attribute scanner (no DOM dependency)
// ---------------------------------------------------------------------------

/** Yield the raw text of each <link …> tag in the document. */
function* iterateLinkTags(html: string): Generator<string> {
  // Match <link ...> up to the closing '>' (self-closing or not). The 'i' flag
  // covers <LINK>; we stop at the first '>' not inside a quoted value.
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    yield m[0];
  }
}

/** Yield the raw text of each opening <a …> tag in the document. We only need
 * the tag's attributes (the href), not the link text, so the closing </a> is
 * irrelevant. Same regex-not-DOM approach as iterateLinkTags. */
function* iterateAnchorTags(html: string): Generator<string> {
  const re = /<a\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    yield m[0];
  }
}

/** Read an attribute value from a single tag's text, or null. Handles single,
 * double, and unquoted values. */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i',
  );
  const m = re.exec(tag);
  if (!m) return null;
  const val = m[2] ?? m[3] ?? m[4] ?? '';
  return decodeEntities(val.trim());
}

/** Decode the handful of HTML entities that appear in URLs/titles. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function absolutize(href: string, base: string): string | null {
  try {
    return new URL(href.trim(), base).toString();
  } catch {
    try {
      return new URL(href.trim()).toString();
    } catch {
      return null;
    }
  }
}
