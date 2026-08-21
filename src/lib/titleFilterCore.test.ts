import { describe, expect, it } from 'vitest';
import { normalizeFilter, normalizeTitle, tokenize, UNTITLED } from './titleFilterCore';
import { compileFilters, titleIsFiltered } from './titleFilter';

/** What migration 0074's SQL matcher does, in the one line it takes: the needle
 * is the entry wrapped in spaces, the haystack is the stored column. Reproduced
 * here so the cases below can assert the CLIENT and the SERVER agree — the only
 * property that matters, and the one 0072 got wrong. Both sides arrive folded
 * and space-wrapped, so containment IS whole-word matching. */
function serverMatches(stored: string, entries: string[]): boolean {
  return entries.some((entry) => entry !== '' && stored.includes(` ${entry} `));
}

describe('normalizeTitle', () => {
  it('wraps and joins folded tokens', () => {
    expect(normalizeTitle("Trump's tariffs")).toBe(' trump s tariffs ');
  });

  it('folds diacritics like the client matcher', () => {
    expect(normalizeTitle('Peña wins')).toBe(' pena wins ');
  });

  it('stores a non-null value for a tokenless title', () => {
    // The livelock guard: null here would leave the row in the backfill backlog
    // forever, and because the backlog is a bounded ordered scan it would be
    // re-selected every poll and starve every row behind it.
    expect(normalizeTitle('!!! ???')).toBe('  ');
    expect(normalizeTitle('!!! ???')).not.toBeNull();
  });

  it('matches nothing for a tokenless title', () => {
    expect(serverMatches(normalizeTitle('!!! ???'), ['trump'])).toBe(false);
  });

  it('normalizes a null title through the client display fallback', () => {
    // mapItem renders a null title as `(untitled)` and the row menu will offer
    // `untitled` as a candidate from it, so the server has to see the same text
    // or it would keep counting a row the client hides.
    expect(normalizeTitle(null)).toBe(normalizeTitle(UNTITLED));
    expect(serverMatches(normalizeTitle(null), ['untitled'])).toBe(true);
  });
});

