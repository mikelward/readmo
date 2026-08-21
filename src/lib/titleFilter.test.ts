// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  categoriesAreFiltered,
  compileFilters,
  filterCandidates,
  normalizeFilter,
  titleIsFiltered,
} from './titleFilter';

/** Match against a raw (unnormalized) list, the way a caller does. */
const matches = (title: string, filters: string[]) =>
  titleIsFiltered(title, compileFilters(filters));

describe('normalizeFilter', () => {
  it('folds case, diacritics and punctuation to a canonical form', () => {
    expect(normalizeFilter('  Trump  ')).toBe('trump');
    expect(normalizeFilter('Peña')).toBe('pena');
    expect(normalizeFilter('New   York')).toBe('new york');
    expect(normalizeFilter("Trump's")).toBe('trump s');
  });

  it('rejects an entry with no word characters', () => {
    expect(normalizeFilter('')).toBeNull();
    expect(normalizeFilter('   ')).toBeNull();
    expect(normalizeFilter('...')).toBeNull();
  });
});

describe('compileFilters', () => {
  it('normalizes and dedupes, preserving first-seen order', () => {
    expect(compileFilters(['Trump', 'trump', ' TRUMP ', 'Musk'])).toEqual(['trump', 'musk']);
  });

  it('drops entries that normalize to nothing', () => {
    expect(compileFilters(['', '  ', '—', 'Trump'])).toEqual(['trump']);
  });
});

describe('titleIsFiltered', () => {
  it('matches whole words only, case- and diacritic-insensitively', () => {
    expect(matches('Trump announces tariffs', ['trump'])).toBe(true);
    expect(matches('TRUMP announces tariffs', ['trump'])).toBe(true);
    expect(matches('Peña wins the race', ['pena'])).toBe(true);
  });

  // The rule that motivates tokenizing at all: a substring match would hide
  // every headline about brass instruments.
  it('does not match a word that merely contains the filter', () => {
    expect(matches('A trumpet solo for the ages', ['trump'])).toBe(false);
    // A hyphen is a token boundary, so this is the word "trumped" — a
    // different word, and the matcher reaches no inflections at all.
    expect(matches('The trumped-up charges', ['trump'])).toBe(false);
    expect(matches('Class action filed', ['as'])).toBe(false);
  });

  it('matches through a possessive without a possessive rule', () => {
    expect(matches("Trump's tariffs hit farmers", ['trump'])).toBe(true);
  });

  // The plural allowance was removed deliberately (SPEC *Filtered words*): the
  // feature is small and unproven, and English pluralization rules were the
  // most linguistic knowledge in it. A reader who wants both forms adds both.
  it('does NOT match a plural of the filter', () => {
    expect(matches('New tariffs announced', ['tariff'])).toBe(false);
    expect(matches('New taxes announced', ['tax'])).toBe(false);
    expect(matches('Several companies withdrew', ['company'])).toBe(false);
  });

  it('matches the plural when that is what was typed', () => {
    expect(matches('New tariffs announced', ['tariffs'])).toBe(true);
    expect(matches('Several companies withdrew', ['companies'])).toBe(true);
  });

  it('matches a multi-word entry only as a contiguous run', () => {
    expect(matches('The trade war escalates', ['trade war'])).toBe(true);
    expect(matches('A war over trade rules', ['trade war'])).toBe(false);
  });

  it('matches a phrase exactly, in every token', () => {
    expect(matches('The trade wars escalate', ['trade war'])).toBe(false);
    expect(matches('The trade wars escalate', ['trade wars'])).toBe(true);
    expect(matches('Trades war over rules', ['trade war'])).toBe(false);
  });

  it('is false for an empty list or a title with no words', () => {
    expect(matches('Trump announces tariffs', [])).toBe(false);
    expect(matches('!!! ???', ['trump'])).toBe(false);
  });
});

