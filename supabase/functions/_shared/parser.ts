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
  /** The item's categories/tags/sections as the publisher labeled them — RSS/RDF
   * `<category>`, Atom `<category label|term>`, or JSON Feed `tags`. Order is the
   * feed's own (first is treated as primary for display). Trimmed, deduped, and
   * capped (see MAX_CATEGORIES/MAX_CATEGORY_LEN) so a pathological feed can't grow
   * the stored array without bound. Empty array, never null, when the feed
   * carries none. */
  categories: string[];
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
  /** True when {@link faviconUrl} came from an icon the feed *advertised*
   * (Atom <icon>/<logo>, RSS/RDF <image>, JSON Feed favicon/icon); false when
   * it's the derived /favicon.ico guess (or null). The poller uses this to
   * decide whether to bother discovering a real icon from the site homepage —
   * an advertised icon is authoritative and needs no extra fetch. */
  faviconAdvertised: boolean;
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

/**
 * Query-parameter keys that are pure click/campaign tracking and never
 * identify a distinct article. Stripped by {@link canonicalizeItemUrl} so a
 * publisher (notably the BBC) re-issuing the same story with a rotated
 * campaign tag collapses to ONE stored row under the `(feed_id, url)` dedup
 * key instead of piling up identical entries.
 *
 * Keep this list in sync with the SQL twin `canonicalize_item_url()` in
 * migration `0048_canonicalize_item_url.sql`, which uses it to collapse
 * already-stored dupes.
 */
const TRACKING_PARAM_KEYS = new Set([
  // Google / generic UTM.
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_name', 'utm_reader', 'utm_brand',
  // BBC (feeds.bbci.co.uk decorates article links with at_* campaign tags).
  'at_medium', 'at_campaign', 'at_campaign_type', 'at_custom1', 'at_custom2',
  'at_custom3', 'at_custom4', 'at_bbc_team', 'at_link_origin', 'at_ptr_name',
  // Social / ad click identifiers.
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid',
  'mc_cid', 'mc_eid', 'igshid',
  // Other common newsroom campaign params.
  'ito', 'ns_campaign', 'ns_mchannel', 'ns_source', 'ns_linkname', 'ns_fee',
  'cmp', 'ocid', 'ncid', 'spm',
]);

/**
 * Canonicalize an article URL for storage and de-duplication.
 *
 * The `(feed_id, url)` unique key de-dups a publisher re-issuing the same
 * article under a new `<guid>` — but only when the URL is byte-identical.
 * Publishers (notably the BBC) re-issue the same story with a rotating campaign
 * query tag, so the raw URLs differ and the same headline lands two or three
 * times in one feed (SPEC.md "Feed fetching & parsing → De-dup"). Strip the
 * query noise that never identifies a distinct article — known tracking params
 * — so campaign-tagged re-issues collapse to one row.
 *
 * The FRAGMENT is intentionally left untouched: it's part of the URL's
 * identity and is routinely load-bearing — a hash-router/hashbang route
 * (`#/article/123`), or a liveblog/update anchor (`#block-123`, or a bare
 * numeric `#124`) that distinguishes separate entries published on ONE page.
 * There's no reliable shape test that separates a cosmetic version counter from
 * a load-bearing anchor, and the BBC counter rides on the `<guid>` (which we
 * don't canonicalize), not the `<link>` — so stripping fragments would risk
 * collapsing distinct articles and corrupting their click-through URLs for no
 * BBC benefit. Publisher re-issues keep the same `<link>`, so the guid-only
 * change is already handled by the `(feed_id, url)` key + migration 0048's
 * collapse.
 *
 * Conservative by design: unknown query params are KEPT (they may be
 * load-bearing, e.g. `?id=123&page=2`), the path + fragment are untouched, and
 * an unparseable URL is returned unchanged. Idempotent.
 */