describe('client and server agree', () => {
  const cases: Array<[string, string[], boolean, string]> = [
    ['Trump announces tariffs', ['trump'], true, 'exact word'],
    ['TRUMP announces tariffs', ['trump'], true, 'case folded'],
    ['Peña wins the race', ['pena'], true, 'diacritic folded'],
    ['A trumpet solo', ['trump'], false, 'not a substring'],
    ['The trumped-up charges', ['trump'], false, 'hyphen is a boundary'],
    ['Class action filed', ['as'], false, 'no substring inside a word'],
    ["Trump's tariffs hit farmers", ['trump'], true, 'possessive'],
    // No plural allowance: a filter matches exactly what was typed. Removed as
    // unearned complexity for a small, unproven feature — see SPEC.
    ['New tariffs announced', ['tariff'], false, 'singular does not match a plural'],
    ['New tariffs announced', ['tariffs'], true, 'the plural matches when typed'],
    ['Several companies withdrew', ['company'], false, 'no -ies rule'],
    ['One company withdrew', ['companies'], false, 'and none in reverse'],
    ['A new dawn', ['news'], false, 'never strips'],
    ['The trade war escalates', ['trade war'], true, 'contiguous run'],
    ['A war over trade rules', ['trade war'], false, 'same words, not a run'],
    ['The trade wars escalate', ['trade war'], false, 'no plural on the head noun'],
    ['The trade wars escalate', ['trade wars'], true, 'the phrase as typed'],
    ['Trades war over rules', ['trade war'], false, 'nor on an interior token'],
    ['Trump announces tariffs', [], false, 'empty list'],
    ['!!! ???', ['trump'], false, 'title with no words'],
    ['Musk buys a company', ['trump', 'musk'], true, 'second entry matches'],
    // The scripts 0072's hand-enumerated ranges missed. These are the whole
    // point of moving the fold into JS: both sides now fold the marks away, so
    // the word stays whole and the filter matches it on both sides.
    ['مُحَمَّد يفوز', ['محمد'], true, 'Arabic marks fold on both sides'],
    ['שָׁלוֹם עולם', ['שלום'], true, 'Hebrew points fold on both sides'],
    ['がくの話', ['がくの話'], true, 'Japanese dakuten folds on both sides'],
    // A real limitation, asserted rather than discovered: whole-word matching
    // needs word boundaries, and Japanese has none — so a filter can only match
    // a title it spans entirely. 0072's SQL corpus claimed `がく` matched
    // `がくの話`; that file needs a live psql and CI never runs it, so the claim
    // was never executed. It is wrong on both sides, and always was.
    ['がくの話', ['がく'], false, 'no word boundary to match a prefix'],
    // The regression that made this change urgent: under 0072 a mark SQL failed
    // to strip split the word into fragments, so a filter equal to a fragment
    // matched server-side while the client kept the word whole — the server hid
    // a row the client showed. Mixed-script on purpose: a mark can sit between
    // two Latin letters, so this was never limited to non-Latin readers.
    ['aَb is unrelated', ['a'], false, 'mixed-script: no fragment match'],
    ['aَb is unrelated', ['ab'], true, 'mixed-script: the whole word matches'],
    // A Malayalam LETTER must survive folding, so the tokens either side are
    // not joined into a word a filter would match.
    ['aൎb is unrelated', ['ab'], false, 'U+0D4E is a letter, not a mark'],
    // `.`/`+`/`#` are word characters, not separators (SPEC.md *Filtered
    // words*): a term like `.NET`/`C++`/`C#` survives as its own token
    // instead of collapsing to the bare, over-broad `net`/`c`/`c`.
    ['Announcing .NET 9', ['.net'], true, 'leading dot survives as part of the word'],
    ['Fishing net recovered from harbor', ['.net'], false, 'does not over-match the bare word'],
    ['Coding in C++ today', ['c++'], true, 'trailing plus signs survive'],
    ['The letter C explained', ['c++'], false, 'does not over-match the bare letter'],
    ['Learning C# basics', ['c#'], true, 'trailing hash survives'],
    // A sentence-ending period is still dropped — only a dot with a word
    // character immediately after it (leading or internal) survives.
    ['Rates rise.', ['rise'], true, 'trailing sentence period still drops'],
    ['U.S. troops arrive', ['u.s'], true, 'internal dot survives, trailing one still drops'],
  ];

  // Entries reach both matchers already canonical: addTitleFilter normalizes on
  // write and the mapper normalizes on read, which is exactly why the SQL side
  // can split them on ' ' instead of tokenizing.
  it.each(cases)('%s / %j → %s (%s)', (title, entries, want) => {
    const compiled = compileFilters(entries);
    expect(titleIsFiltered(title, compiled)).toBe(want);
    expect(serverMatches(normalizeTitle(title), compiled)).toBe(want);
  });

  it('tokenize is what both sides agree on', () => {
    expect(tokenize("Trump's tariffs")).toEqual(['trump', 's', 'tariffs']);
    expect(tokenize('!!! ???')).toEqual([]);
  });

  describe('tokenize keeps ., + and # as word characters', () => {
    it('keeps a leading dot (.NET) and trailing +/# (C++, C#)', () => {
      expect(tokenize('.NET')).toEqual(['.net']);
      expect(tokenize('C++')).toEqual(['c++']);
      expect(tokenize('C#')).toEqual(['c#']);
    });

    it('keeps an internal dot (Node.js, U.S) but drops a sentence-ending one', () => {
      expect(tokenize('Node.js announces v20')).toEqual(['node.js', 'announces', 'v20']);
      expect(tokenize('U.S. troops arrive')).toEqual(['u.s', 'troops', 'arrive']);
      expect(tokenize('Rates rise.')).toEqual(['rates', 'rise']);
    });

    it("still splits apostrophes as a hard separator — Trump's is unaffected", () => {
      expect(tokenize("Trump's")).toEqual(['trump', 's']);
    });

    it('does not let an ellipsis glue onto the next word', () => {
      expect(tokenize('Wait... really')).toEqual(['wait', 'really']);
    });

    it('does not let a compact (no-space) ellipsis glue onto the next word either (Codex P2)', () => {
      // The last "." of "Wait...really" is the tail of a dot run, not a
      // ".NET"-style leading dot — it must not attach to "really", or an
      // existing "really" filter silently stops matching this title.
      expect(tokenize('Wait...really')).toEqual(['wait', 'really']);
      expect(tokenize('Node...js')).toEqual(['node', 'js']);
      expect(tokenize('To be continued...')).toEqual(['to', 'be', 'continued']);
    });

    it('drops a run made entirely of +/# — no letter or digit to anchor it (Codex P2)', () => {
      // normalizeFilter's "no word characters at all" rejection depends on
      // tokenize() never returning a punctuation-only token.
      expect(tokenize('+')).toEqual([]);
      expect(tokenize('#')).toEqual([]);
      expect(tokenize('++')).toEqual([]);
      expect(normalizeFilter('+')).toBeNull();
      // A real letter/digit elsewhere in the text is unaffected.
      expect(tokenize('A + B')).toEqual(['a', 'b']);
    });
  });
});
