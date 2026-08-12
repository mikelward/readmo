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
    // A hyphen is a token boundary, so this is the word "trumped" — an
    // inflection the add-only rule deliberately doesn't reach.
    expect(matches('The trumped-up charges', ['trump'])).toBe(false);
    expect(matches('Class action filed', ['as'])).toBe(false);
  });

  it('matches through a possessive without a possessive rule', () => {
    expect(matches("Trump's tariffs hit farmers", ['trump'])).toBe(true);
  });

  it('matches the simple plural of a filter (add-only)', () => {
    expect(matches('New tariffs announced', ['tariff'])).toBe(true);
    expect(matches('New taxes announced', ['tax'])).toBe(true);
  });

  // filterCandidates OFFERS this stem, so the matcher has to reach it: picking
  // `company` off a "companies" headline must filter the row it came from.
  it('matches an -ies plural from a consonant + y filter', () => {
    expect(matches('Several companies withdrew', ['company'])).toBe(true);
    expect(matches('Both countries agreed', ['country'])).toBe(true);
    // Still add-only — the -ies form is longer, so it cannot overreach, and a
    // vowel + y word never grows one.
    expect(matches('It took three days', ['day'])).toBe(true);
    expect(matches('One company withdrew', ['companies'])).toBe(false);
  });

  // The whole reason the matcher never strips: stripping turns `news` into
  // `new` and `US` into `us`, and each would swallow most of a feed.
  it('never strips a suffix to match a shorter word', () => {
    expect(matches('A new dawn for cycling', ['news'])).toBe(false);
    expect(matches('It is up to us all', ['USA'])).toBe(false);
    expect(matches('One tariff was lifted', ['tariffs'])).toBe(false);
  });

  // Known limitation of case-insensitive matching, recorded rather than fixed:
  // a short all-caps acronym collides with the ordinary word it folds to. The
  // menu can't lead anyone into it (`us` is a stopword, so it's never offered),
  // so it takes typing `US` by hand — and removing the entry undoes it.
  it('folds a short acronym onto its lowercase homograph', () => {
    expect(matches('It is up to us now', ['US'])).toBe(true);
  });

  it('matches a multi-word entry only as a contiguous run', () => {
    expect(matches('The trade war escalates', ['trade war'])).toBe(true);
    expect(matches('A war over trade rules', ['trade war'])).toBe(false);
  });

  it('applies the plural allowance to a phrase head noun only', () => {
    expect(matches('The trade wars escalate', ['trade war'])).toBe(true);
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

  it('offers the stem beside a plural candidate, right after it', () => {
    const { more } = filterCandidates('New tariffs hit farmers');
    expect(more[more.indexOf('tariffs') + 1]).toBe('tariff');
    expect(more[more.indexOf('farmers') + 1]).toBe('farmer');
  });

  it('offers a -ies stem as -y', () => {
    const { more } = filterCandidates('Several companies withdrew');
    expect(more[more.indexOf('companies') + 1]).toBe('company');
  });

  it('declines a stem that would leave a stub or a non-word', () => {
    const { more } = filterCandidates('The press gathers as gas prices climb');
    expect(more).toContain('press');
    expect(more).not.toContain('pres'); // double-s is not a plural
    expect(more).not.toContain('ga'); // stem below the length floor
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