export function canonicalizeItemUrl(url: string | null): string | null {
  if (!url) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  // Drop tracking params by RAW-string surgery on the query, NOT via
  // URLSearchParams — reserializing would rewrite kept pairs (`?article` →
  // `?article=`, `?q=a%20b` → `?q=a+b`), which both changes the click-through
  // URL and, worse, diverges from the SQL twin (which splits the raw string):
  // migration 0048 would store `?article` while the parser later stores
  // `?article=`, so the (feed_id, url) dedup key misses and dupes reappear.
  // Split on `&`, keep the non-tracking pairs verbatim (key = substring before
  // the first `=`, lower-cased — matching `split_part`/`lower` in the SQL twin).
  const kept = u.search
    .replace(/^\?/, '')
    .split('&')
    .filter((pair) => pair !== '' && !TRACKING_PARAM_KEYS.has(pair.split('=')[0].toLowerCase()));
  u.search = kept.join('&');
  return u.toString();
}

/** Cap on a stored favicon URL — keeps a pathological feed from writing a
 * huge data: URI (or other junk) into the feeds row. */
const MAX_FAVICON_URL_LEN = 2048;

/** Caps on stored item categories/tags — keeps a pathological feed (or a
 * blog-style JSON Feed with a large free-form tag vocabulary) from writing an
 * unbounded array/strings into an item row. */
const MAX_CATEGORIES = 20;
const MAX_CATEGORY_LEN = 100;

/** Trim, length-cap, dedupe (exact match, order-preserving), and count-cap a
 * list of raw category/tag candidates. Shared by the three format-specific
 * extractors below so RSS `<category>`, Atom `<category label|term>`, and
 * JSON Feed `tags` all land in the same normalized shape. */
function normalizeCategories(raw: (string | null)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r) continue;
    // Postgres text/jsonb cannot store U+0000 at all (insert fails outright,
    // not just for this field). XML disallows a raw or numeric-char-ref NUL
    // outright, so this only reaches here via JSON Feed's `tags` (JSON strings
    // permit \u0000); strip it before it can fail the whole upsert_feed_items
    // batch for an otherwise-valid feed over display metadata.
    const trimmed = r.split('\u0000').join('').trim();
    // A JSON string may legally contain an UNPAIRED UTF-16 surrogate on its
    // own -- JSON.parse doesn't validate pairing -- with no truncation
    // involved at all. toWellFormed() replaces any such lone surrogate with
    // U+FFFD, so everything below operates on valid Unicode text.
    const wellFormed = trimmed.toWellFormed();
    // Array.from iterates by Unicode code point, not UTF-16 code unit, so
    // capping this way can never CREATE a lone surrogate by splitting a
    // surrogate pair (an astral character -- an emoji, say -- straddling the
    // MAX_CATEGORY_LEN boundary), the way a plain `.slice(0, MAX_CATEGORY_LEN)`
    // would. Postgres's jsonb parser rejects an unpaired surrogate outright
    // (either kind, from either cause above), failing the whole
    // upsert_feed_items batch the same way an unstripped NUL does.
    const v = Array.from(wellFormed).slice(0, MAX_CATEGORY_LEN).join('');
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}

/** RSS 2.0 `<category>` / RSS 1.0 (RDF) `<category>` or `<dc:subject>`: zero,
 * one, or many elements per source, each a bare string or `{#text, @_domain}`.
 * Multiple sources (RDF's `<category>` extension alongside its standard
 * Dublin Core `<dc:subject>`) merge into one deduped list — normalizeCategories
 * already dedupes by exact text, so an item using both for the same value
 * doesn't double up. */
function xmlCategories(...nodes: unknown[]): string[] {
  const arr = nodes.flatMap((node) =>
    node == null ? [] : Array.isArray(node) ? node : [node],
  );
  return normalizeCategories(arr.map((c) => decodeText(text(c))));
}

/** Atom `<category term="…" label="…">` — the value lives in attributes, not
 * element text. Prefer the human-readable `label` over the machine `term`. */
