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
