// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { discoverFromHtml, redditFeedFor } from './discover.ts';

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
