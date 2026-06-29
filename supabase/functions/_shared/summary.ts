// Readmo AI article summaries — pure logic.
//
// When an allowlisted user pins an article, the reader asks the `summary` Edge
// Function for a short AI gist of it (mirrors newshacker's article
// summary). Unlike newshacker — which fetches the article through Jina before
// summarizing — readmo already stores the SANITIZED article body on the shared
// `items` row (the feed body in `content_html`, and the reading-mode extraction
// in `full_content_html`). So the summary is generated from content we already
// hold: no new publisher fetch, no Jina dependency, no SSRF surface — the only
// outbound call is the Gemini API itself.
//
// This module is the testable, dependency-free half (prompt building, HTML→text,
// content selection, response parsing). It must stay free of Deno globals so the
// same code runs under vitest (node) for unit tests; the `Deno.env` / network
// bits live in summary/index.ts.

/** Cap the article text we hand to the model. A short summary doesn't
 * need the whole body, and a giant input just burns tokens. Matches the order
 * of magnitude newshacker clamps to. */
export const MAX_SUMMARY_CONTENT_CHARS = 100_000;

/** Strip the constrained HTML readmo stores down to plain text for the model.
 * Block tags become paragraph breaks, the rest is dropped, and the handful of
 * named/numeric entities that survive sanitization are decoded. Mirrors the
 * helper newshacker uses on self-post bodies. */
export function htmlToPlainText(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote|tr)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The stored bodies a summary can be generated from. Prefer the reading-mode
 * extraction (the full article) when present, else the feed body. */
export interface SummarySource {
  contentHtml: string | null | undefined;
  fullContentHtml: string | null | undefined;
}

/** Clamp+trim a body to {@link MAX_SUMMARY_CONTENT_CHARS} (a short
 * summary doesn't need the whole article, and a giant input just burns tokens),
 * returning null when nothing's left. Used for the Jina markdown that the
 * summary path feeds to Gemini — markdown is already clean, so no tag stripping. */
export function clampSummaryText(text: string | null | undefined): string | null {
  if (!text) return null;
  const clamped =
    text.length > MAX_SUMMARY_CONTENT_CHARS
      ? text.slice(0, MAX_SUMMARY_CONTENT_CHARS)
      : text;
  const trimmed = clamped.trim();
  return trimmed || null;
}

/** Visible-text length of an HTML body (tags + entities stripped). Mirrors the
 * client's `htmlTextLength` (src/lib/fullText.ts). */
export function htmlTextLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

/** Below this many characters of visible text, a feed body is assumed to be a
 * truncated stub (a teaser), not the full article — matching the client's
 * `TRUNCATION_TEXT_THRESHOLD`. */
export const SUMMARY_TRUNCATION_TEXT_THRESHOLD = 600;

/** Whether a feed `content_html` looks like a truncated stub rather than the
 * full article. A summary of a stub must not be cached (a later Jina/full-text
 * recovery would be masked by the `ai_summary` cache hit). */
export function looksTruncatedHtml(html: string | null | undefined): boolean {
  return htmlTextLength(html ?? '') < SUMMARY_TRUNCATION_TEXT_THRESHOLD;
}

export interface StoredPick {
  /** Plain text to summarize, clamped to {@link MAX_SUMMARY_CONTENT_CHARS}. */
  text: string;
  /** Whether a summary built from this content is safe to CACHE on the shared
   * item. `full_content_html` (the extracted article) → yes; `content_html` →
   * only when it's the full article, not a truncated stub. A non-cacheable
   * summary is still shown once but flagged retryable so a later pin re-tries
   * Jina / picks up a freshly-extracted full body. */
  cacheable: boolean;
}

/** STORED-CONTENT FALLBACK for when Jina is unconfigured / the URL is screened
 * out / the fetch fails — the happy path summarizes Jina markdown (see
 * summary/index.ts). Prefers the full extracted article over the feed body, and
 * reports whether the result is safe to cache (see {@link StoredPick}). */
export function pickStoredContent(src: SummarySource): StoredPick | null {
  const full = clampSummaryText(htmlToPlainText(src.fullContentHtml));
  if (full) return { text: full, cacheable: true };
  const feed = clampSummaryText(htmlToPlainText(src.contentHtml));
  if (feed) return { text: feed, cacheable: !looksTruncatedHtml(src.contentHtml) };
  return null;
}

/** Prompt for a short-paragraph summary — a few sentences capturing the
 * article's main points, not a single line. We keep the "no meta-framing"
 * steer (no "This article argues…") so it reads as a direct summary, but
 * otherwise let Gemini choose the natural length of a concise paragraph. */
export function buildSummaryPrompt(
  title: string | null | undefined,
  content: string,
): string {
  const titleLine = title ? `The article is titled "${title}". ` : '';
  return (
    `Summarize the article below in a few sentences — a short paragraph that captures its main points. ` +
    titleLine +
    `Write it as a direct, neutral summary of what the article says. ` +
    `Format the response as Markdown — you may use **bold**, *italic*, or \`code\` for light emphasis — ` +
    `but keep it as a flowing short paragraph, with no headings or bullet lists. ` +
    `Do not begin with meta-framing such as "The article argues", "The author claims", "This piece explains", ` +
    `or any variant — just state the content. ` +
    `Ignore navigation, boilerplate, and markup; focus on the main body.\n\n` +
    `--- BEGIN ARTICLE ---\n${content}\n--- END ARTICLE ---`
  );
}

/** Minimal shape of the Gemini `generateContent` REST response we read. */
export interface GeminiResponseLike {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown }> };
  }> | null;
}

/** Pull the summary text out of a Gemini `generateContent` response, joining the
 * parts of the first candidate and trimming. Returns null when the response
 * carries no usable text (a safety block, an empty candidate, a malformed
 * envelope), so the handler can report a soft failure instead of caching "". */
export function parseGeminiText(json: GeminiResponseLike | null | undefined): string | null {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  return text || null;
}
