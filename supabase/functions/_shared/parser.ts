// Readmo feed parser.
//
// Normalizes the four feed dialects we support — RSS 2.0, Atom 1.0,
// RSS 1.0 / RDF, and JSON Feed — into a single neutral item shape so the
// rest of the pipeline (sanitize, de-dup, store) never has to branch on
// format. See SPEC.md "Feed fetching & parsing (server)".
//
// IMPORTANT: this module is authored as plain TypeScript with a BARE npm
// specifier for `fast-xml-parser` so vitest (node) can import it directly.
// Deno resolves the bare specifier through supabase/functions/import_map.json.
//
// This module is pure: no network, no DB, no DOM. `parseFeed(raw, feedUrl)`
// takes the raw response body and the feed's own URL (used as the base for
// absolutizing relative links and as a GUID fallback) and returns the feed
// title, the site URL, and the normalized items.

import { XMLParser } from 'fast-xml-parser';
import { decodeHTML } from 'entities';
import { looksTokenizedAllowingQuery } from './urlSafety.ts';

/** A single normalized feed entry. All string fields are trimmed; absent
 * optional fields are `null` rather than `undefined` so callers (and the DB
 * upsert) see a stable shape. */
export interface NormalizedItem {
  /** Stable per-feed identity. Falls back to url, then a content hash. */
  guid: string;
  /** Absolute canonical link to the original article, or null. */
  url: string | null;
  /** Absolute URL of the item's comments/discussion page, or null. The RSS 2.0
   * `<comments>` element (Hacker News, WordPress, lobste.rs, …) or the Atom
   * `<link rel="replies">` (RFC 4685). Distinct from `url` (the article) — for
   * aggregator feeds like Hacker News this is the discussion thread. */
  commentsUrl: string | null;
  title: string | null;
  author: string | null;
  /** ISO-8601 string when parseable, else null. */
  publishedAt: string | null;
  /** Raw (UNSANITIZED) HTML body. The caller MUST run sanitizeContent()
   * before storing or serving — this module never trusts publisher HTML. */
  contentHtml: string | null;
  /** Short text/HTML summary distinct from the full body when available. */
  summary: string | null;
  /** Media attachments (podcast audio, images, etc.). */
  enclosures: Enclosure[];
}

export interface Enclosure {
  url: string;
  type: string | null;
  length: number | null;
}

export interface ParsedFeed {
  feedTitle: string | null;
  /** The human-facing website for the feed (NOT the feed URL itself). */
  siteUrl: string | null;
  /** Absolute http(s) URL of a small site icon for the feed, or null. Sourced
   * from the feed's advertised icon (Atom <icon>/<logo>, RSS <image>, JSON
   * Feed favicon/icon) when present, else derived as the site origin's
   * /favicon.ico. Display-only; the client <img> loads it directly and hides
   * it on error, so a guessed /favicon.ico that 404s costs nothing. */
  faviconUrl: string | null;
  items: NormalizedItem[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep text+attribute mixed nodes addressable via a known key.
  textNodeName: '#text',
  trimValues: true,
  // Treat these as always-arrays so single vs. multiple is uniform.
  isArray: (name) =>
    name === 'item' || name === 'entry' || name === 'enclosure',
  // Preserve namespace prefixes (dc:creator, content:encoded, sy:*).
  removeNSPrefix: false,
});

/** Coerce fast-xml-parser's value (string | number | {#text} | object) to a
 * trimmed string, or null. */
function text(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (typeof node === 'object') {
    const t = (node as Record<string, unknown>)['#text'];
    if (t != null) return text(t);
  }
  return null;
}

