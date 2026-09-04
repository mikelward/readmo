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

import { coalesceGeneration } from './coalesce.ts';
import type { GenerationLeaseClient } from './coalesce.ts';

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

/** Prompt for the article summary: a one-or-two-sentence prose gist stating
 * only the article's main point, the title (when known) passed along as
 * context, and the article text between explicit delimiters.
 *
 * SHAPE: ported from newshacker's article prompt (`api/summary.ts`), which asks
 * for a single sentence written as a direct assertion in the author's voice.
 * This replaces an unsteered "tl;dr" ask that let the model format the gist as
 * a Markdown bullet list — in practice up to five bullets working through the
 * article point by point. Two reasons that shape was wrong for a summary card:
 * a gist comprehensive enough to stand in for the article is a poorer teaser
 * AND a worse position to be in on a publisher's copyright, and the card is a
 * glance surface where a paragraph reads faster than a list. So the ask is now
 * explicitly SELECTIVE — the single most important takeaway, supporting detail
 * left out — rather than a shorter version of "cover everything".
 *
 * The earlier "length/register steers made the output longer and stiffer"
 * finding is not contradicted: what failed there was tightening a *tl;dr* ask
 * that still invited full coverage. Naming the target shape outright (one or
 * two sentences, one point) is a different instruction, and it is the one
 * newshacker has run on since the beginning.
 *
 * The steers, in order:
 *   - the length + no-bullets line, which is the change above;
 *   - the "only the most important point" line, which is what keeps a
 *     two-sentence summary from becoming a compressed table of contents;
 *   - the author's-voice / no-meta-framing lines, ported verbatim in substance
 *     from newshacker. They double as the anti-preamble instruction the old
 *     prompt spent a paragraph on: without the "tl;dr" ask there is no tl;dr
 *     framing to echo back. {@link stripSummaryPreamble} stays a deterministic
 *     backstop anyway — a flash-lite model may still ignore a negative
 *     instruction, and rows cached under the old prompt still flow through it.
 *
 * No Markdown-format line: prose needs none, and `MarkdownText` renders plain
 * text unchanged. The renderer keeps its bullet/emphasis support regardless —
 * every summary cached under the old prompt is still a bullet list. */
export function buildSummaryPrompt(
  title: string | null | undefined,
  content: string,
): string {
  const titleLine = title ? `The article is titled "${title}".\n\n` : '';
  return (
    `Summarize the article below in one or two short sentences, without bullet ` +
    `points, lists, headings, or introductory text.\n\n` +
    `State only the most important point — the single takeaway a reader would ` +
    `want to know. Do not try to cover everything the article says: leave out ` +
    `supporting detail, examples, and secondary points.\n\n` +
    `Write it as a direct assertion of that point, in the voice of the author — ` +
    `as if the author (or someone speaking on their behalf) is stating the ` +
    `claim itself. Do not refer to "the article", "the author", "the piece", ` +
    `"the post", "this story", or similar. Do not begin with meta-framing such ` +
    `as "The article argues", "The author claims", "This piece explains", ` +
    `"The post describes", or any variant. Just state the point.\n\n` +
    titleLine +
    `--- BEGIN ARTICLE ---\n${content}\n--- END ARTICLE ---`
  );
}

/** Strip a leading meta-framing preamble the model sometimes prepends to the
 * gist — a label ("tl;dr:", "**TL;DR:**", "Summary:") or a lead-in sentence
 * ("Here's a tl;dr of the article:"). That preamble is noise in the reader's
 * summary card, so we peel it off here.
 *
 * The prompt no longer asks for a "tl;dr" (see {@link buildSummaryPrompt}), so
 * the model has far less to echo back — but this stays for two reasons: it is
 * the deterministic backstop for a flash-lite model ignoring the prompt's
 * negative instructions, and it also runs on the CACHE-HIT path, where every
 * row generated under the old tl;dr prompt still arrives with that framing.
 *
 * Conservative by design — it removes only a recognized lead-in, and only from
 * the very start, so a summary whose real prose merely mentions "tl;dr" mid-text
 * is untouched. Runs in a small loop so stacked preambles ("Here's a tl;dr:
 * **TL;DR:** …") are all removed. Tolerates surrounding markdown emphasis/heading
 * markers (`*`, `_`, `#`) since the model may bold or head the label.
 *
 * BULLET-LIST SAFETY: rows cached under the old prompt are Markdown bullet
 * lists (and a model can still reach for one), so a label can sit directly above a list
 * ("Summary:\n- First\n- Second"). The character-level {@link stripHeadPreamble}
 * mop-up below is line-agnostic and would treat that first "- " as a trailing
 * separator and swallow the bullet marker — corrupting the list so its first
 * point renders as prose. Rather than teach every regex about line starts, we
 * respect block structure at the one boundary that matters: peel the trailing
 * bullet-list block off first (using the SAME bullet definition
 * `MarkdownText` renders with), strip the preamble from the head alone, then
 * rejoin. The head keeps its careful emphasis-preservation logic untouched. */
