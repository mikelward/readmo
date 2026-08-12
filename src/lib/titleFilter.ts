// Keyword filtering of feed rows by title (SPEC.md *Filtered words*).
//
// A reader keeps a list of words/phrases; any feed row whose title matches one
// vanishes from the feed views. This module is the whole matching contract —
// the list filter (ItemList's visibleItems overlay), the Settings editor, and
// the row menu's candidate list all read it, so they can never disagree about
// what "matches" means.
//
// Two rules carry the design (both were deliberate, see SPEC):
//
//  - WHOLE WORD, not substring. `trump` must not eat "trumpet". Both the title
//    and each filter entry are tokenized on non-alphanumerics and compared
//    token-for-token, so an entry only ever matches a whole word (or, for a
//    multi-word entry, a contiguous run of whole words).
//  - ADD-ONLY plural tolerance. A filter matches its `+s` / `+es` forms and
//    NEVER strips a suffix. Stripping is what produces a shorter, commoner word
//    that swallows the language — `news` → `new` hides every headline with
//    "new" in it, `US` → `u`/`us` hides almost everything. Adding can only ever
//    produce a LONGER, more specific string, so it cannot overreach: a variant
//    that isn't a real word (`tariffes`) simply never matches anything.
//
// The stem a reader might actually want (`tariffs` → `tariff`) is offered as a
// visible one-tap candidate in the row menu instead — see filterCandidates. So
// the stripping decision is made by the reader, with both forms in front of
// them, rather than silently inside the matcher.

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
 * `s`, so a `trump` filter matches it without a possessive rule. */
