// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  discoverFromHtml,
  discoverIconFromHtml,
  googleNewsFeedFor,
  homePageUrl,
  redditFeedFor,
} from './discover.ts';

describe('discoverFromHtml — <link> autodiscovery', () => {
  const html = `
    <html><head>
      <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="https://cdn.example.com/atom">
      <link rel="alternate" type="application/feed+json" href="feed.json">
      <link rel="stylesheet" href="/style.css">
      <link rel="alternate" type="text/html" href="/amp">
    </head></html>`;

  const found = discoverFromHtml(html, 'https://example.com/blog/');

  it('finds RSS, Atom and JSON feed links, absolutized', () => {
    const urls = found.map((f) => f.url);
    expect(urls).toContain('https://example.com/feed.xml');
    expect(urls).toContain('https://cdn.example.com/atom');
    expect(urls).toContain('https://example.com/blog/feed.json');
  });

  it('ignores non-feed and non-alternate links', () => {
    const urls = found.map((f) => f.url);
    expect(urls).not.toContain('https://example.com/style.css');
    expect(urls).not.toContain('https://example.com/amp');
  });

  it('keeps the <link title> as a label', () => {
    const rss = found.find((f) => f.url === 'https://example.com/feed.xml');
    expect(rss?.title).toBe('RSS');
    expect(rss?.type).toBe('application/rss+xml');
  });

  it('appends common path fallbacks', () => {
    const urls = found.map((f) => f.url);
    expect(urls).toContain('https://example.com/feed');
    expect(urls).toContain('https://example.com/rss');
    expect(urls).toContain('https://example.com/atom.xml');
    expect(urls).toContain('https://example.com/feed.json');
  });

  it('de-duplicates repeated candidates', () => {
    const urls = found.map((f) => f.url);
    const unique = new Set(urls);
    expect(unique.size).toBe(urls.length);
  });
});

describe('redditFeedFor', () => {
  it('derives a subreddit feed', () => {
    expect(redditFeedFor('https://www.reddit.com/r/programming')).toBe(
      'https://www.reddit.com/r/programming.rss',
    );
    // trailing slash tolerated
    expect(redditFeedFor('https://reddit.com/r/programming/')).toBe(
      'https://www.reddit.com/r/programming.rss',
    );
  });

  it('derives sorted subreddit feeds', () => {
    expect(redditFeedFor('https://www.reddit.com/r/news/top')).toBe(
      'https://www.reddit.com/r/news/top.rss',
    );
    expect(redditFeedFor('https://old.reddit.com/r/news/new')).toBe(
      'https://www.reddit.com/r/news/new.rss',
    );
    expect(redditFeedFor('https://www.reddit.com/r/news/hot')).toBe(
      'https://www.reddit.com/r/news/hot.rss',
    );
    expect(redditFeedFor('https://www.reddit.com/r/news/rising')).toBe(
      'https://www.reddit.com/r/news/rising.rss',
    );
  });

  it('derives a subreddit search feed with restrict_sr', () => {
    const out = redditFeedFor(
      'https://www.reddit.com/r/rust/search?q=async&sort=new',
    );
    expect(out).toContain('https://www.reddit.com/r/rust/search.rss?');
    expect(out).toContain('q=async');
    expect(out).toContain('restrict_sr=1');
  });

  it('derives a multireddit feed', () => {
    expect(
      redditFeedFor('https://www.reddit.com/user/alice/m/tech'),
    ).toBe('https://www.reddit.com/user/alice/m/tech.rss');
  });

  it('derives a user posts feed (user and u aliases)', () => {
    expect(redditFeedFor('https://www.reddit.com/user/bob')).toBe(
      'https://www.reddit.com/user/bob.rss',
    );
    expect(redditFeedFor('https://www.reddit.com/u/bob')).toBe(
      'https://www.reddit.com/user/bob.rss',
    );
  });

  it('derives the logged-out home and popular/all feeds', () => {
    expect(redditFeedFor('https://www.reddit.com/')).toBe(
      'https://www.reddit.com/.rss',
    );
    expect(redditFeedFor('https://www.reddit.com/r/popular')).toBe(
      'https://www.reddit.com/r/popular.rss',
    );
    expect(redditFeedFor('https://www.reddit.com/r/all')).toBe(
      'https://www.reddit.com/r/all.rss',
    );
  });

  it('normalizes an already-.rss URL', () => {
    expect(redditFeedFor('https://old.reddit.com/r/programming.rss')).toBe(
      'https://www.reddit.com/r/programming.rss',
    );
  });

  it('returns null for non-Reddit URLs', () => {
    expect(redditFeedFor('https://example.com/r/programming')).toBeNull();
    expect(redditFeedFor('not a url')).toBeNull();
  });

  it('is exercised by discoverFromHtml for Reddit pages', () => {
    const found = discoverFromHtml('<html></html>', 'https://www.reddit.com/r/programming');
    expect(found[0].url).toBe('https://www.reddit.com/r/programming.rss');
  });
});

