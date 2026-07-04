// Readmo spoiler-free sports headlines — pure logic.
//
// A sports feed can spoil a result — OR an in-game moment (a goal, a red card, a
// crash, an injury) — in the headline itself ("Man Utd beat Arsenal 3-1"). At
// poll time, for feeds that have an allowlisted subscriber, we ask Gemini to
// CLASSIFY each new headline and, when it gives away a result or in-play event,
// rewrite it spoiler-free with the short competition name first ("EPL MNU v ARS
// spoiler", "F1 British GP spoiler"). The rewrite is cached on the shared item's
// `spoiler_free_title` column; the ORIGINAL always stays in `title`, so the
// client decides which to show (allowlist + per-user setting).
//
// Deliberately a title/RSS-only feature: the model sees the headline plus the
// content we ALREADY stored from the feed (`content_html` / `summary`) — never a
// fresh article fetch (no Jina, no fulltext) — so a headline classification is
// cheap and adds no new outbound fetch to the poll path.
//
// This module is the testable, dependency-free half (prompt, parse, content
// selection, and the injectable orchestrator). It must stay free of Deno globals
// so the same code runs under vitest (node); the `Deno.env` / network / DB bits
// live in the poll entrypoint. Mirrors `_shared/summary.ts` in shape.

import { htmlToPlainText } from './summary.ts';

/** A headline classification needs very little article text — the headline does
 * most of the work, and the RSS body is only there to disambiguate the league /
 * teams. Clamp hard so a long body never bloats the request. */
export const MAX_SPOILER_CONTENT_CHARS = 2_000;

/** Build the plain-text context handed to the model for one item: the stored RSS
 * body (`content_html`, else `summary`) stripped to text and clamped. Returns ''
 * when there's nothing — the headline alone is still enough to classify. */
export function spoilerContentText(row: {
  content_html?: string | null;
  summary?: string | null;
}): string {
  const text = htmlToPlainText(row.content_html) || htmlToPlainText(row.summary);
  return text.length > MAX_SPOILER_CONTENT_CHARS
    ? text.slice(0, MAX_SPOILER_CONTENT_CHARS)
    : text;
}

/** Prompt Gemini to classify a headline and, when it spoils a sporting event,
 * return the spoiler-free rewrite. The contract is a small JSON object so the
 * "does it even contain a spoiler?" decision is an EXPLICIT flag, not something
 * we infer from prose:
 *   { "spoiler": true,  "headline": "EPL MNU v ARS spoiler" }
 *   { "spoiler": false, "headline": "" }
 * The guiding principle is DELAYED-REPLAY: assume the reader might watch the
 * event later and hide anything that would spoil it — the outcome (who won/lost/
 * drew, advanced, was eliminated, crowned champion; incl. implied framings like
 * "Farewell X") AND any in-play moment (a goal, the score, a card, a penalty, a
 * crash, an injury during play, who's leading). The ONLY thing that's never a
 * spoiler is PRE-GAME content (previews, predictions, build-up before it starts);
 * and a headline with no event to watch (a transfer, a fixture, non-sport) has
 * nothing to spoil. When unsure about a specific event, hide it. */
export function buildSpoilerPrompt(
  title: string | null | undefined,
  content: string,
): string {
  const contentBlock = content
    ? `\n\nFor context, the article body is between the delimiters:\n--- BEGIN ARTICLE ---\n${content}\n--- END ARTICLE ---`
    : '';
  return (
    `You rewrite sports headlines so they don't spoil an event for someone who ` +
    `plans to watch it later on delayed replay.\n\n` +
    `A headline is a SPOILER if it reveals anything that happens once the event is ` +
    `under way — from the first whistle to the final result. That covers the ` +
    `outcome (who won, lost, drew, advanced, was eliminated or knocked out, or was ` +
    `crowned champion — including framings that only make sense once you know it, ` +
    `like "Farewell X", "dream over", "X bow out", "glory for X", "X lift the ` +
    `trophy") AND every in-play moment (a goal or the score at any point, a red or ` +
    `yellow card, a penalty, a sending-off, a crash, a retirement, an injury ` +
    `during play, who is leading, a comeback). If a headline is about a specific ` +
    `event that has started or finished and you're unsure whether it gives ` +
    `anything away, treat it as a spoiler.\n\n` +
    `The ONLY exception is PRE-GAME content — a preview, prediction, build-up, or ` +
    `team news from before the event begins — which is never a spoiler. And a ` +
    `headline with no event to watch (a transfer, a fixture announcement, or ` +
    `anything not about sport) has nothing to spoil.\n\n` +
    `When it IS a spoiler, write a spoiler-free replacement that names only WHICH ` +
    `event it is, NEVER what happened. The replacement must not describe the ` +
    `incident at all — no score, result, goal, card, crash, collapse, injury, or ` +
    `medical emergency may appear in it. (A rewrite like "Football critical injury ` +
    `spoiler" is WRONG: it states what happened. Name the teams instead.) Lead ` +
    `with the short competition or league name (e.g. F1, EPL, NBA, NFL, World ` +
    `Cup). If you can't identify the specific competition, lead with the SPORT ` +
    `instead (e.g. Rugby, Cricket, Football) so the reader still knows what it is ` +
    `— never omit both, and never invent a league you can't confirm from the ` +
    `text. Then give the participants as short abbreviations or names joined by ` +
    `"v" for a head-to-head (use just the one team when only one is named), then ` +
    `the word "spoiler". Keep any qualifier that is part of a team's name (e.g. ` +
    `Reserves, Women's, U21) since it says which side is playing. Dig the ` +
    `participants out of the article body when the headline names only one side ` +
    `or none at all; fall back to the sport alone only when the body names no ` +
    `teams either — and even then, never describe the incident. Examples: ` +
    `"EPL MNU v ARS spoiler", "F1 British GP qualifying spoiler", ` +
    `"World Cup ARG v CPV spoiler", "NBA Finals Game 3 spoiler", ` +
    `"Rugby AUS v IRE spoiler", "Football Epping v Lalor Reserves spoiler".\n\n` +
    `Reply with ONLY a JSON object of the form ` +
    `{"spoiler": boolean, "headline": string}. Set "headline" to the ` +
    `spoiler-free replacement when "spoiler" is true, otherwise an empty ` +
    `string.\n\n` +
    `Headline: ${title ?? ''}` +
    contentBlock
  );
}

