// The Unicode half of the title-filter contract (SPEC.md *Filtered words*).
//
// THIS FILE IS DUPLICATED VERBATIM at supabase/functions/_shared/titleFilterCore.ts,
// and titleFilterCore.identity.test.ts fails if the two copies differ by a
// single byte. Change one, change both.
//
// The duplication is deliberate and the alternative was tried: `tsconfig.app.json`
// includes only `src` and `api`, the Deno bundle resolves its own way, and the
// Vercel `api/` gotcha in AGENTS.md is this exact failure — an import across
// trees that passes every local check and dies at deploy. A copy plus a test
// that reads both files is the shape this repo already uses for the
// session-start hook.
//
// WHY IT EXISTS AT ALL. The feed RPCs must apply the reader's filters
// server-side, or the per-feed floor spends its slots on rows the client then
// drops and the feed renders empty (migration 0072's header). Postgres has no
// Unicode property classes, so an earlier attempt transcribed `fold` into SQL
// with hand-enumerated combining-mark ranges; review found four defects in that
// one regex, the last of which made the server HIDE articles the client shows.
// So the folding happens here, in JavaScript, on both sides of the wire: the
// poller writes `items.title_normalized` with this module and SQL does nothing
// but ASCII-delimited substring matching.
//
// KEEP THIS MODULE DEPENDENCY-FREE. It is loaded by Vite, by Vitest and by Deno;
// an import would have to resolve identically in all three, and Deno's
// extension rules alone would break byte-identity.

/** Bump when `fold` or `tokenize` change what they PRODUCE.
 *
 * Stored `title_normalized` values are materialized, so a semantic change here
 * does not reach rows that already have one — they would sit on the old
 * contract forever while new rows and the client used the new one. The poller's
 * backfill pass selects `title_normalized_version < TITLE_NORMALIZED_VERSION`,
 * so bumping this constant is the whole rollout.
 *
 * A pure refactor doesn't need a bump; a changed output for any input does. */
export const TITLE_NORMALIZED_VERSION = 2;

/** Case- and diacritic-folded form used for every comparison, so `Peña`,
 * `peña` and `Pena` are one word. */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** Split text into comparable word tokens. Splitting on every non-alphanumeric
 * is what makes possessives work for free: `Trump's` tokenizes to `trump` +
 * `s`, so a `trump` filter matches it without a possessive rule — apostrophe
 * stays a hard separator, unlike the punctuation below.
 *
 * `.`, `+` and `#` are WORD characters, not separators, so a term like `.NET`,
 * `C++` or `C#` survives as one token instead of collapsing to `net`/`c`/`c`
 * and over-matching any title that merely contains that bare word. `+`/`#`
 * are unconditional (they're not ordinary sentence punctuation); `.` first
 * matches greedily with letters/digits/`+`/`#` into one run (so `.NET`,
 * `U.S`, `Node.js` and even a mid-sentence ellipsis all merge into a single
 * chunk), and is then split back apart in two passes rather than with a regex
 * lookbehind — `(?<!…)` is a parse-time SyntaxError on Safari < 16.4, and this
 * is a mobile-facing app with no transpile step that would rewrite it (see
 * MarkdownText.tsx for the same constraint hit before):
 *   - any run of 2+ consecutive dots (an ellipsis, `Wait...really`) is a hard
 *     separator and is dropped, splitting the chunk in two — a genuine
 *     `.NET`-style single leading dot is never adjacent to another dot, so it
 *     survives this split untouched;
 *   - a single dot left at the very END of what remains (`rise.` from "Rates
 *     rise.") is dropped too — it can only be there because whatever followed
 *     it in the original text wasn't a token character (whitespace or the
 *     string's end), the same "trailing period drops" rule as before.
 *
 * A run made ENTIRELY of `+`/`#` (no letter or digit at all — a title like
 * `A + B`, or someone typing bare `+` as a filter) is dropped rather than
 * kept as its own token: `normalizeFilter`'s "no word characters at all"
 * rejection depends on tokenize() never returning a punctuation-only token. */
export function tokenize(value: string): string[] {
  const chunks = fold(value).match(/[\p{L}\p{N}+#.]+/gu) ?? [];
  const tokens: string[] = [];
  for (const chunk of chunks) {
    for (const piece of chunk.split(/\.{2,}/u)) {
      const trimmed = piece.replace(/\.$/u, '');
      if (trimmed && /[\p{L}\p{N}]/u.test(trimmed)) tokens.push(trimmed);
    }
  }
  return tokens;
}

/** Canonical stored form of a filter entry: folded, with runs of punctuation
 * and whitespace collapsed to single spaces. Returns null for an entry with no
 * word characters at all (typing spaces, or `...`), which callers reject. */
export function normalizeFilter(raw: string): string | null {
  const tokens = tokenize(raw);
  return tokens.length > 0 ? tokens.join(' ') : null;
}

/** What a NULL `items.title` displays as. The client mapper substitutes this
 * before the reader ever sees the row, and the row menu will happily offer
 * `untitled` as a filter candidate from it — so the server has to normalize the
 * same text, or it would keep counting a row the client hides. */
export const UNTITLED = '(untitled)';

/** The stored form of a title: folded tokens joined by single spaces and
 * wrapped in one more, so a plain substring search is a whole-word match —
 * ' trump ' cannot be found inside ' trumpet '. That wrapping is the entire
 * reason SQL needs no tokenizer.
 *
 * Deliberately NOT `normalizeFilter`: that returns null for tokenless input,
 * which is right for rejecting a filter entry someone typed and wrong here. A
 * title of `!!! ???` is a real row that must still be stored and must match
 * nothing, so it normalizes to `'  '` — non-NULL, and containing no ` word `.
 * Returning null instead would leave the row in the backfill backlog forever,
 * and because the backlog is a bounded ordered scan it would be re-selected
 * every poll and starve every row behind it. */
export function normalizeTitle(title: string | null | undefined): string {
  return ` ${tokenize(title ?? UNTITLED).join(' ')} `;
}
