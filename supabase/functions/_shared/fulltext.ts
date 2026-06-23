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
 * @returns The extracted article, or `null` when nothing article-like was
 *          found or the body was too thin to be useful.
 */
export function extractArticle(
  html: string,
  url: string,
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

  const textLength = (parsed.textContent ?? '').trim().length;
  if (textLength < MIN_ARTICLE_TEXT) return null;

  return {
    title: (parsed.title ?? '').trim(),
    contentHtml: parsed.content,
    textLength,
  };
}