/** Minimal shape of the Gemini `generateContent` REST response we read — the
 * same envelope `_shared/summary.ts` parses, re-declared here so this module
 * doesn't depend on that file's internal type. */
export interface GeminiResponseLike {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown }> };
  }> | null;
}

/** Extract the model's text (first candidate, parts joined) — mirrors
 * `parseGeminiText`, inlined so the JSON parsing below has one entry point. */
function geminiText(json: GeminiResponseLike | null | undefined): string {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
}

/** Strip a ```json … ``` (or bare ```) fence the model sometimes wraps JSON in,
 * so JSON.parse sees the object. Returns the inner text trimmed. */
function stripCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Turn a Gemini response into the spoiler-free title to CACHE, or null.
 *
 * Returns the rewrite ONLY when the model explicitly flagged `spoiler: true` AND
 * gave a non-empty headline. Every other case — `spoiler: false`, an empty
 * headline, non-JSON, a safety block, a malformed envelope — returns null, which
 * the caller stores as "processed, no rewrite" so the original headline shows.
 * So a parse failure fails SAFE (keep the original), never blanks a title.
 */
export function parseSpoilerResult(
  json: GeminiResponseLike | null | undefined,
): { spoilerFreeTitle: string | null } {
  const text = stripCodeFence(geminiText(json));
  if (!text) return { spoilerFreeTitle: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { spoilerFreeTitle: null };
  }
  if (!parsed || typeof parsed !== 'object') return { spoilerFreeTitle: null };
  const { spoiler, headline } = parsed as { spoiler?: unknown; headline?: unknown };
  if (spoiler !== true) return { spoilerFreeTitle: null };
  const rewrite = typeof headline === 'string' ? headline.trim() : '';
  return { spoilerFreeTitle: rewrite || null };
}

/** An item row the generation pass considers. */
export interface SpoilerItemRow {
  id: string;
  title: string | null;
  content_html?: string | null;
  summary?: string | null;
  /** Processed-marker: non-null once this item has been through the pass
   * (whether or not a rewrite was produced), so it isn't re-processed. */
  spoiler_free_title_generated_at?: string | null;
}

/** Whether an item still needs a spoiler-title pass: it hasn't been processed
 * yet (`generated_at` absent/null) and has a title to classify. A defensive
 * re-filter of whatever the DB query returned. */
export function selectItemsNeedingSpoilerTitle(rows: SpoilerItemRow[]): SpoilerItemRow[] {
  return rows.filter(
    (r) => !r.spoiler_free_title_generated_at && !!r.title && r.title.trim().length > 0,
  );
}

/** The outcome of classifying one headline. Distinguishes a genuine
 * classification (rewrite or not) — which is CACHED so we don't re-bill it —
 * from a transient failure — which is NOT persisted, so the item stays
 * `generated_at IS NULL` and is retried on the next poll. Collapsing these (a
 * failed call written as "processed, no rewrite") would let a momentary Gemini
 * outage permanently skip a headline until its title/body changes. */
export type SpoilerGeneration =
  | { status: 'rewrite'; title: string } // a spoiler → cache the rewrite
  | { status: 'none' } // classified, not a spoiler → cache null (processed)
  | { status: 'failed' }; // transient failure → do NOT mark processed; retry