/**
 * Decode HTML/XML character entities in a PLAIN-TEXT field.
 *
 * `fast-xml-parser` only resolves the five predefined XML entities
 * (`&amp; &lt; &gt; &quot; &apos;`). It leaves numeric character references
 * (`&#8217;`, `&#x2019;`) and HTML named entities (`&rsquo;`, `&nbsp;`)
 * intact — and it un-escapes the outer `&amp;` of a double-encoded entity
 * (`&amp;#8217;` → `&#8217;`). Plain-text fields (item/feed titles, author
 * bylines) are rendered as React text nodes, which escape their input, so an
 * undecoded entity shows up literally in the UI ("Something&#8217;s off").
 * Decode here so the stored value is the actual character.
 *
 * The HTML *body* (`contentHtml`) is intentionally NOT routed through this —
 * it is sanitized and rendered as HTML, where entities are meaningful and the
 * browser decodes them. Decoding it here would turn deliberately-escaped
 * markup in code samples (`&lt;script&gt;`) into live tags before sanitizing.
 */
function decodeText(value: string | null): string | null {
  return value == null ? null : decodeHTML(value);
}

/** Return the first non-null candidate. */
function firstOf<T>(...vals: (T | null | undefined)[]): T | null {
  for (const v of vals) if (v != null) return v;
  return null;
}

/** Resolve a possibly-relative URL against a base; return null on failure or
 * empty input. */
export function absolutizeUrl(
  href: string | null | undefined,
  base: string | null | undefined,
): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    // If `href` is already absolute, the base is ignored by the URL ctor.
    return new URL(trimmed, base ?? undefined).toString();
  } catch {
    // Absolute parse can still fail (e.g. no base + relative input).
    try {
      return new URL(trimmed).toString();
    } catch {
      return null;
    }
  }
}

/** Cap on a stored favicon URL — keeps a pathological feed from writing a
 * huge data: URI (or other junk) into the feeds row. */
const MAX_FAVICON_URL_LEN = 2048;

/** Normalize a favicon candidate to an absolute, reasonably-sized http(s) URL,
 * or null. Rejects non-http(s) schemes (data:, javascript:, …) AND anything
 * that looks tokenized — embedded credentials, a high-entropy/matrix path
 * segment, or a query value that isn't a short integer. Numeric image-resize
 * queries ARE allowed (`looksTokenizedAllowingQuery`): publishers' advertised
 * icons routinely carry params like `…/icon.png?w=150&h=150&crop=1`, which we
 * must not throw away. A favicon is STORED in `feeds.favicon_url` and exposed to EVERY
 * subscriber via `feeds_public`, so a genuinely secret-bearing icon URL must not
 * leak; failing closed here makes the caller fall back to the derived
 * /favicon.ico. */
function cleanFaviconUrl(href: string | null): string | null {
  if (!href) return null;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // A fragment is never meaningful on a stored favicon (an <img> never sends
  // it), but it would still be persisted/exposed via feeds_public — and could
  // carry a per-subscriber token (`…?w=150#access_token=…`). Strip it.
  u.hash = '';
  const s = u.toString();
  if (s.length > MAX_FAVICON_URL_LEN) return null;
  if (looksTokenizedAllowingQuery(s)) return null;
  return s;
}

/** Last-resort favicon: the well-known `/favicon.ico` at the site (or, lacking
 * a site URL, the feed) origin. Pure URL construction — no extra server fetch;
 * the client <img> loads it and hides it via onError if the host serves none.
 * The `/favicon.ico` path drops any query/fragment, but `new URL` keeps the
 * base's scheme and userinfo — so run the result through the SAME
 * {@link cleanFaviconUrl} screen, which fails closed on a non-http(s) base
 * (e.g. `ftp://…`) or one carrying credentials. */
function deriveFavicon(siteUrl: string | null, feedUrl: string): string | null {
  try {
    return cleanFaviconUrl(new URL('/favicon.ico', siteUrl ?? feedUrl).toString());
  } catch {
    return null;
  }
}

/** Resolve a feed's favicon: prefer the feed-advertised icon (absolutized,
 * scheme-checked) since it's intentional and won't 404, else fall back to the
 * derived `/favicon.ico`. */
