import { describe, expect, it } from 'vitest';
import {
  articleSourceDomain,
  formatAge,
  formatDisplayDomain,
  formatItemMetaTail,
  isSafeHttpUrl,
} from './itemMeta';

describe('isSafeHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isSafeHttpUrl('http://example.com/x')).toBe(true);
    expect(isSafeHttpUrl('https://example.com/x')).toBe(true);
  });

  it('rejects javascript: and data: schemes', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(
      false,
    );
    expect(isSafeHttpUrl('vbscript:msgbox(1)')).toBe(false);
  });

  it('rejects missing, relative, or malformed urls', () => {
    expect(isSafeHttpUrl(undefined)).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl('/relative/path')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });
});

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

  it('rolls day 364 over to "1y" instead of "0y"', () => {
    // 364 days is week 52 (past the week bucket) but floors to year 0.
    expect(formatAge(now - 364 * 24 * 60 * 60_000, now)).toBe('1y');
    expect(formatAge(now - 363 * 24 * 60 * 60_000, now)).toBe('51w');
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

  it('does not trim a bare multi-part-ccTLD host down to its public suffix', () => {
    // Regression: a 3-label host (after www stripping) fell through to the
    // two-label trim and rendered as "com.au".
    expect(formatDisplayDomain('https://www.smh.com.au/politics/x')).toBe('smh.com.au');
    expect(formatDisplayDomain('https://bbc.co.uk/news')).toBe('bbc.co.uk');
    expect(formatDisplayDomain('https://data.gov.au/dataset')).toBe('data.gov.au');
  });

  it('returns empty for missing or unparseable URLs', () => {
    expect(formatDisplayDomain(null)).toBe('');
    expect(formatDisplayDomain('not a url')).toBe('');
  });

  it('keeps the owner label on compound eTLDs instead of trimming to the public suffix', () => {
    // Regression: a hand-rolled copy of the trimmer here lacked format.ts's
    // compound-eTLD list, so user-subdomain hosts lost their owner — every
    // github.io/substack author rendered (and compared) as the bare suffix.
    expect(formatDisplayDomain('https://jasoneckert.github.io/post')).toBe(
      'jasoneckert.github.io',
    );
    expect(formatDisplayDomain('https://author.substack.com/p/x')).toBe(
      'author.substack.com',
    );
  });

  it('covers the fuller ccTLD second-level set (or.kr, ne.jp, edu.au)', () => {
    expect(formatDisplayDomain('https://www.kobis.or.kr/x')).toBe('kobis.or.kr');
    expect(formatDisplayDomain('https://foo.ne.jp/x')).toBe('foo.ne.jp');
    expect(formatDisplayDomain('https://www.sydney.edu.au/x')).toBe('sydney.edu.au');
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

  it('distinguishes two publishers under the same multi-part ccTLD', () => {
    // Regression: both trimmed to "com.au", compared equal, and the genuinely
    // different publisher domain was suppressed.
    expect(
      articleSourceDomain('https://www.theage.com.au/story', 'https://www.smh.com.au'),
    ).toBe('theage.com.au');
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