export function stripSummaryPreamble(text: string): string {
  const bulletOffset = firstBulletLineOffset(text);
  if (bulletOffset < 0) return stripHeadPreamble(text);
  const head = stripHeadPreamble(text.slice(0, bulletOffset));
  const list = text.slice(bulletOffset);
  // A stripped-to-nothing head means the whole preamble was the label; return
  // just the list. Otherwise re-join head and list with a single newline (block
  // separation is all the renderer needs — it splits on lines, not blank runs).
  return head ? `${head}\n${list}` : list;
}

/** Byte offset of the first Markdown bullet line ("- x" / "* x" / "+ x"), or -1
 * if the text has none. Kept in sync with `MarkdownText`'s BULLET_RE so we peel
 * exactly the block the renderer will treat as a list. */
function firstBulletLineOffset(text: string): number {
  const bulletLine = /^[ \t]*[-*+][ \t]+/;
  let offset = 0;
  for (const line of text.split('\n')) {
    if (bulletLine.test(line)) return offset;
    offset += line.length + 1; // +1 for the consumed '\n'
  }
  return -1;
}

function stripHeadPreamble(text: string): string {
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

// ---------------------------------------------------------------------------
// Access-block detection — naming an unreadable page instead of summarizing it.
//
// The summary path fetches the article (via Jina, or the stored body as a
// fallback) and hands it to Gemini. When that "article" is really an
// access-block page — a 403 wall, a login gate, a bot-block notice — summarizing
// it wastes a Gemini call and yields a verbose "there's no article content to
// summarize" meta-paragraph in the reader's summary card. Instead we detect the
// block up front (no Gemini call) and the reader shows a short "Summary blocked
// by {site}" line. Two signals detect it: the fetch's HTTP status when it's a
// stable non-2xx access code, and a scan of the page title/body (r.jina.ai
// commonly returns the block HTML as 200 markdown, so the status alone won't
// reveal it). The exact cause doesn't change the copy, so both are just booleans.

/** Whether a non-2xx fetch status is a stable ACCESS denial — the page can't be
 * read and won't change on a retry, so it's worth showing a terminal "blocked"
 * card. A transient 429/5xx is deliberately excluded: it stays on the existing
 * retryable path rather than caching a permanent block. */
export function isBlockingHttpStatus(status: number): boolean {
  switch (status) {
    case 401: // Unauthorized
    case 403: // Forbidden
    case 404: // Not Found
    case 410: // Gone
    case 451: // Unavailable For Legal Reasons
      return true;
    default:
      return false;
  }
}

/** A body at or below this length is short enough to plausibly BE a block page
 * rather than merely mention the words in passing, so the weaker phrase matches
 * below are gated on it — a long article that quotes "access denied" isn't
 * misread as a block. The unambiguous whole-page signatures ignore the gate. */
export const BLOCK_BODY_MAX_CHARS = 2000;

/** Whole-title error markers: an error page's title IS the error, so a title
 * that is essentially just the code/phrase is a block on its own. Matched
 * against the item title, trimmed, whole-string. */
const TITLE_BLOCK_PATTERNS: readonly RegExp[] = [
  /^(?:error\s*)?403(?:\s*[-:–—]?\s*forbidden)?$/i,
  /^forbidden$/i,
  /^access denied$/i,
  /^permission denied$/i,
  /^(?:401\s*[-:–—]?\s*)?unauthorized$/i,
  /^(?:error\s*)?(?:404\s*[-:–—]?\s*)?(?:page\s+)?not found$/i,
];

/** Unambiguous whole-page block signatures — phrases a real article body would
 * never carry verbatim — so they match regardless of body length. */
const STRONG_BLOCK_SIGNATURES: readonly RegExp[] = [
  /you (?:don'?t|do not) have permission to access/i,
  /access to this (?:page|resource|document|website) has been denied/i,
  /attention required!\s*\|\s*cloudflare/i,
  /(?:sorry,?\s*)?you have been blocked/i,
  /checking your browser before accessing/i,
];

/** Weaker phrases that also occur in normal prose — only a block when the body
 * is short enough (see {@link BLOCK_BODY_MAX_CHARS}) to be the page itself. */
const WEAK_BLOCK_PHRASES: readonly RegExp[] = [
  /\b403\s+forbidden\b/i,
  /\b(?:http\s+)?error\s+403\b/i,
  /\baccess denied\b/i,
  /\bpermission denied\b/i,
  /\b401\s+unauthorized\b/i,
  /\b404\s+not found\b/i,
];

/** Whether a fetched page's title/body looks like a block page even though the
 * fetch returned 200 (r.jina.ai serves the block HTML as markdown). Conservative:
 * a whole-title error marker or an unambiguous whole-page signature matches on
 * its own; a weaker phrase counts only in a short body. False when nothing strong
 * matches — the caller then summarizes normally. */
export function looksLikeBlockPage(
  title: string | null | undefined,
  body: string | null | undefined,
): boolean {
  const t = (title ?? '').trim();
  if (TITLE_BLOCK_PATTERNS.some((re) => re.test(t))) return true;
  const b = (body ?? '').trim();
  if (!b) return false;
  if (STRONG_BLOCK_SIGNATURES.some((re) => re.test(b))) return true;
  if (b.length <= BLOCK_BODY_MAX_CHARS && WEAK_BLOCK_PHRASES.some((re) => re.test(b))) {
    return true;
  }
  return false;
}

/** The host shown in the "Summary blocked by {site}" line — the URL's hostname
 * with a leading "www." dropped ("reddit.com", "ft.com"). Null when there's no
 * URL or it won't parse (the client then shows the bare "Summary blocked"). */
export function siteLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
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

// ---------------------------------------------------------------------------
// Concurrent-request coalescing (single-flight lease).
//
// A cache miss is expensive: a Jina fetch + a Gemini call (up to ~35 s combined).
// The cache read at the top of the handler only dedupes SEQUENTIAL callers — the
// first commits `items.ai_summary`, later callers short-circuit on it. But two
// misses for the SAME article that overlap (device pre-warm racing a pin on
// another device, the same article open on phone + desktop, two family users
// pinning the same shared item) both read a null summary and each run the full
// Jina + Gemini work: N concurrent misses → N Gemini calls.
//
// To collapse them to ONE call we lease the generation. The lease can't be a
// Postgres advisory lock: those are session/transaction scoped, and Supabase's
// pooled PostgREST connections mean the lock would release the moment the claim
// statement commits — long before the Deno-side Jina/Gemini awaits finish. So
// the lease is a durable row marker instead: `ai_summary_generated_at` set while
// `ai_summary` is still null MEANS "a generation is in flight". The claim is a
// single atomic conditional UPDATE (see the real client in summary/index.ts):
// set the lease iff the summary is still null AND no fresh lease exists. Exactly
// one concurrent caller's UPDATE matches a row; it becomes the generator, the
// rest wait and read its result the instant it lands — so the second caller
// typically gets a FASTER response than generating itself (it only waits out the
// generator's remaining time, not a whole fresh Jina + Gemini pass).
//
// The lease has a TTL so a generator that dies (crash, Edge timeout) can't wedge
// waiters forever — after {@link SUMMARY_LEASE_TTL_MS} the marker is treated as
// stale and reclaimable. Waiters poll until the summary lands, the lease is
// released/goes stale (generator failed → reclaim), or an overall deadline is
// hit (then they self-generate without a lease, so the user still gets a summary).
//
// Repurposing `ai_summary_generated_at` (vs. a new column) needs no migration:
// the column already exists (0035), is already scrubbed from list reads and
// already nulled by the poller on content change, so the lease neither leaks nor
// outlives an edit. A generator that fails RELEASES the lease (resets it to null),
// so after a failure the row is back to today's "both null" state — no stale
// timestamp lingers.

/** How long a generation lease stays valid before a waiter treats it as stale
 * and reclaims it. Must exceed the worst-case generation time (Jina ≤15 s +
 * Gemini ≤20 s ≈ 35 s) so a slow-but-alive generator isn't preempted. */
export const SUMMARY_LEASE_TTL_MS = 60_000;

/** How often a waiter re-reads the item while the generator works. */
export const SUMMARY_POLL_INTERVAL_MS = 750;

/** Overall cap a waiter blocks before giving up and generating itself. Kept
 * comfortably above the lease TTL so the normal path is "wait, then read the
 * generator's result"; the self-generate fallback is only for a wedged holder. */
export const SUMMARY_MAX_WAIT_MS = 45_000;

/** The summary function's normalized outcome (mirrors the JSON envelope, plus an
 * internal `cached` flag the coalescer uses to decide whether to release the
 * lease). `cached: true` means a summary was actually persisted to
 * `items.ai_summary` — so waiters can see it and the lease must NOT be released. */
export interface SummaryOutcome {
  status: 'ok' | 'empty' | 'unavailable' | 'unreachable' | 'blocked';
  summary: string | null;
  retryable?: boolean;
  /** Set on the generator path: true iff the summary was written to the shared
   * item. Absent/false on every non-`ok` outcome and on an `ok` whose cache
   * write failed (so the lease is released and a waiter regenerates). */
  cached?: boolean;
  /** For `blocked`: the publisher host, rendered client-side as "Summary
   * blocked by {site}" ("Summary blocked by reddit.com"). Null when the item has
   * no parseable URL — the client then shows the bare "Summary blocked". Absent
   * on every other status. */
  site?: string | null;
}

/**
 * Whether a summary generation outcome is TRANSIENT — a passing blip that a
 * retry shortly could still turn into a persisted summary. This is the single
 * authoritative rule the pin-triggered retry consumes; it reads the whole
 * outcome (which the summary leg has in-process, losslessly) rather than
 * reconstructing intent from a flattened proxy. Transient when:
 *   - a generation failure (`unreachable`);
 *   - a **retryable `empty`** — a Jina blip or a stub-defer that could succeed
 *     once Jina recovers or the concurrent full-text leg lands the body; or
 *   - an **uncached `ok`** (`{ status: 'ok', cached: false }`) — generated but
 *     the shared-row write blipped, so `ai_summary` is still null and the
 *     fire-and-forget pin path (which discards the text) must retry to persist.
 * NOT transient: a cached `ok` (done), a non-retryable `empty` (no URL), and
 * `unavailable` (key unset) — retrying can't help or isn't needed.
 */
export function isSummaryOutcomeTransient(outcome: {
  status: string;
  retryable?: boolean;
  cached?: boolean;
}): boolean {
  if (outcome.status === 'ok') return outcome.cached === false;
  if (outcome.status === 'empty') return outcome.retryable === true;
  return outcome.status === 'unreachable';
}

/** The DB operations the coalescer needs, injected so it's unit-testable without
 * Deno/Supabase. The real implementation lives in summary/index.ts. */
export interface SummaryLeaseClient {
  /** Atomically claim the generation lease for `itemId`, stamping it `nowIso`.
   * Wins iff `ai_summary` is still null AND the existing lease is null or older
   * than `staleBeforeIso`. Returns true iff THIS caller won. */
  claimLease(itemId: string, staleBeforeIso: string, nowIso: string): Promise<boolean>;
  /** Read the current cached summary and lease stamp for `itemId`. */
  readState(itemId: string): Promise<{ aiSummary: string | null; leaseAt: string | null }>;
  /** Release a lease we hold after a FAILED generation (no summary persisted),
   * so a waiter/retry proceeds immediately instead of waiting out the TTL.
   * Guarded on our own `claimStamp` so it never clobbers a summary or a lease
   * someone else re-claimed. */
  releaseLease(itemId: string, claimStamp: string): Promise<void>;
}

export interface CoalesceDeps {
  client: SummaryLeaseClient;
  itemId: string;
  /** Runs the real Jina + Gemini work + cache write. Invoked ONLY when this
   * caller holds the lease (or as the last-resort fallback). */
  generate: () => Promise<SummaryOutcome>;
  /** Current epoch ms. Injected so tests drive a virtual clock. */
  now: () => number;
  /** Sleep `ms`. Injected so tests advance the clock deterministically. */
  sleep: (ms: number) => Promise<void>;
  leaseTtlMs?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

/**
 * Single-flight a summary generation across concurrent callers for one item.
 *
 * A thin summary-shaped adapter over the shared {@link coalesceGeneration} lease
 * (the same mechanism the `fulltext` function uses): the elected generator runs
 * {@link CoalesceDeps.generate}; every other concurrent caller waits and returns
 * the generator's cached `ai_summary` the moment it lands. The summary's cached
 * artifact is the summary string, surfaced as an `ok` {@link SummaryOutcome}.
 */
export async function coalesceSummaryGeneration(deps: CoalesceDeps): Promise<SummaryOutcome> {
  const client: GenerationLeaseClient<SummaryOutcome> = {
    claimLease: (itemId, staleBeforeIso, nowIso) =>
      deps.client.claimLease(itemId, staleBeforeIso, nowIso),
    async readState(itemId) {
      const { aiSummary, leaseAt } = await deps.client.readState(itemId);
      return {
        result: aiSummary ? { status: 'ok', summary: aiSummary, cached: true } : null,
        leaseAt,
      };
    },
    releaseLease: (itemId, claimStamp) => deps.client.releaseLease(itemId, claimStamp),
  };
  const { result } = await coalesceGeneration<SummaryOutcome>({
    client,
    itemId: deps.itemId,
    generate: async () => {
      const outcome = await deps.generate();
      return { result: outcome, cached: outcome.cached ?? false };
    },
    now: deps.now,
    sleep: deps.sleep,
    leaseTtlMs: deps.leaseTtlMs ?? SUMMARY_LEASE_TTL_MS,
    pollIntervalMs: deps.pollIntervalMs ?? SUMMARY_POLL_INTERVAL_MS,
    maxWaitMs: deps.maxWaitMs ?? SUMMARY_MAX_WAIT_MS,
  });
  return result;
}