function tokenize(value: string): string[] {
  return fold(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Whether a title token satisfies a filter token — exact, or one of the
 * filter's simple plurals. Add-only: never strips (see the module header).
 *
 * The `-ies` form has to be here because filterCandidates OFFERS that stem:
 * `companies` in a headline offers `company`, and without this the reader's
 * pick wouldn't even filter the row they picked it from. It stays add-only —
 * every variant is longer than what was typed — so it can't overreach. It's
 * restricted to consonant + `y` because that's the rule English follows;
 * `day` → `daies` isn't a word and would only ever match nothing. */
function tokenMatches(titleToken: string, filterToken: string): boolean {
  if (
    titleToken === filterToken ||
    titleToken === `${filterToken}s` ||
    titleToken === `${filterToken}es`
  ) {
    return true;
  }
  return (
    /[^aeiou]y$/.test(filterToken) && titleToken === `${filterToken.slice(0, -1)}ies`
  );
}

/** Canonical stored form of a filter entry: folded, with runs of punctuation
 * and whitespace collapsed to single spaces. Returns null for an entry with no
 * word characters at all (typing spaces, or `...`), which callers reject. */
export function normalizeFilter(raw: string): string | null {
  const tokens = tokenize(raw);
  return tokens.length > 0 ? tokens.join(' ') : null;
}

/** Whether `title` matches a single already-normalized filter entry. A
 * multi-word entry matches a CONTIGUOUS run of title words, so `trade war`
 * matches "the trade war escalates" but not "war over trade". The plural
 * allowance applies to the entry's LAST token only — English pluralizes the
 * head noun (`trade war` → `trade wars`), and applying it to every token would
 * widen the match for no real gain. */
function titleMatchesFilter(titleTokens: string[], filter: string): boolean {
  const filterTokens = filter.split(' ').filter(Boolean);
  if (filterTokens.length === 0) return false;
  const last = filterTokens.length - 1;
  for (let i = 0; i + filterTokens.length <= titleTokens.length; i += 1) {
    let hit = true;
    for (let j = 0; j < filterTokens.length; j += 1) {
      const token = titleTokens[i + j];
      const wanted = filterTokens[j];
      // Interior tokens of a phrase must match exactly; only the head noun
      // carries the plural allowance.
      if (j === last ? !tokenMatches(token, wanted) : token !== wanted) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/** Normalize + dedupe a stored filter list once, for repeated matching. The
 * list filter runs this per view and matches every row against the result, so
 * a hand-edited (or older-client) localStorage value is repaired once rather
 * than re-parsed per row. */
export function compileFilters(filters: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of filters) {
    const normalized = normalizeFilter(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** Whether a title matches ANY of the reader's filter entries. Entries must be
 * normalized — pass them through compileFilters first. */
export function titleIsFiltered(title: string, filters: readonly string[]): boolean {
  if (filters.length === 0) return false;
  const titleTokens = tokenize(title);
  if (titleTokens.length === 0) return false;
  return filters.some((entry) => titleMatchesFilter(titleTokens, entry));
}

/** Function words that are never worth offering as a filter candidate. Applied
 * to BOTH tiers: they're the bulk of tier 2's noise, and in a title-cased
 * headline ("Trump Says Tariffs Will Rise") they're capitalized too, where they
 * would otherwise glue unrelated names into one nonsense phrase. */
const STOPWORDS = new Set([
  'a', 'about', 'after', 'against', 'all', 'am', 'an', 'and', 'any', 'are',
  'as', 'at', 'be', 'been', 'before', 'being', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her',
  'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'me', 'my', 'no', 'nor', 'not', 'of', 'off', 'on', 'or', 'our', 'out',
  'over', 'own', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to',
  'too', 'under', 'until', 'up', 'us', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would',
  'you', 'your',
]);

/** Longest phrase offered from a run of adjacent capitalized words. A name is
 * rarely longer than three words, and a title-cased headline is otherwise one
 * enormous useless run. The run's individual words are always offered too, so
 * a junk phrase costs one menu line and never costs the reader the word they
 * actually wanted. */
const MAX_PHRASE_WORDS = 3;

/** Per-tier caps, so the sheet stays a glance rather than a scroll. */
const MAX_PRIMARY = 6;
const MAX_MORE = 10;

/** Shortest stem worth offering. Below this, stripping produces noise (`us` →
 * `u`) rather than a word anyone meant. */
const MIN_STEM_LENGTH = 3;

/** A word as it appears in the title, with the display form kept for the menu
 * label and the folded form for comparison. */
interface Word {
  display: string;
  folded: string;
  capitalized: boolean;
}

/** Split a title into words for candidate extraction, keeping display case.
 * Trailing possessives are dropped (`Trump's` → `Trump`) so the candidate is
 * the name rather than the inflected form. */
function titleWords(title: string): Word[] {
  const raw = title.match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu) ?? [];
  const out: Word[] = [];
  for (const token of raw) {
    const display = token.replace(/['’]s$/iu, '').replace(/['’]+$/u, '');
    if (!display) continue;
    out.push({
      display,
      folded: fold(display),
      capitalized: /^\p{Lu}/u.test(display),
    });
  }
  return out;
}

/** The stem to offer beside a plural candidate, or null when there isn't a
 * sensible one. Handles the two forms worth covering — `-ies` → `-y`
 * (`companies` → `company`) and a plain trailing `-s` — and declines anything
 * that would leave a stub. Double-s words (`press`, `class`) are excluded: the
 * "stem" would be a non-word. */
function stemOf(word: string): string | null {
  if (word.length < MIN_STEM_LENGTH + 1) return null;
  if (word.endsWith('ies')) {
    const stem = `${word.slice(0, -3)}y`;
    return stem.length >= MIN_STEM_LENGTH ? stem : null;
  }
  if (word.endsWith('ss') || !word.endsWith('s')) return null;
  const stem = word.slice(0, -1);
  return stem.length >= MIN_STEM_LENGTH ? stem : null;
}

/** The row menu's two tiers of one-tap filter candidates for a title.
 *
 *  - `primary` — capitalized terms: the names a reader almost always means.
 *    Adjacent capitalized words are offered as a phrase AND individually, so
 *    "Donald Trump" gives you the pair and the surname on its own.
 *  - `more` — the remaining content words, behind the menu's `More…` step.
 *    Single words only: merging adjacent lowercase words gives you
 *    "hit soybean", which is nobody's filter.
 *
 * Both tiers are in title order (the only ordering a reader can predict), drop
 * anything already filtered, and offer a stem beside any plural candidate
 * (`tariffs`, then `tariff`) so the reader picks the form rather than the
 * matcher guessing. */
export function filterCandidates(
  title: string,
  active: readonly string[] = [],
): { primary: string[]; more: string[] } {
  const words = titleWords(title);
  const taken = new Set(active.map((entry) => normalizeFilter(entry)).filter(Boolean) as string[]);
  const primary: string[] = [];
  const more: string[] = [];

  /** Add a candidate (and its stem, right after it) if it's new. */
  const offer = (into: string[], display: string) => {
    const key = normalizeFilter(display);
    if (!key || taken.has(key)) return;
    taken.add(key);
    into.push(display);
    const stem = stemOf(key);
    if (stem && !taken.has(stem)) {
      taken.add(stem);
      into.push(stem);
    }
  };

  // Tier 1. Stopwords break runs as well as being skipped, which covers both a
  // sentence-initial "The Trump administration" (offers `Trump`, not the phrase
  // "The Trump") and a title-cased headline, where every function word is
  // capitalized too and would otherwise glue unrelated names together.
  const isRunWord = (w: Word) => w.capitalized && !STOPWORDS.has(w.folded);
  const usedInPrimary = new Set<string>();
  for (let i = 0; i < words.length; ) {
    if (!isRunWord(words[i])) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < words.length && isRunWord(words[end])) end += 1;
    const run = words.slice(i, end);
    if (run.length > 1) {
      offer(primary, run.slice(0, MAX_PHRASE_WORDS).map((w) => w.display).join(' '));
    }
    for (const w of run) {
      offer(primary, w.display);
      usedInPrimary.add(w.folded);
    }
    i = end;
  }

  // Tier 2. Everything tier 1 didn't take, minus function words, minus stubs
  // and bare numbers — the content words of the headline.
  for (const w of words) {
    if (usedInPrimary.has(w.folded)) continue;
    if (STOPWORDS.has(w.folded)) continue;
    if (w.folded.length < MIN_STEM_LENGTH) continue;
    if (/^\p{N}+$/u.test(w.folded)) continue;
    offer(more, w.display);
  }

  return { primary: primary.slice(0, MAX_PRIMARY), more: more.slice(0, MAX_MORE) };
}