function resolveFavicon(
  explicit: string | null,
  siteUrl: string | null,
  feedUrl: string,
): string | null {
  return (
    cleanFaviconUrl(absolutizeUrl(explicit, siteUrl ?? feedUrl)) ??
    deriveFavicon(siteUrl, feedUrl)
  );
}

/** Parse a date into an ISO string, tolerating RFC 822 (RSS) and RFC 3339
 * (Atom). Returns null when unparseable rather than "Invalid Date". */
export function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** Deterministic non-cryptographic hash (FNV-1a, 32-bit) rendered as hex.
 * Used as a last-resort GUID and as the content_hash for edit detection.
 * Pure and dependency-free so it runs identically in node and Deno. */
export function contentHash(...parts: (string | null | undefined)[]): string {
  let h = 0x811c9dc5;
  const s = parts.filter((p) => p != null).join(' ');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // h *= 16777619, kept in 32-bit space.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a raw feed body into a normalized ParsedFeed.
 *
 * @param raw     The feed response body (XML or JSON text).
 * @param feedUrl The URL the body was fetched from. Used as the base for
 *                relative-URL absolutization and as a GUID-fallback seed.
 * @throws Error if the body is neither valid JSON Feed nor a recognized XML
 *               feed root (RSS / RDF / Atom).
 */
export function parseFeed(raw: string, feedUrl: string): ParsedFeed {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error('Empty feed body');

  // JSON Feed: starts with `{` and parses as JSON with a `version` and
  // `items` array (https://jsonfeed.org/version/1.1).
  if (trimmed[0] === '{') {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new Error('Body looks like JSON but failed to parse');
    }
    return parseJsonFeed(json, feedUrl);
  }

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse XML feed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (doc.rss) return parseRss2(doc.rss as Record<string, unknown>, feedUrl);
  // RSS 1.0 / RDF uses an <rdf:RDF> root; removeNSPrefix:false keeps the
  // prefix, so the key is "rdf:RDF".
  if (doc['rdf:RDF']) {
    return parseRdf(doc['rdf:RDF'] as Record<string, unknown>, feedUrl);
  }
  if (doc.feed) return parseAtom(doc.feed as Record<string, unknown>, feedUrl);

  throw new Error(
    'Unrecognized feed: no <rss>, <rdf:RDF>, or <feed> root element',
  );
}

// ---------------------------------------------------------------------------
// RSS 2.0
// ---------------------------------------------------------------------------

function parseRss2(rss: Record<string, unknown>, feedUrl: string): ParsedFeed {
  const channel = (rss.channel as Record<string, unknown>) ?? {};
  const siteUrl = absolutizeUrl(text(channel.link), feedUrl);
  // RSS 2.0 channel logo: <image><url>.
  const channelImage = (channel.image as Record<string, unknown>) ?? {};
  const faviconUrl = resolveFavicon(text(channelImage.url), siteUrl, feedUrl);
  const rawItems = (channel.item as Record<string, unknown>[]) ?? [];

  const items = rawItems.map((it) => {
    const url = absolutizeUrl(text(it.link), feedUrl);
    // <content:encoded> carries the full body; <description> the summary.
    const contentHtml = firstOf(
      text(it['content:encoded']),
      text(it.description),
    );
    const summary = text(it.description);
    const author = firstOf(text(it['dc:creator']), text(it.author));
    const publishedAt = toIso(
      firstOf(text(it.pubDate), text(it['dc:date'])),
    );

    // <guid> may be a bare string or {#text, @_isPermaLink}.
    const guidRaw = text(it.guid);
    return finalizeItem({
      guidRaw,
      url,
      commentsUrl: absolutizeUrl(text(it.comments), feedUrl),
      title: text(it.title),
      author,
      publishedAt,
      contentHtml,
      summary: summary === contentHtml ? null : summary,
      enclosures: collectEnclosures(it.enclosure, feedUrl),
      feedUrl,
    });
  });

  return { feedTitle: decodeText(text(channel.title)), siteUrl, faviconUrl, items };
}

