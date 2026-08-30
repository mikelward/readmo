// Spoiler-free sports headlines — display selection.
//
// A sports feed can spoil a result in the headline itself ("Man Utd beat
// Arsenal 3-1"). The server (Gemini, at poll time) caches a spoiler-free rewrite
// on `item.spoilerFreeTitle` for allowlisted-subscriber feeds; the ORIGINAL
// always stays in `item.title`, so which one we SHOW is a pure client decision.
//
// This module is that decision, kept dependency-free so it's trivially testable
// and shared by the row (ItemRow) and the reader (ItemPage). Display is gated on
// three things:
//   - `allowed` — the caller may see rewrites (the allowlist capability, same
//     family gate as reading mode; see useCapabilities.canUseFullText); AND
//   - `hideSpoilers` — the per-user "Hide sports spoilers" setting is on
//     (useReadingPrefs); AND
//   - `revealed` is off — this one row hasn't been opened up by a tap.
// Only when all three hold AND a non-empty rewrite exists do we swap the
// headline; otherwise the original title is shown untouched (the safe,
// reversible default).

import type { Item } from './types';

export interface SpoilerHeadlineOptions {
  /** The per-user "Hide sports spoilers" setting (useReadingPrefs). */
  hideSpoilers: boolean;
  /** Whether the caller is allowed to see rewrites (allowlist capability). */
  allowed: boolean;
  /** This one row has been opened up by a tap on it (ItemRow's first-tap
   * reveal). Unlike the two gates above — which are a setting and a
   * capability, and so answer the same for every row — this is per row and
   * per session: the reader asked to see THIS headline. Defaults to false. */
  revealed?: boolean;
}

export interface DisplayTitle {
  /** The headline to render — the spoiler-free rewrite when `rewritten`, else
   * the original `item.title`. */
  text: string;
  /** True only when we're showing the spoiler-free rewrite in place of the
   * original — the signal to render the "de-spoilered" marker, and the test for
   * whether a row is still concealing something (so a tap reveals rather than
   * opens). A revealed row reads as false: there is nothing left hidden. */
  rewritten: boolean;
  /** The original headline, always available so the marker can reveal it
   * (a native `title`/aria hint) without needing a tap target. */
  original: string;
}

/** Pick the headline to display for an item, honoring the allowlist gate, the
 * per-user setting, and this row's own reveal. Falls back to the original title
 * whenever a rewrite can't or shouldn't be shown (off-allowlist, setting off,
 * revealed, no rewrite cached, or a blank/whitespace rewrite), so a missing/empty
 * column never blanks a row. */
export function displayTitle(
  item: Pick<Item, 'title' | 'spoilerFreeTitle'>,
  { hideSpoilers, allowed, revealed = false }: SpoilerHeadlineOptions,
): DisplayTitle {
  const original = item.title;
  const rewrite = item.spoilerFreeTitle?.trim();
  if (hideSpoilers && allowed && rewrite && !revealed) {
    return { text: rewrite, rewritten: true, original };
  }
  return { text: original, rewritten: false, original };
}