function atomCategories(node: unknown): string[] {
  if (node == null) return [];
  const arr = Array.isArray(node) ? node : [node];
  return normalizeCategories(
    arr.map((c) => {
      if (typeof c === 'string') return decodeText(c);
      const obj = c as Record<string, unknown>;
      return decodeText(firstOf(text(obj['@_label']), text(obj['@_term'])));
    }),
  );
}

/** JSON Feed `tags`: an array of plain strings. */
function jsonTags(node: unknown): string[] {
  if (!Array.isArray(node)) return [];
  return normalizeCategories(node.map((t) => (typeof t === 'string' ? t : null)));
}

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
export function cleanFaviconUrl(href: string | null): string | null {
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
 * derived `/favicon.ico`. Reports which of the two it used via `advertised` so
 * the poller can skip homepage icon discovery when the feed already names one. */
function resolveFavicon(
  explicit: string | null,
  siteUrl: string | null,
  feedUrl: string,
): { url: string | null; advertised: boolean } {
  const advertised = cleanFaviconUrl(absolutizeUrl(explicit, siteUrl ?? feedUrl));
  if (advertised) return { url: advertised, advertised: true };
  return { url: deriveFavicon(siteUrl, feedUrl), advertised: false };
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
  const s = parts.filter((p) => p != null).join('\u0000');
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
      { cause: err },
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
  const { url: faviconUrl, advertised: faviconAdvertised } = resolveFavicon(
    text(channelImage.url),
    siteUrl,
    feedUrl,
  );
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
      categories: xmlCategories(it.category),
      feedUrl,
    });
  });

  return { feedTitle: decodeText(text(channel.title)), siteUrl, faviconUrl, faviconAdvertised, items };
}

// ---------------------------------------------------------------------------
// RSS 1.0 / RDF
// ---------------------------------------------------------------------------

function parseRdf(rdf: Record<string, unknown>, feedUrl: string): ParsedFeed {
  const channel = (rdf.channel as Record<string, unknown>) ?? {};
  const siteUrl = absolutizeUrl(text(channel.link), feedUrl);
  // RDF <image> is a sibling of <channel> under the RDF root, with a <url>.
  const rdfImage = (rdf.image as Record<string, unknown>) ?? {};
  const { url: faviconUrl, advertised: faviconAdvertised } = resolveFavicon(
    text(rdfImage.url),
    siteUrl,
    feedUrl,
  );
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
      // RSS 1.0/RDF has no native <category> — the standards-compliant form is
      // the Dublin Core <dc:subject> module, which most real RDF feeds use;
      // some also carry a nonstandard <category> extension. Collect both.
      categories: xmlCategories(it.category, it['dc:subject']),
      feedUrl,
    });
  });

  return { feedTitle: decodeText(text(channel.title)), siteUrl, faviconUrl, faviconAdvertised, items };
}

// ---------------------------------------------------------------------------
// Atom 1.0
// ---------------------------------------------------------------------------

function parseAtom(feed: Record<string, unknown>, feedUrl: string): ParsedFeed {
  const siteUrl = pickAtomLink(feed.link, feedUrl, ['alternate', '']);
  // Atom <icon> is a square site icon (ideal favicon); <logo> a wider banner.
  const { url: faviconUrl, advertised: faviconAdvertised } = resolveFavicon(
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
    // The body falls back to <summary> when <content> is absent; compare the
    // summary against that EFFECTIVE body, not the raw <content>, so a
    // summary-only entry doesn't store the same text as both body and summary
    // (rendered twice). Mirrors the RSS 2.0 description/encoded suppression.
    const bodyHtml = firstOf(contentHtml, summary);
    return finalizeItem({
      guidRaw: firstOf(text(e.id), url),
      url,
      // Atom Threading Extensions (RFC 4685): the discussion is <link
      // rel="replies">. Strict match — never the alternate/article link.
      commentsUrl: atomRepliesUrl(e.link, feedUrl),
      title: atomText(e.title),
      author: atomAuthor(e.author),
      publishedAt: toIso(firstOf(text(e.published), text(e.updated))),
      contentHtml: bodyHtml,
      summary: summary === bodyHtml ? null : summary,
      enclosures: collectAtomEnclosures(e.link, feedUrl),
      categories: atomCategories(e.category),
      feedUrl,
    });
  });

  return { feedTitle: decodeText(atomText(feed.title)), siteUrl, faviconUrl, faviconAdvertised, items };
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

