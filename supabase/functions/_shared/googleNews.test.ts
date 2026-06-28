// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isGoogleNewsFeedUrl } from './googleNews.ts';

describe('isGoogleNewsFeedUrl', () => {
  it('matches Google News RSS search/topic/section feeds', () => {
    expect(
      isGoogleNewsFeedUrl(
        'https://news.google.com/rss/search?q=site:skynews.com.au+when:7d&hl=en-AU&gl=AU&ceid=AU:en',
      ),
    ).toBe(true);
    expect(isGoogleNewsFeedUrl('https://news.google.com/rss')).toBe(true);
    expect(
      isGoogleNewsFeedUrl('https://news.google.com/rss/topics/SOMETOKEN?hl=en-US'),
    ).toBe(true);
    expect(isGoogleNewsFeedUrl('https://www.news.google.com/rss/headlines')).toBe(true);
    expect(isGoogleNewsFeedUrl('HTTPS://NEWS.GOOGLE.COM/RSS/search?q=x')).toBe(true);
  });

  it('does not match non-RSS Google News pages', () => {
    expect(isGoogleNewsFeedUrl('https://news.google.com/')).toBe(false);
    expect(isGoogleNewsFeedUrl('https://news.google.com/home?hl=en-US')).toBe(false);
    // A path that merely starts with the letters "rss" but isn't the feed root.
    expect(isGoogleNewsFeedUrl('https://news.google.com/rssfoo')).toBe(false);
  });

  it('does not match other Google or unrelated hosts', () => {
    expect(isGoogleNewsFeedUrl('https://www.google.com/rss')).toBe(false);
    expect(isGoogleNewsFeedUrl('https://google.com/rss/search?q=x')).toBe(false);
    expect(isGoogleNewsFeedUrl('https://example.com/rss')).toBe(false);
    // A lookalike host must not slip through a naive "contains" check.
    expect(isGoogleNewsFeedUrl('https://news.google.com.evil.example/rss')).toBe(false);
  });

  it('rejects non-http(s) schemes and unparseable input', () => {
    expect(isGoogleNewsFeedUrl('ftp://news.google.com/rss')).toBe(false);
    expect(isGoogleNewsFeedUrl('not a url')).toBe(false);
    expect(isGoogleNewsFeedUrl('')).toBe(false);
  });
});
