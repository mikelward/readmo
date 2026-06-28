import { describe, expect, it } from 'vitest';
import {
  articleSourceDomain,
  formatAge,
  formatDisplayDomain,
  formatItemMetaTail,
} from './itemMeta';

describe('formatAge', () => {
  const now = 1_700_000_000_000;
  it('formats sub-minute, minute, hour, day, week, and year buckets', () => {
    expect(formatAge(now, now)).toBe('just now');
    expect(formatAge(now - 5 * 60_000, now)).toBe('5m');
    expect(formatAge(now - 3 * 60 * 60_000, now)).toBe('3h');
    expect(formatAge(now - 2 * 24 * 60 * 60_000, now)).toBe('2d');
    expect(formatAge(now - 3 * 7 * 24 * 60 * 60_000, now)).toBe('3w');
    expect(formatAge(now - 400 * 24 * 60 * 60_000, now)).toBe('1y');
  });

  it('clamps future timestamps to "just now"', () => {
    expect(formatAge(now + 10_000, now)).toBe('just now');
  });
});

describe('formatDisplayDomain', () => {
  it('strips www and trims to the registrable domain', () => {
    expect(formatDisplayDomain('https://www.theverge.com/rss')).toBe('theverge.com');
    expect(formatDisplayDomain('https://old.reddit.com/r/x')).toBe('reddit.com');
  });

  it('keeps the extra label for multi-part ccTLDs', () => {
    expect(formatDisplayDomain('https://news.bbc.co.uk/story')).toBe('bbc.co.uk');
  });

  it('returns empty for missing or unparseable URLs', () => {
    expect(formatDisplayDomain(null)).toBe('');
    expect(formatDisplayDomain('not a url')).toBe('');
  });
});

describe('articleSourceDomain', () => {
  it('returns the article domain when it differs from the feed site', () => {
    expect(
      articleSourceDomain('https://www.thedrive.com/news/x', 'https://news.ycombinator.com'),
    ).toBe('thedrive.com');
  });

  it('returns empty when the article lives on the feed\'s own site', () => {
    expect(
      articleSourceDomain('https://www.theverge.com/2026/x', 'https://www.theverge.com'),
    ).toBe('');
  });

  it('compares on the registrable domain, ignoring subdomains', () => {
    expect(
      articleSourceDomain('https://blog.example.com/post', 'https://www.example.com'),
    ).toBe('');
  });

  it('returns empty when the article URL is missing or unparseable', () => {
    expect(articleSourceDomain(null, 'https://news.ycombinator.com')).toBe('');
    expect(articleSourceDomain('mailto:x@y.com', 'https://news.ycombinator.com')).toBe('');
  });

  it('still surfaces the domain when the feed has no comparable site URL', () => {
    expect(articleSourceDomain('https://github.com/a/b', null)).toBe('github.com');
  });
});

describe('formatItemMetaTail', () => {
  const now = 1_700_000_000_000;

  it('joins source, age, and author with bullets', () => {
    expect(
      formatItemMetaTail({
        source: 'The Verge',
        publishedAt: now - 3 * 60 * 60_000,
        author: 'Jane Doe',
        now,
      }),
    ).toBe('The Verge · 3h · Jane Doe');
  });

  it('inserts the domain between source and age when provided', () => {
    expect(
      formatItemMetaTail({
        source: 'Hacker News',
        domain: 'thedrive.com',
        publishedAt: now - 60 * 60_000,
        author: null,
        now,
      }),
    ).toBe('Hacker News · thedrive.com · 1h');
  });

  it('omits empty source, domain, and author segments', () => {
    expect(
      formatItemMetaTail({
        source: '',
        domain: '',
        publishedAt: now,
        author: null,
        now,
      }),
    ).toBe('just now');
  });
});