// ---------------------------------------------------------------------------
// RSS 1.0 / RDF
// ---------------------------------------------------------------------------

function parseRdf(rdf: Record<string, unknown>, feedUrl: string): ParsedFeed {
  const channel = (rdf.channel as Record<string, unknown>) ?? {};
  const siteUrl = absolutizeUrl(text(channel.link), feedUrl);
  // RDF <image> is a sibling of <channel> under the RDF root, with a <url>.
  const rdfImage = (rdf.image as Record<string, unknown>) ?? {};
  const faviconUrl = resolveFavicon(text(rdfImage.url), siteUrl, feedUrl);
  // In RDF, <item> elements are siblings of <channel> under the RDF root.
  const rawItems = (rdf.item as Record<string, unknown>[]) ?? [];

  const items = rawItems.map((it) => {
    const url = absolutizeUrl(
      // RDF items carry the link as element text and often also as rdf:about.
      firstOf(text(it.link), text(it['@_rdf:about'])),
      feedUrl,
    );
    const contentHtml = firstOf(
      text(it['content:encoded']),
      text(it.description),
    );
    const summary = text(it.description);
    return finalizeItem({
      guidRaw: firstOf(text(it['@_rdf:about']), url),
      url,
      commentsUrl: absolutizeUrl(text(it.comments), feedUrl),
      title: text(it.title),
      author: firstOf(text(it['dc:creator']), text(it.creator)),
      publishedAt: toIso(firstOf(text(it['dc:date']), text(it.date))),
      contentHtml,
      summary: summary === contentHtml ? null : summary,
      enclosures: [],
      feedUrl,
    });
  });

  return { feedTitle: decodeText(text(channel.title)), siteUrl, faviconUrl, items };
}

// ---------------------------------------------------------------------------
// Atom 1.0
// ---------------------------------------------------------------------------

function parseAtom(feed: Record<string, unknown>, feedUrl: string): ParsedFeed {
  const siteUrl = pickAtomLink(feed.link, feedUrl, ['alternate', '']);
  // Atom <icon> is a square site icon (ideal favicon); <logo> a wider banner.
  const faviconUrl = resolveFavicon(
    firstOf(text(feed.icon), text(feed.logo)),
    siteUrl,
    feedUrl,
  );
  const rawEntries = (feed.entry as Record<string, unknown>[]) ?? [];

  const items = rawEntries.map((e) => {
    const url = pickAtomLink(e.link, feedUrl, ['alternate', '']);
    // <content> is the full body; <summary> the short form. Both may carry
    // type="html|xhtml|text" and either text or nested markup.
    const contentHtml = atomContent(e.content);
    const summary = atomContent(e.summary);
    return finalizeItem({
      guidRaw: firstOf(text(e.id), url),
      url,
      // Atom Threading Extensions (RFC 4685): the discussion is <link
      // rel="replies">. Strict match — never the alternate/article link.
      commentsUrl: atomRepliesUrl(e.link, feedUrl),
      title: atomText(e.title),
      author: atomAuthor(e.author),
      publishedAt: toIso(firstOf(text(e.published), text(e.updated))),
      contentHtml: firstOf(contentHtml, summary),
      summary: summary === contentHtml ? null : summary,
      enclosures: collectAtomEnclosures(e.link, feedUrl),
      feedUrl,
    });
  });

  return { feedTitle: decodeText(atomText(feed.title)), siteUrl, faviconUrl, items };
}

/** Atom <title>/<summary> can be {@_type, #text} or carry inline markup. */
function atomText(node: unknown): string | null {
  return text(node);
}

/** Atom content: returns inner HTML when type is html/xhtml, else text. */
function atomContent(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    // xhtml content nests a <div>; fast-xml-parser would expose it as an
    // object. We only have the text node reliably; fall through to #text.
    return text(obj['#text']) ?? text(obj.div) ?? null;
  }
  return null;
}

