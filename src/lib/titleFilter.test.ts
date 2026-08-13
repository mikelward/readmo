// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
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
});