describe('categoriesAreFiltered', () => {
  const filters = compileFilters(['sport', 'tax and spending']);

  it('matches a category folded the same way a typed filter entry is', () => {
    expect(categoriesAreFiltered(['Sport'], filters)).toBe(true);
    expect(categoriesAreFiltered(['SPORT'], filters)).toBe(true);
    expect(categoriesAreFiltered(['Tax and Spending'], filters)).toBe(true);
  });

  it('does not match an unrelated category', () => {
    expect(categoriesAreFiltered(['Business'], filters)).toBe(false);
  });

  it('is false for an empty filter list, empty categories, or missing categories', () => {
    expect(categoriesAreFiltered(['Sport'], [])).toBe(false);
    expect(categoriesAreFiltered([], filters)).toBe(false);
    expect(categoriesAreFiltered(undefined, filters)).toBe(false);
  });

  // A persisted query-cache row written before categories existed can still
  // hand back one without the field at runtime, despite Item.categories being
  // typed non-optional — the same legacy shape ItemRow already guards against.
  it('does not throw when categories is missing (legacy cached item)', () => {
    expect(() => categoriesAreFiltered(undefined, filters)).not.toThrow();
  });

  it('is a whole-phrase match, not a substring or word-boundary search', () => {
    // "Sports" the category must not match a "sport" filter — this is exact
    // membership once folded, unlike titleIsFiltered's word-boundary rule.
    expect(categoriesAreFiltered(['Sports'], filters)).toBe(false);
  });

  it('distinguishes a punctuated category (.NET) from the bare word it used to collapse to', () => {
    // Before tokenize() kept `.`/`+`/`#` as word characters, `.NET` folded to
    // the same "net" a "Networking" category (or a `net` word filter) would.
    const netFilters = compileFilters(['.NET']);
    expect(categoriesAreFiltered(['.NET'], netFilters)).toBe(true);
    expect(categoriesAreFiltered(['Networking'], netFilters)).toBe(false);
    expect(categoriesAreFiltered(['Net'], netFilters)).toBe(false);
  });
});