function atomAuthor(node: unknown): string | null {
  if (node == null) return null;
  // <author><name>…</name></author>, or an array of authors.
  const one = Array.isArray(node) ? node[0] : node;
  if (one == null) return null;
  if (typeof one === 'string') return one.trim() || null;
  const obj = one as Record<string, unknown>;
  return firstOf(text(obj.name), text(obj['#text']));
}

/** Choose the best Atom <link>. `rels` lists acceptable rel values in
 * priority order ('' matches a link with no rel, which defaults to
 * alternate). Returns an absolutized href. */
function pickAtomLink(
  link: unknown,
  feedUrl: string,
  rels: string[],
): string | null {
  const links = normalizeLinks(link);
  for (const rel of rels) {
    const match = links.find((l) => (l.rel ?? '') === rel);
    if (match?.href) return absolutizeUrl(match.href, feedUrl);
  }
  // Last resort: first link with an href.
  const any = links.find((l) => l.href);
  return any ? absolutizeUrl(any.href, feedUrl) : null;
}

interface AtomLink {
  href: string | null;
  rel: string | null;
  type: string | null;
  length: number | null;
}

function normalizeLinks(link: unknown): AtomLink[] {
  if (link == null) return [];
  const arr = Array.isArray(link) ? link : [link];
  return arr.map((l) => {
    if (typeof l === 'string') {
      return { href: l, rel: null, type: null, length: null };
    }
    const obj = l as Record<string, unknown>;
    return {
      href: text(obj['@_href']),
      rel: text(obj['@_rel']),
      type: text(obj['@_type']),
      length: toInt(text(obj['@_length'])),
    };
  });
}

/** Atom comments/discussion link: <link rel="replies"> (RFC 4685). Strict — a
 * missing replies link returns null rather than falling back to the article
 * link, so `commentsUrl` is only ever the actual discussion page. */
function atomRepliesUrl(link: unknown, feedUrl: string): string | null {
  const match = normalizeLinks(link).find((l) => l.rel === 'replies' && l.href);
  return match?.href ? absolutizeUrl(match.href, feedUrl) : null;
}

/** Atom enclosures are <link rel="enclosure">. */
function collectAtomEnclosures(link: unknown, feedUrl: string): Enclosure[] {
  return normalizeLinks(link)
    .filter((l) => l.rel === 'enclosure' && l.href)
    .map((l) => ({
      url: absolutizeUrl(l.href, feedUrl)!,
      type: l.type,
      length: l.length,
    }));
}

// ---------------------------------------------------------------------------
// JSON Feed 1.x
// ---------------------------------------------------------------------------

function parseJsonFeed(json: unknown, feedUrl: string): ParsedFeed {
  if (json == null || typeof json !== 'object') {
    throw new Error('JSON feed is not an object');
  }
  const feed = json as Record<string, unknown>;
  if (!Array.isArray(feed.items)) {
    throw new Error('JSON feed has no items array');
  }

  const siteUrl = absolutizeUrl(asStr(feed.home_page_url), feedUrl);
  // JSON Feed `favicon` is the small square icon; `icon` the larger image.
  const faviconUrl = resolveFavicon(
    firstOf(asStr(feed.favicon), asStr(feed.icon)),
    siteUrl,
    feedUrl,
  );

  const items = (feed.items as Record<string, unknown>[]).map((it) => {
    const url = absolutizeUrl(firstOf(asStr(it.url), asStr(it.external_url)), feedUrl);
    const contentHtml = firstOf(asStr(it.content_html), asStr(it.content_text));
    const author = jsonAuthor(it.author ?? it.authors);
    return finalizeItem({
      guidRaw: firstOf(asStr(it.id), url),
      url,
      title: asStr(it.title),
      author,
      publishedAt: toIso(firstOf(asStr(it.date_published), asStr(it.date_modified))),
      contentHtml,
      summary: asStr(it.summary),
      enclosures: collectJsonAttachments(it.attachments, feedUrl),
      feedUrl,
    });
  });

  return { feedTitle: decodeText(asStr(feed.title)), siteUrl, faviconUrl, items };
}