describe('homePageUrl', () => {
  it('returns the origin root for a deep article link', () => {
    expect(
      homePageUrl(
        'https://www.skysports.com/football/news/12098/13556636/world-cup-2026-bracket',
      ),
    ).toBe('https://www.skysports.com/');
  });

  it('preserves the host (incl. subdomain) and scheme', () => {
    expect(homePageUrl('http://blog.example.co.uk/2026/06/post')).toBe(
      'http://blog.example.co.uk/',
    );
  });

  it('returns null when the URL is already the home page', () => {
    expect(homePageUrl('https://example.com')).toBeNull();
    expect(homePageUrl('https://example.com/')).toBeNull();
  });

  it('still probes the home page when only a query string differs', () => {
    expect(homePageUrl('https://example.com/?ref=twitter')).toBe('https://example.com/');
  });

  it('returns null for non-http(s) and unparseable URLs', () => {
    expect(homePageUrl('ftp://example.com/file')).toBeNull();
    expect(homePageUrl('not a url')).toBeNull();
  });
});

describe('googleNewsFeedFor', () => {
  it('builds a site: search feed for the page domain', () => {
    const out = googleNewsFeedFor(
      'https://www.skysports.com/football/news/12098/13556636/world-cup-2026-bracket',
    );
    expect(out).not.toBeNull();
    const u = new URL(out!);
    expect(u.origin + u.pathname).toBe('https://news.google.com/rss/search');
    // www. is stripped so the site: filter matches the registrable domain.
    expect(u.searchParams.get('q')).toBe('site:skysports.com');
    expect(u.searchParams.get('hl')).toBe('en-US');
    expect(u.searchParams.get('ceid')).toBe('US:en');
  });

  it('honors a custom locale', () => {
    const out = googleNewsFeedFor('https://example.de/artikel', {
      hl: 'de',
      gl: 'DE',
      ceid: 'DE:de',
    });
    const u = new URL(out!);
    expect(u.searchParams.get('hl')).toBe('de');
    expect(u.searchParams.get('ceid')).toBe('DE:de');
  });

  it('never aggregates Google News over itself', () => {
    expect(googleNewsFeedFor('https://news.google.com/foo')).toBeNull();
    expect(googleNewsFeedFor('https://www.google.com/search?q=x')).toBeNull();
  });

  it('returns null for hostless, non-http(s), and unparseable URLs', () => {
    expect(googleNewsFeedFor('http://localhost/page')).toBeNull();
    expect(googleNewsFeedFor('ftp://example.com/file')).toBeNull();
    expect(googleNewsFeedFor('not a url')).toBeNull();
  });
});

describe('discoverIconFromHtml', () => {
  const base = 'https://ft.com/';

  it('finds <link rel="icon"> and absolutizes a relative href', () => {
    const html = '<html><head><link rel="icon" href="/brand/ft.png"></head></html>';
    expect(discoverIconFromHtml(html, base)).toEqual(['https://ft.com/brand/ft.png']);
  });

  it('matches rel="shortcut icon" (the icon token)', () => {
    const html = '<head><link rel="shortcut icon" href="https://cdn.ft.com/f.ico"></head>';
    expect(discoverIconFromHtml(html, base)).toEqual(['https://cdn.ft.com/f.ico']);
  });

  it('orders the standard icon ahead of an apple-touch-icon', () => {
    const html = `<head>
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="icon" href="/std.png">
    </head>`;
    expect(discoverIconFromHtml(html, base)).toEqual([
      'https://ft.com/std.png',
      'https://ft.com/apple.png',
    ]);
  });

  it('falls back to apple-touch-icon when no standard icon is present', () => {
    const html = '<head><link rel="apple-touch-icon" href="/apple.png"></head>';
    expect(discoverIconFromHtml(html, base)).toEqual(['https://ft.com/apple.png']);
  });

  it('orders mask-icon last', () => {
    const html = `<head>
      <link rel="mask-icon" href="/mask.svg" color="#000">
      <link rel="apple-touch-icon" href="/apple.png">
    </head>`;
    expect(discoverIconFromHtml(html, base)).toEqual([
      'https://ft.com/apple.png',
      'https://ft.com/mask.svg',
    ]);
  });

  it('keeps every icon in a tier, in document order', () => {
    const html = `<head>
      <link rel="icon" href="/first.png">
      <link rel="icon" href="/second.png">
    </head>`;
    expect(discoverIconFromHtml(html, base)).toEqual([
      'https://ft.com/first.png',
      'https://ft.com/second.png',
    ]);
  });

  it('ignores <link> tags outside the <head>', () => {
    const html =
      '<head><title>x</title></head><body><link rel="icon" href="/body.png"></body>';
    expect(discoverIconFromHtml(html, base)).toEqual([]);
  });

  it('returns [] when no icon link is advertised', () => {
    const html = '<head><link rel="stylesheet" href="/s.css"><link rel="alternate" href="/f"></head>';
    expect(discoverIconFromHtml(html, base)).toEqual([]);
  });

  it('ignores an icon link with no href', () => {
    expect(discoverIconFromHtml('<head><link rel="icon"></head>', base)).toEqual([]);
  });
});