describe('filterCandidates', () => {
  it('offers capitalized terms first and content words behind More', () => {
    const { primary, more } = filterCandidates("Trump's tariffs hit soybean farmers");
    expect(primary).toContain('Trump');
    expect(more).toEqual(expect.arrayContaining(['tariffs', 'soybean', 'farmers']));
    expect(more).not.toContain('Trump');
  });

  it('offers an adjacent capitalized run as a phrase and as its words', () => {
    const { primary } = filterCandidates('Donald Trump meets Elon Musk');
    expect(primary).toContain('Donald Trump');
    expect(primary).toContain('Trump');
    expect(primary).toContain('Elon Musk');
  });

  it('drops a leading stopword rather than gluing it to a name', () => {
    const { primary } = filterCandidates('The Trump administration responds');
    expect(primary).toContain('Trump');
    expect(primary).not.toContain('The Trump');
  });

  // A title-cased headline capitalizes function words too; without breaking
  // runs on them the whole headline becomes one useless phrase.
  it('breaks a run on a capitalized stopword', () => {
    const { primary } = filterCandidates('Trump Says Tariffs Will Rise');
    expect(primary).not.toContain('Trump Says Tariffs Will Rise');
    expect(primary).toContain('Trump');
  });

  // Candidates are the words the headline actually contains, verbatim. No stem
  // is derived beside a plural — there is no plural rule left for one to pair
  // with, and a stem the matcher can't reach would be a dead menu entry.
  it('offers the words the headline contains, with no derived stems', () => {
    const { more } = filterCandidates('New tariffs hit farmers');
    expect(more).toContain('tariffs');
    expect(more).toContain('farmers');
    expect(more).not.toContain('tariff');
    expect(more).not.toContain('farmer');
  });

  it('offers no derived forms at all, only the words present', () => {
    const { more } = filterCandidates('The press gathers as gas prices climb');
    expect(more).toContain('press');
    expect(more).toContain('prices');
    // Nothing is invented from them — these are the shapes the old stem rule
    // produced, and the reason it needed its own set of exceptions.
    expect(more).not.toContain('pres');
    expect(more).not.toContain('price');
  });

  it('skips words below the candidate length floor', () => {
    // `gas` survives (3 chars); a two-letter word never reaches the menu.
    const { more } = filterCandidates('The press gathers as gas prices climb');
    expect(more).toContain('gas');
    expect(more).not.toContain('as');
  });

  it('omits terms already filtered', () => {
    const { primary, more } = filterCandidates("Trump's tariffs hit farmers", [
      'trump',
      'tariffs',
    ]);
    expect(primary).not.toContain('Trump');
    expect(more).not.toContain('tariffs');
    expect(more).toContain('farmers');
  });

  it('keeps candidates in title order and drops noise', () => {
    const { more } = filterCandidates('Fed cuts rates by 25 in a surprise move');
    expect(more).not.toContain('25'); // bare numbers
    expect(more).not.toContain('by'); // function words
    expect(more.indexOf('rates')).toBeLessThan(more.indexOf('surprise'));
  });

  it('returns empty tiers for a title with nothing to offer', () => {
    expect(filterCandidates('It is on the up')).toEqual({ primary: [], more: [] });
  });

  it('caps each tier so the sheet stays a glance', () => {
    const { primary, more } = filterCandidates(
      'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet ' +
        'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
    );
    expect(primary.length).toBeLessThanOrEqual(6);
    expect(more.length).toBeLessThanOrEqual(10);
  });

  it('offers a punctuated term (.NET, C++, C#) as its own candidate, not a bare letter', () => {
    expect(filterCandidates('Announcing .NET 9 for developers').primary).toContain('.NET');
    expect(filterCandidates('Coding in C++ today').primary).toContain('C++');
    expect(filterCandidates('Learning C# basics').primary).toContain('C#');
  });

  it('offers a hashtag in the primary (capitalized) tier, not demoted to More… (Codex P2)', () => {
    // "#Trump" now keeps its leading "#", so the capitalized check has to
    // look past it (as it already does for a leading ".") to still classify
    // the name as capitalized.
    expect(filterCandidates('News about #Trump').primary).toContain('#Trump');
  });

  it('offers a lowercase punctuated term in tier 2 despite being under the length floor (Codex P2)', () => {
    // "c#" is 2 characters, below MIN_CANDIDATE_LENGTH, but the "#" already
    // carries meaning — it's not a stub the way a bare "c" is.
    expect(filterCandidates('learning c# basics').more).toContain('c#');
    // A bare short word with no punctuation is still dropped as a stub.
    expect(filterCandidates('vitamin c is good').more).not.toContain('c');
  });

  it('does not let a compact ellipsis glue onto the next candidate', () => {
    expect(filterCandidates('Wait...really interesting news').more).toContain('really');
  });

  it('does not offer a bare single-character candidate', () => {
    const { primary, more } = filterCandidates('Vitamin C boosts immunity');
    expect(primary).not.toContain('C');
    expect(more).not.toContain('C');
    // The rest of the headline is still offered normally.
    expect(primary).toContain('Vitamin');
  });

  it('only suppresses a single ASCII letter/digit, not a non-ASCII single character', () => {
    // "Я" (Cyrillic, means "I") is a real, complete single-letter word —
    // unlike a bare Latin letter, it must not be dropped as a stub. Scoping
    // the rule to ASCII also means a supplementary-plane character (a UTF-16
    // surrogate pair, e.g. Deseret "𐐀") never needs special-casing either.
    expect(filterCandidates('Кто Я сегодня').primary).toContain('Я');
  });

  // A single Han character ("水" = water) is routinely a complete word in
  // Chinese/Japanese, same concern as above — but it's blocked by a
  // DIFFERENT, pre-existing mechanism (MIN_CANDIDATE_LENGTH in tier 2; CJK
  // never reaches tier 1 at all, since \p{Lu} never matches a Han character).
  // TODO: that's a real, separate bug, not fixed by the ASCII-only rule here.
  it('does not currently offer a single Han character — separate, pre-existing bug', () => {
    expect(filterCandidates('Announcing 水 today').primary).not.toContain('水');
    expect(filterCandidates('Announcing 水 today').more).not.toContain('水');
  });

  it('does not exclude a decimal or number-only punctuation as a candidate (Codex P2)', () => {
    // "3.5" merges into one token now that "." is a word character, so the
    // pre-existing bare-number guard (which only matched an all-digit string)
    // has to also catch a decimal/`+1`-style token that has no letter at all.
    const { more } = filterCandidates('Inflation reaches 3.5 percent');
    expect(more).not.toContain('3.5');
    expect(more).toContain('percent');
  });

  it('has no regex lookbehind — a parse-time SyntaxError on Safari < 16.4 (Codex P1)', () => {
    // This module is in the startup bundle, so a bad lookbehind doesn't fail
    // one match — it stops the module, and the app, from loading at all on an
    // affected iOS Safari. MarkdownText.tsx hit the same constraint first; see
    // its header. Strip comments first — the doc comments here quote the
    // syntax by name to explain why it's avoided.
    const source = readFileSync(new URL('./titleFilter.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/\(\?<[=!]/);
  });
});
