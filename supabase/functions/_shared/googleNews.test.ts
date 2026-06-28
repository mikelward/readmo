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

  it('canonicalizes WHATWG-normalized scheme/slash variants to the real host', () => {
    // `discover`'s authoritative gate: `new URL()` folds these cosmetic forms to
    // host `news.google.com`, so a caller can't dodge the allowlist by writing
    // the scheme without `//`, with a single slash, with backslashes, or with an
    // explicit port — nor with control chars, percent-encoded host, or a bad
    // escape. This is the one place the Google News check has to be right (real
    // URL parsing), which is exactly why we don't try to replicate it in SQL.
    expect(isGoogleNewsFeedUrl('https:news.google.com/rss')).toBe(true);
    expect(isGoogleNewsFeedUrl('https:/news.google.com/rss')).toBe(true);
    expect(isGoogleNewsFeedUrl('https:\\\\news.google.com\\rss')).toBe(true);
    expect(isGoogleNewsFeedUrl('https://news.google.com:443/rss/search?q=x')).toBe(true);
    // ASCII tab / CR / LF are stripped before parsing — even inside the host.
    expect(isGoogleNewsFeedUrl('https://news.google.com\t/rss/search?q=x')).toBe(true);
    expect(isGoogleNewsFeedUrl('https://news.\tgoogle.com/rss')).toBe(true);
    expect(isGoogleNewsFeedUrl('https://news.google.com\n/rss')).toBe(true);
    // Leading C0 controls (e.g. NUL, SOH) are trimmed before parsing.
    expect(
      isGoogleNewsFeedUrl(`${String.fromCharCode(1)}https://news.google.com/rss/search?q=x`),
    ).toBe(true);
    expect(
      isGoogleNewsFeedUrl(`${String.fromCharCode(0)}https://news.google.com/rss`),
    ).toBe(true);
    // Percent-encoded host, even alongside an unrelated bad escape (`%ff`) in the
    // fragment — `new URL()` decodes the host and drops the fragment from the
    // fetch, so it still resolves to news.google.com.
    expect(
      isGoogleNewsFeedUrl('https://%6eews.google.com/rss/search?q=site:example.com#%ff'),
    ).toBe(true);
    // A leading control followed by a space (the space only becomes leading once
    // the control is stripped) — WHATWG trims leading C0-controls-and-space.
    expect(
      isGoogleNewsFeedUrl(`${String.fromCharCode(1)} https://news.google.com/rss/search?q=x`),
    ).toBe(true);
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
