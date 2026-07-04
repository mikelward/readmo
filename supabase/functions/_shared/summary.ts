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

/** Prompt for the article summary: a tl;dr ask with a single targeted
 * anti-preamble instruction, the title (when known) passed along as context,
 * and the article text between explicit delimiters.
 *
 * Otherwise deliberately unsteered — length/format/register instructions made
 * the output longer and stiffer in practice, while the bare ask yields short,
 * direct prose. The lone steer is the "respond with only the summary" line:
 * because the ask is a "tl;dr", the model kept echoing that framing back as a
 * preamble ("tl;dr:", "Here's a tl;dr of the article:", "The article covers…"),
 * so we tell it not to. It's a negative instruction a flash-lite model may
 * still ignore, so {@link stripSummaryPreamble} stays as a deterministic
 * backstop on the output. If bullet output ever shows up (the inline
 * MarkdownText renderer has no list support), add back a minimal plain-prose
 * clause. */
export function buildSummaryPrompt(
  title: string | null | undefined,
  content: string,
): string {
  const titleLine = title ? `The article is titled "${title}".\n\n` : '';
  return (
    `Provide a tl;dr of the following article:\n\n` +
    `Respond with only the summary itself: no preamble or meta-commentary, ` +
    `no "tl;dr" label, and no "The article covers…" style lead-in.\n\n` +
    titleLine +
    `--- BEGIN ARTICLE ---\n${content}\n--- END ARTICLE ---`
  );
}

/** Strip a leading meta-framing preamble the model sometimes prepends to the
 * gist. Because the prompt asks for a "tl;dr" (and stays deliberately unsteered —
 * see {@link buildSummaryPrompt}), the model occasionally echoes that framing
 * back as a label ("tl;dr:", "**TL;DR:**") or a lead-in sentence ("Here's a
 * tl;dr of the article:", "Summary:") before the actual summary. That preamble
 * is noise in the reader's summary card, so we peel it off here.
 *
 * Conservative by design — it removes only a recognized lead-in, and only from
 * the very start, so a summary whose real prose merely mentions "tl;dr" mid-text
 * is untouched. Runs in a small loop so stacked preambles ("Here's a tl;dr:
 * **TL;DR:** …") are all removed. Tolerates surrounding markdown emphasis/heading
 * markers (`*`, `_`, `#`) since the model may bold or head the label. */
export function stripSummaryPreamble(text: string): string {
  // Trailing mop-up after a matched label: whitespace, separators, and the
  // label's OWN closing emphasis/heading markers. An emphasis run is only
  // consumed when it's a closing/dangling run (followed by whitespace, a
  // separator, or end of text) — never when it opens the first summary token,
  // so "TL;DR: **OpenAI** …" keeps its bold and doesn't become "OpenAI** …".
  const trail = String.raw`(?:[ \t\n:\-–—]|[*_#]+(?=[\s:\-–—]|$))*`;
  const patterns = [
    // A lead-in sentence: "Here's/Here is a tl;dr/summary of the article:",
    // optionally opened with "Sure,". The summary word must be the OFFERED
    // object — immediately before the colon, or before an "of …" phrase — so a
    // legit summary where it's just an adjective ("This is a summary judgment
    // case: …", "Here are the summary statistics: …") keeps its subject.
    new RegExp(
      String.raw`^[#*_\s]*(?:sure[,!.]*\s*)?(?:here(?:['’])?s|here\s+is|here\s+are|below\s+is|this\s+is)\b[^:\n]*?\b(?:tl[;:]?dr|summary|gist|rundown|synopsis)(?:\s+of\b[^:\n]*)?\s*:` +
        trail,
      'i',
    ),
    // A "tl;dr" LABEL: the token only counts as a prefix when it's clearly a
    // label — followed by a separator ("tl;dr:", "TL;DR —"), closing markdown
    // emphasis ("**tl;dr**"), or a line break / end of text. A bare token
    // followed by an ordinary word is left alone, so a summary that genuinely
    // opens with "TLDR" as a proper noun (e.g. the TLDR newsletter / tldr-pages)
    // keeps its first word.
    new RegExp(
      String.raw`^[#*_\s]*tl[;:]?dr\b(?:[*_]+|[ \t]*[:\-–—]|[ \t]*(?=\n)|[ \t]*$)` + trail,
      'i',
    ),
    // Word labels ("Summary", "Gist", "Synopsis") are only a prefix when a real
    // delimiter or a line break follows — "Summary:" / "**Summary**" / a "##
    // Summary" heading — NOT when an ordinary word does ("Summary judgment …").
    new RegExp(
      String.raw`^[#*_\s]*(?:summary|gist|synopsis)\b[*_]*(?:\s*[:\-–—]\s*|\s*\n\s*)` + trail,
      'i',
    ),
  ];
  let out = text.trim();
  for (let guard = 0; guard < 4; guard++) {
    const before = out;
    for (const re of patterns) {
      const next = out.replace(re, '');
      if (next !== out) {
        out = next.trim();
        break;
      }
    }
    if (out === before) break;
  }
  return out;
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
