// Readmo full-text (reading-mode) extraction.
//
// Many feeds publish only a truncated stub as their item body. When the reader
// opens such an item, the `fulltext` Edge Function fetches the article's own
// page (through the SSRF-hardened safeFetch — guardrail #6) and runs it through
// this module to pull just the article body out of the surrounding nav/ads/
// chrome, then hands the result to sanitizeContent() before it is ever stored
// or served. We NEVER store or serve raw publisher HTML.
//
// Extraction is Mozilla's Readability run over a linkedom-parsed document.
// linkedom (not jsdom) is used so the same module runs under Deno at the edge
// AND under vitest (node) for unit tests — imported with BARE specifiers that
// Deno rewrites via supabase/functions/import_map.json.

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export interface ExtractedArticle {
  /** Article title Readability inferred (may be empty). */
  title: string;
  /** The extracted article HTML — NOT yet sanitized. The caller MUST run it
   * through sanitizeContent() before storing/serving. */
  contentHtml: string;
  /** Plain-text length of the extracted body, for the too-thin check below. */
  textLength: number;
}

/** Below this many characters of extracted text we treat the result as a
 * failed extraction (a cookie wall, a paywall teaser, or Readability picking
 * the wrong element) rather than a real article. */
export const MIN_ARTICLE_TEXT = 250;

/**
 * Extract the main article from a full HTML page.
 *
 * @param html  The raw HTML of the article page (from safeFetch).
 * @param url   The page's final URL (after redirects), used as the base for
 *              relative links — Readability records it and sanitizeContent()
 *              absolutizes against it downstream.
 * @param displayTitle  The feed item's title — what the reader renders above
 *              the body as its headline. Used to drop a leading heading in the
 *              extracted body that just repeats it. Optional; when omitted only
 *              Readability's own inferred title is matched against.
 * @returns The extracted article, or `null` when nothing article-like was
 *          found or the body was too thin to be useful.
 */
export function extractArticle(
  html: string,
  url: string,
  displayTitle?: string,
): ExtractedArticle | null {
  if (!html) return null;

  let document: Document;
  try {
    // Seed the document's base URL so Readability resolves relative hrefs/srcs
    // against the article, not about:blank.
    ({ document } = parseHTML(html, { location: new URL(url) }) as unknown as {
      document: Document;
    });
  } catch {
    return null;
  }

  let parsed: { title?: string; content?: string; textContent?: string } | null;
  try {
    parsed = new Readability(document).parse();
  } catch {
    return null;
  }
  if (!parsed || !parsed.content) return null;

  const title = (parsed.title ?? '').trim();

  // Tidy the extracted body before measuring length or returning:
  //  - Readability sometimes keeps site navigation — most visibly on hub/
  //    homepage URLs (e.g. the BBC homepage's "Home / News / Sport / Weather"
  //    bars), but also as in-article "related links" rails. Reading mode wants
  //    prose, not link menus.
  //  - It also often leaves the article's own headline as the first heading,
  //    which the reader already renders above the body as <h1 reader__title> —
  //    so the title shows up twice. Drop that leading duplicate.
  // A page that was mostly chrome now falls under MIN_ARTICLE_TEXT → empty.
  // Match the body heading against both the feed item's displayed title (what
  // the reader renders) and Readability's own inferred title — either can be
  // the one the leading heading duplicates.
  const contentHtml = cleanArticleHtml(parsed.content, [displayTitle, title]);
  const textLength = htmlTextLength(contentHtml);
  if (textLength < MIN_ARTICLE_TEXT) return null;

  return {
    title,
    contentHtml,
    textLength,
  };
}

/** A list is treated as navigation (not article content) when it holds at
 * least this many links and almost all of its text is link text. Kept high
 * enough that a genuine bulleted list with the odd inline link survives. */
const NAV_LIST_MIN_LINKS = 3;
const NAV_LIST_LINK_DENSITY = 0.75;
/** …and its links read like menu labels, not article titles. Nav labels are
 * short ("Home", "News", "Accessibility Help"); a link roundup/listicle's
 * entries are full headlines. Above this average link-text length we assume the
 * list IS the article content and leave it alone (favoring the news-site nav
 * case over rare link listicles — they degrade gracefully to "Open original"). */
const NAV_LIST_MAX_AVG_LINK_LEN = 40;

/**
 * Tidy extracted article HTML in a single re-parse, then re-serialize. Output
 * is still UNSANITIZED — the caller runs it through sanitizeContent()
 * downstream. Two passes:
 *
 *  1. Strip site-navigation chrome: every `<nav>` and `role="navigation"`
 *     element, plus any `<ul>`/`<ol>` that is really a link menu (≥
 *     {@link NAV_LIST_MIN_LINKS} links, ≥ {@link NAV_LIST_LINK_DENSITY} of its
 *     text inside those links, and short menu-label links — average link text
 *     ≤ {@link NAV_LIST_MAX_AVG_LINK_LEN}). Genuine prose/content lists and
 *     link roundups whose entries read like article titles are kept.
 *  2. Drop a leading heading that just repeats one of `titles` — the reader
 *     renders the headline above the body, so Readability keeping it as the
 *     body's first `<h1>`/`<h2>`… shows the title twice.
 */
function cleanArticleHtml(
  html: string,
  titles: (string | undefined)[],
): string {
  let doc: Document;
  try {
    ({ document: doc } = parseHTML(
      `<!doctype html><html><body>${html}</body></html>`,
    ) as unknown as { document: Document });
  } catch {
    return html;
  }

  for (const el of [...doc.querySelectorAll('nav, [role="navigation"]')]) {
    el.remove();
  }

  for (const list of [...doc.querySelectorAll('ul, ol')]) {
    const links = list.querySelectorAll('a');
    if (links.length < NAV_LIST_MIN_LINKS) continue;
    const text = (list.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let linkChars = 0;
    for (const a of links) {
      linkChars += (a.textContent ?? '').replace(/\s+/g, ' ').trim().length;
    }
    if (linkChars / text.length < NAV_LIST_LINK_DENSITY) continue;
    // Long average link text reads like article titles, not menu labels — keep
    // the list (it's probably the article's own content, e.g. a link roundup).
    if (linkChars / links.length > NAV_LIST_MAX_AVG_LINK_LEN) continue;
    list.remove();
  }

  // Remove the body's first heading when it duplicates the article title. Only
  // the first heading is considered, so genuine section headings (which never
  // match the title) survive.
  const wanted = new Set(
    titles.map((t) => normalizeHeading(t ?? '')).filter(Boolean),
  );
  if (wanted.size) {
    const heading = doc.querySelector('h1, h2, h3, h4, h5, h6');
    if (heading && wanted.has(normalizeHeading(heading.textContent ?? ''))) {
      heading.remove();
    }
  }

  return doc.body?.innerHTML ?? html;
}

/** Normalize heading/title text for duplicate comparison: lowercased, with
 * whitespace collapsed and surrounding punctuation/quotes trimmed. */
function normalizeHeading(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^[\s"'“”‘’.,:;!?-]+|[\s"'“”‘’.,:;!?-]+$/g, '');
}

/** Visible-text length of an HTML string (tags/entities/whitespace collapsed).
 * Used to re-measure the body after nav chrome is stripped. */
function htmlTextLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}