/** DB + model operations the orchestrator needs, injected so the whole flow is
 * unit-testable without a live Supabase/Gemini (the poll entrypoint wires the
 * real ones). Kept as plain async functions rather than a PostgREST builder so
 * tests fake them trivially. */
export interface SpoilerDeps {
  /** The subset of `feedIds` that have at least one allowlisted subscriber. MUST
   * return [] when the allowlist is empty (feature off) so an unseeded deploy
   * never runs poll-time Gemini for every feed — the cost-safety gate. */
  allowlistedFeeds(feedIds: string[]): Promise<string[]>;
  /** Unprocessed, recent items for one feed (`generated_at IS NULL`, bounded). */
  unprocessedItems(feedId: string): Promise<SpoilerItemRow[]>;
  /** Classify + (when a spoiler) rewrite one headline via Gemini. Returns a
   * {@link SpoilerGeneration} so a transient failure is distinguished from a
   * genuine non-spoiler (only the latter is cached as processed). */
  generate(title: string | null, content: string): Promise<SpoilerGeneration>;
  /** Persist the outcome on the shared item: the rewrite (or null) plus the
   * processed timestamp. Called only for a genuine classification, never a
   * transient failure. */
  write(itemId: string, spoilerFreeTitle: string | null): Promise<void>;
}

export interface SpoilerRunResult {
  /** Items processed — a genuine classification was cached (`write` attempted). */
  processed: number;
  /** Of those, how many got a spoiler-free rewrite. */
  rewritten: number;
  /** Items whose Gemini call failed transiently — NOT persisted, so they're
   * retried on the next poll. */
  failed: number;
  /** True when the run stopped early on the item cap or time budget (leftover
   * unprocessed items remain, to be picked up next poll). */
  budgetHit: boolean;
}

/** Bounds on one spoiler pass so a big batch can't fan out into hundreds of
 * serial Gemini calls that keep the Edge Function busy for minutes (and risk a
 * function timeout / overlapping the next scheduled poll) — especially during a
 * Gemini slowdown where each call can take its full timeout. Anything skipped
 * stays `generated_at IS NULL` and is retried on the next poll. */
export interface SpoilerRunOptions {
  /** Hard cap on items ATTEMPTED (processed + failed) across all feeds this run. */
  maxItems?: number;
  /** Wall-clock guard, checked before each item; return false to stop starting
   * new work (the entrypoint wires this to a deadline). Kept as an injected
   * predicate so this module stays free of clock globals and unit-testable. */
  withinBudget?: () => boolean;
}

/**
 * Generate spoiler-free titles for the unprocessed items of the polled feeds
 * that have an allowlisted subscriber. Pure control flow over injected deps:
 *   1. narrow to allowlisted-subscriber feeds (empty allowlist → nothing);
 *   2. per feed, take the unprocessed items;
 *   3. per item, classify+rewrite via Gemini and persist the result (rewrite or
 *      null) so it's marked processed and never re-billed.
 * Bounded by {@link SpoilerRunOptions} (an item cap and a wall-clock budget) so
 * one poll can't run unboundedly; leftovers are retried next poll. A failure on
 * one item doesn't stop the rest. Returns simple counts for the poll log line.
 */
export async function generateSpoilerTitles(
  feedIds: string[],
  deps: SpoilerDeps,
  opts: SpoilerRunOptions = {},
): Promise<SpoilerRunResult> {
  const maxItems = opts.maxItems ?? Infinity;
  const withinBudget = opts.withinBudget ?? (() => true);
  let processed = 0;
  let rewritten = 0;
  let failed = 0;
  let budgetHit = false;
  if (feedIds.length === 0) return { processed, rewritten, failed, budgetHit };

  const feeds = await deps.allowlistedFeeds(feedIds);
  outer: for (const feedId of feeds) {
    const items = selectItemsNeedingSpoilerTitle(await deps.unprocessedItems(feedId));
    for (const item of items) {
      // Stop STARTING new work once the item cap or the time budget is hit; the
      // rest stay unprocessed for the next poll.
      if (processed + failed >= maxItems || !withinBudget()) {
        budgetHit = true;
        break outer;
      }
      const content = spoilerContentText(item);
      const gen = await deps.generate(item.title, content);
      if (gen.status === 'failed') {
        // Transient failure: leave generated_at null so the next poll retries.
        // Don't persist "processed" — that would permanently skip the headline.
        failed++;
        continue;
      }
      const spoilerFreeTitle = gen.status === 'rewrite' ? gen.title : null;
      await deps.write(item.id, spoilerFreeTitle);
      processed++;
      if (spoilerFreeTitle) rewritten++;
    }
  }
  return { processed, rewritten, failed, budgetHit };
}
