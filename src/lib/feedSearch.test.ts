// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { searchFeeds, resolveFeedByName } from './feedSearch';
import { POPULAR_FEEDS, type PopularFeed } from './popularFeeds';

const names = (feeds: PopularFeed[]) => feeds.map((f) => f.name);

describe('searchFeeds', () => {
  it('returns nothing for an empty query', () => {
    expect(searchFeeds('', POPULAR_FEEDS)).toEqual([]);
    expect(searchFeeds('   ', POPULAR_FEEDS)).toEqual([]);
  });

  it('matches an acronym to the multi-word name ("wsj" → Wall Street Journal)', () => {
    expect(names(searchFeeds('wsj', POPULAR_FEEDS))).toContain('Wall Street Journal');
    expect(names(searchFeeds('WSJ', POPULAR_FEEDS))).toContain('Wall Street Journal');
  });

  it('skips a leading "The" when matching initials ("nyt" → New York Times)', () => {
    expect(names(searchFeeds('nyt', POPULAR_FEEDS))).toContain('New York Times');
  });

  it('matches a longer acronym ("scmp" → South China Morning Post)', () => {
    expect(names(searchFeeds('scmp', POPULAR_FEEDS))).toContain('South China Morning Post');
  });

  it('ignores punctuation/spacing in the query ("w.s.j" → Wall Street Journal)', () => {
    expect(names(searchFeeds('w.s.j', POPULAR_FEEDS))).toContain('Wall Street Journal');
  });

  it('splits camel-case and digit boundaries for acronyms', () => {
    // Names that pack words together via case/digit rather than spaces must
    // still yield useful initials.
    const feeds: PopularFeed[] = [
      { name: 'freeCodeCamp', feedUrl: 'https://a.example/feed', category: 'Programming' },
      { name: '3Blue1Brown', feedUrl: 'https://b.example/feed', category: 'YouTube' },
      { name: '9to5Mac', feedUrl: 'https://c.example/feed', category: 'Technology' },
    ];
    expect(names(searchFeeds('fcc', feeds))).toEqual(['freeCodeCamp']);
    expect(names(searchFeeds('3b1b', feeds))).toEqual(['3Blue1Brown']);
    // "9to5Mac" → initials "9t5m"; "9m" still matches as a subsequence.
    expect(names(searchFeeds('9m', feeds))).toEqual(['9to5Mac']);
  });

  it('still does substring matching on the name', () => {
    expect(names(searchFeeds('guardian', POPULAR_FEEDS))).toContain('The Guardian');
  });

  it('ranks substring matches above acronym-only matches', () => {
    const feeds: PopularFeed[] = [
      { name: 'Wall Street Journal', feedUrl: 'https://a.example/feed', category: 'Business' },
      { name: 'Weekly Sports Journal', feedUrl: 'https://wsj-sports.example/feed', category: 'Sports' },
    ];
    // "wsj" is an acronym for both names, but only the second feed's URL
    // contains the substring "wsj" — so it must rank first despite coming later
    // in the catalog.
    expect(names(searchFeeds('wsj', feeds))).toEqual([
      'Weekly Sports Journal',
      'Wall Street Journal',
    ]);
  });

  it('keeps single-character queries substring-only (no acronym explosion)', () => {
    // A lone "j" must not subsequence-match "Wall Street Journal" by its third
    // initial; with the 2-char gate the only hit here is the feed whose name
    // literally contains "j". (The acronym path is disabled below 2 chars.)
    const feeds: PopularFeed[] = [
      { name: 'Hacker News', feedUrl: 'https://a.example/feed', category: 'Technology' },
      { name: 'Wall Street Journal', feedUrl: 'https://b.example/feed', category: 'Business' },
    ];
    expect(names(searchFeeds('j', feeds))).toEqual(['Wall Street Journal']);
  });

  it('matches a 2-letter acronym that appears nowhere as a substring', () => {
    // "wj" is not a substring of the name/url/category, but it is a subsequence
    // of the "wsj" initials — proving acronym matching goes beyond substring.
    const feeds: PopularFeed[] = [
      { name: 'Wall Street Journal', feedUrl: 'https://a.example/feed', category: 'Business' },
    ];
    expect(names(searchFeeds('wj', feeds))).toEqual(['Wall Street Journal']);
  });

  it('requires the full acronym subsequence (a wrong letter drops the match)', () => {
    // "wsz" is not a subsequence of "wsj" initials.
    expect(names(searchFeeds('wsz', POPULAR_FEEDS))).not.toContain('Wall Street Journal');
  });
});

