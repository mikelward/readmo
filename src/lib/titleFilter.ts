// Keyword filtering of feed rows by title (SPEC.md *Filtered words*).
//
// A reader keeps a list of words/phrases; any feed row whose title matches one
// vanishes from the feed views. This module is the whole matching contract —
// the list filter (ItemList's visibleItems overlay), the Settings editor, and
// the row menu's candidate list all read it, so they can never disagree about
// what "matches" means.
//
// ONE RULE carries the design: WHOLE WORD, not substring. `trump` must not eat
// "trumpet". Both the title and each filter entry are tokenized on
// non-alphanumerics and compared token-for-token, so an entry only ever matches
// a whole word — or, for a multi-word entry, a contiguous run of whole words.
//
// A filter matches exactly what you typed and nothing else. There was once an
// add-only plural allowance (`tariff` also matching "tariffs") and a stem
// offered beside each plural candidate in the row menu; both were removed
// deliberately as scope this feature doesn't need. The reader who wants both
// forms adds both — two taps, and the menu offers whichever forms the headline
// actually contains. What that buys is a matcher with no linguistic knowledge
// in it at all: nothing to get wrong for a language whose plurals don't work
// like English's, and nothing to keep in step between the client and SQL.

// `fold`, `tokenize` and `normalizeFilter` live in titleFilterCore.ts because
// the poller needs them too — it writes items.title_normalized so the feed RPCs
// can filter without folding in SQL. That module is duplicated into
// supabase/functions/_shared/ under a byte-identity test; everything below is
// client-only and stays here.
import { fold, tokenize, normalizeFilter } from './titleFilterCore';

export { fold, normalizeFilter };

/** Whether `title` matches a single already-normalized filter entry. A
 * multi-word entry matches a CONTIGUOUS run of title words, so `trade war`
 * matches "the trade war escalates" but not "war over trade". Every token
 * compares exactly. */
function titleMatchesFilter(titleTokens: string[], filter: string): boolean {
  const filterTokens = filter.split(' ').filter(Boolean);
  if (filterTokens.length === 0) return false;
  for (let i = 0; i + filterTokens.length <= titleTokens.length; i += 1) {
    if (filterTokens.every((wanted, j) => titleTokens[i + j] === wanted)) return true;
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

/** Whether an item's own categories match ANY of the reader's filter entries —
 * one commingled, case-insensitive keyword list: a filter added by tapping a
 * category (row menu) and one typed by hand are the same kind of entry, and
 * `Sport` the category folds to exactly the same stored form as `sport` typed
 * as a word. A category is compared as a WHOLE folded phrase (not tokenized
 * word-by-word the way a title is), so this is membership, not a substring or
 * word-boundary search. Trade-off, not yet revisited: folding strips
 * punctuation, so a filter for a category like `.NET` or `C++` also becomes an
 * ordinary word filter for "net"/"c" — punctuation-preserving matching for
 * both category- and title-sourced entries is a follow-up (TODO.md).
 * `categories` defaults missing (a persisted cache written before this field
 * existed can still hand back a row without it at runtime). */
export function categoriesAreFiltered(
  categories: readonly string[] | undefined,
  filters: readonly string[],
): boolean {
  if (filters.length === 0 || !categories || categories.length === 0) return false;
  return categories.some((category) => {
    const folded = normalizeFilter(category);
    return folded !== null && filters.includes(folded);
  });
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

/** Shortest word worth offering as a candidate. Below this it's a stub or an
 * abbreviation the reader almost certainly didn't mean to filter on. */
const MIN_CANDIDATE_LENGTH = 3;

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

/** The row menu's two tiers of one-tap filter candidates for a title.
 *
 *  - `primary` — capitalized terms: the names a reader almost always means.
 *    Adjacent capitalized words are offered as a phrase AND individually, so
 *    "Donald Trump" gives you the pair and the surname on its own.
 *  - `more` — the remaining content words, behind the menu's `More…` step.
 *    Single words only: merging adjacent lowercase words gives you
 *    "hit soybean", which is nobody's filter.
 *
 * Both tiers are in title order (the only ordering a reader can predict) and
 * drop anything already filtered. Candidates are the words the headline
 * actually contains, verbatim — no stem is derived beside a plural, because the
 * matcher no longer has a plural rule for one to pair with. A reader who wants
 * both forms adds both. */
export function filterCandidates(
  title: string,
  active: readonly string[] = [],
): { primary: string[]; more: string[] } {
  const words = titleWords(title);
  const taken = new Set(active.map((entry) => normalizeFilter(entry)).filter(Boolean) as string[]);
  const primary: string[] = [];
  const more: string[] = [];

  /** Add a candidate if it's new. */
  const offer = (into: string[], display: string) => {
    const key = normalizeFilter(display);
    if (!key || taken.has(key)) return;
    taken.add(key);
    into.push(display);
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
    if (w.folded.length < MIN_CANDIDATE_LENGTH) continue;
    if (/^\p{N}+$/u.test(w.folded)) continue;
    offer(more, w.display);
  }

  return { primary: primary.slice(0, MAX_PRIMARY), more: more.slice(0, MAX_MORE) };
}