/**
 * Atom `rel` values that are definitively NOT the human-facing document this
 * feed/entry stands for, so {@link pickAtomLink}'s last resort must skip them.
 * Picking one produced visibly wrong data: a feed advertising only
 * `rel="hub"` (WebSub — very common) + `rel="self"` took the hub as its site,
 * so the feed row showed `pubsubhubbub.appspot.com`'s favicon and "open
 * website" opened the hub; and a podcast entry whose only link is
 * `rel="enclosure"` took the MP3 as its article URL.
 */
const NON_DOCUMENT_ATOM_RELS: ReadonlySet<string> = new Set([
  'self',
  'hub',
  'enclosure',
  'replies',
  'edit',
  'edit-media',
  'license',
  'search',
  'payment',
  'related',
  'via',
  'first',
  'last',
  'next',
  'previous',
  'prev',
]);

/** MIME types that mark a link as pointing at a FEED rather than a page — the
 * other shape a self link takes (`<link type="application/atom+xml">` with the
 * `rel` omitted). */
function isFeedLinkType(type: string | null): boolean {
  if (!type) return false;
  const t = type.toLowerCase();
  return (
    t.startsWith('application/rss+xml') ||
    t.startsWith('application/atom+xml') ||
    t.startsWith('application/rdf+xml') ||
    t.startsWith('application/feed+json')
  );
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
  // Last resort: the first link that could plausibly BE the document — never a
  // hub/self/enclosure/paging link (see NON_DOCUMENT_ATOM_RELS). Returning null
  // when there is none is the honest answer: the feed keeps the origin-derived
  // favicon, and an entry with no article link simply has none.
  const any = links.find(
    (l) =>
      l.href &&
      !NON_DOCUMENT_ATOM_RELS.has((l.rel ?? '').toLowerCase()) &&
      !isFeedLinkType(l.type),
  );
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
  const { url: faviconUrl, advertised: faviconAdvertised } = resolveFavicon(
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
      categories: jsonTags(it.tags),
      feedUrl,
    });
  });

  return { feedTitle: decodeText(asStr(feed.title)), siteUrl, faviconUrl, faviconAdvertised, items };
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
  categories: string[];
  feedUrl: string;
}

/** Apply the GUID fallback chain (explicit guid → url → content hash) and the
 * content hash, then assemble the normalized item. */
function finalizeItem(input: FinalizeInput): NormalizedItem {
  // Canonicalize before it's used as the stored url, the guid fallback, or the
  // content hash, so a re-issue that differs only in a tracking param /
  // fragment collapses onto the same identity instead of duplicating.
  const url = canonicalizeItemUrl(input.url);
  const hash = contentHash(
    input.title,
    url,
    input.contentHtml,
    input.publishedAt,
  );
  const guid = firstOf(input.guidRaw, url) ?? `${input.feedUrl}#${hash}`;
  return {
    guid,
    url,
    commentsUrl: input.commentsUrl ?? null,
    // Titles and bylines are rendered as plain text in the UI, so decode any
    // entities the XML parser left behind (numeric / named / double-encoded).
    title: decodeText(input.title),
    author: decodeText(input.author),
    publishedAt: input.publishedAt,
    contentHtml: input.contentHtml,
    summary: input.summary,
    enclosures: input.enclosures,
    categories: input.categories,
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
      throw new Error(`non-feed response (${contentType})`, { cause: err });
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