function jsonAuthor(node: unknown): string | null {
  if (node == null) return null;
  const one = Array.isArray(node) ? node[0] : node;
  if (one == null) return null;
  if (typeof one === 'string') return one.trim() || null;
  return asStr((one as Record<string, unknown>).name);
}

function collectJsonAttachments(node: unknown, feedUrl: string): Enclosure[] {
  if (!Array.isArray(node)) return [];
  return node
    .map((a) => {
      const obj = a as Record<string, unknown>;
      const url = absolutizeUrl(asStr(obj.url), feedUrl);
      if (!url) return null;
      return {
        url,
        type: asStr(obj.mime_type),
        length: toInt(asStr(obj.size_in_bytes)),
      } as Enclosure;
    })
    .filter((e): e is Enclosure => e != null);
}

function asStr(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

// ---------------------------------------------------------------------------
// Shared finalization
// ---------------------------------------------------------------------------

interface FinalizeInput {
  guidRaw: string | null;
  url: string | null;
  /** Comments/discussion URL, or null/absent. JSON Feed has no comments
   * concept, so its caller omits this (defaults to null). */
  commentsUrl?: string | null;
  title: string | null;
  author: string | null;
  publishedAt: string | null;
  contentHtml: string | null;
  summary: string | null;
  enclosures: Enclosure[];
  feedUrl: string;
}

/** Apply the GUID fallback chain (explicit guid → url → content hash) and the
 * content hash, then assemble the normalized item. */
function finalizeItem(input: FinalizeInput): NormalizedItem {
  const hash = contentHash(
    input.title,
    input.url,
    input.contentHtml,
    input.publishedAt,
  );
  const guid =
    firstOf(input.guidRaw, input.url) ?? `${input.feedUrl}#${hash}`;
  return {
    guid,
    url: input.url,
    commentsUrl: input.commentsUrl ?? null,
    // Titles and bylines are rendered as plain text in the UI, so decode any
    // entities the XML parser left behind (numeric / named / double-encoded).
    title: decodeText(input.title),
    author: decodeText(input.author),
    publishedAt: input.publishedAt,
    contentHtml: input.contentHtml,
    summary: input.summary,
    enclosures: input.enclosures,
  };
}

function collectEnclosures(node: unknown, feedUrl: string): Enclosure[] {
  if (node == null) return [];
  const arr = Array.isArray(node) ? node : [node];
  return arr
    .map((e) => {
      const obj = e as Record<string, unknown>;
      const url = absolutizeUrl(text(obj['@_url']), feedUrl);
      if (!url) return null;
      return {
        url,
        type: text(obj['@_type']),
        length: toInt(text(obj['@_length'])),
      } as Enclosure;
    })
    .filter((e): e is Enclosure => e != null);
}

/**
 * Parse a feed body, with a guard against HTML bot-challenge / paywall pages.
 *
 * Parse-first: if parseFeed succeeds and the result has a title or items we
 * accept the body regardless of Content-Type, so mislabelled-but-valid feeds
 * (served as `text/html` by misconfigured servers) still work. The HTML guard
 * fires only when the parse yields nothing useful AND the Content-Type signals
 * HTML — the exact signature of a bot-challenge or redirect page.
 */
export function parseFeedBody(body: string, feedUrl: string, contentType: string): ParsedFeed {
  let parsed: ParsedFeed;
  try {
    parsed = parseFeed(body, feedUrl);
  } catch (err) {
    if (contentType.includes('text/html')) {
      throw new Error(`non-feed response (${contentType})`);
    }
    throw err;
  }
  if (!parsed.feedTitle && parsed.items.length === 0 && contentType.includes('text/html')) {
    throw new Error(`non-feed response (${contentType})`);
  }
  return parsed;
}

function toInt(v: string | null): number | null {
  if (v == null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}