describe('resolveFeedByName', () => {
  it('returns null for an empty query', () => {
    expect(resolveFeedByName('', POPULAR_FEEDS)).toBeNull();
  });

  it('resolves an exact name, including dotted names', () => {
    const feeds: PopularFeed[] = [
      { name: 'The A.V. Club', feedUrl: 'https://avclub.example/rss', category: 'Culture' },
      { name: 'Inc.', feedUrl: 'https://inc.example/rss', category: 'Business' },
    ];
    expect(resolveFeedByName('the a.v. club', feeds)?.name).toBe('The A.V. Club');
    expect(resolveFeedByName('inc.', feeds)?.name).toBe('Inc.');
  });

  it('resolves an exact, unique acronym', () => {
    const feeds: PopularFeed[] = [
      { name: 'Wall Street Journal', feedUrl: 'https://wsj.example/feed', category: 'News' },
      { name: 'freeCodeCamp', feedUrl: 'https://fcc.example/feed', category: 'Programming' },
    ];
    expect(resolveFeedByName('wsj', feeds)?.name).toBe('Wall Street Journal');
    expect(resolveFeedByName('fcc', feeds)?.name).toBe('freeCodeCamp');
  });

  it('does NOT resolve a partial name, only the exact name/acronym', () => {
    const feeds: PopularFeed[] = [
      { name: 'The Guardian', feedUrl: 'https://g.example/rss', category: 'News' },
    ];
    // "guardian" is a substring of the name but neither the exact name nor the
    // acronym ("tg"), so it isn't auto-resolved — the user picks it.
    expect(resolveFeedByName('guardian', feeds)).toBeNull();
    expect(resolveFeedByName('the guardian', feeds)?.name).toBe('The Guardian');
  });

  it('does NOT resolve URL/host or category hits', () => {
    const feeds: PopularFeed[] = [
      // Single URL hit and single category hit — searchFeeds would surface each,
      // but neither is a name/acronym, so submit must not auto-subscribe them.
      { name: 'OpenAI News', feedUrl: 'https://openai.com/feed', category: 'AI' },
      { name: 'NHS England News', feedUrl: 'https://nhs.example/feed', category: 'Health' },
    ];
    expect(resolveFeedByName('openai.com', feeds)).toBeNull();
    expect(resolveFeedByName('health', feeds)).toBeNull();
  });

  it('does not resolve when several feeds share the same acronym', () => {
    const feeds: PopularFeed[] = [
      { name: 'Big Co', feedUrl: 'https://a.example/feed', category: 'News' },
      { name: 'Bytes Code', feedUrl: 'https://b.example/feed', category: 'Programming' },
    ];
    // Both have initials "bc" — ambiguous, so resolve to nothing.
    expect(resolveFeedByName('bc', feeds)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    const feeds: PopularFeed[] = [
      { name: 'CBS News', feedUrl: 'https://cbs.example/feed', category: 'News' },
    ];
    expect(resolveFeedByName('zzz', feeds)).toBeNull();
  });

  // Lock the real-catalog behavior: distinctive identifiers resolve; partial
  // names, URLs/hosts, and broad topic/country-code browse queries do not.
  it('resolves distinctive identifiers against the real catalog', () => {
    expect(resolveFeedByName('wsj', POPULAR_FEEDS)?.name).toBe('Wall Street Journal');
    expect(resolveFeedByName('nyt', POPULAR_FEEDS)?.name).toBe('New York Times');
    expect(resolveFeedByName('scmp', POPULAR_FEEDS)?.name).toBe('South China Morning Post');
  });

  it('does not auto-resolve partials/URLs/topics against the real catalog', () => {
    for (const q of [
      'guardian', 'programming', 'health', 'ai', 'au', 'uk', 'science', 'news',
      'openai.com', 'theguardian.com', 'xkcd.com',
    ]) {
      expect(resolveFeedByName(q, POPULAR_FEEDS)).toBeNull();
    }
  });
});
