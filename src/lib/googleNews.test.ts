import { describe, it, expect } from 'vitest';
import { isGoogleNewsFeedUrl } from './googleNews';

// Kept in sync with supabase/functions/_shared/googleNews.test.ts.
describe('isGoogleNewsFeedUrl', () => {
  it('matches Google News RSS feeds', () => {
    expect(
      isGoogleNewsFeedUrl(
        'https://news.google.com/rss/search?q=site:skynews.com.au&hl=en-AU',
      ),
    ).toBe(true);
    expect(isGoogleNewsFeedUrl('https://news.google.com/rss')).toBe(true);
    expect(isGoogleNewsFeedUrl('https://www.news.google.com/rss/headlines')).toBe(true);
    expect(isGoogleNewsFeedUrl('HTTPS://NEWS.GOOGLE.COM/RSS/search?q=x')).toBe(true);
  });

  it('does not match non-RSS or lookalike hosts', () => {
    expect(isGoogleNewsFeedUrl('https://news.google.com/')).toBe(false);
    expect(isGoogleNewsFeedUrl('https://news.google.com/rssfoo')).toBe(false);
    expect(isGoogleNewsFeedUrl('https://www.google.com/rss')).toBe(false);
    expect(isGoogleNewsFeedUrl('https://news.google.com.evil.example/rss')).toBe(false);
  });

  it('rejects non-http(s) and unparseable input', () => {
    expect(isGoogleNewsFeedUrl('ftp://news.google.com/rss')).toBe(false);
    expect(isGoogleNewsFeedUrl('not a url')).toBe(false);
    expect(isGoogleNewsFeedUrl('')).toBe(false);
  });
});
