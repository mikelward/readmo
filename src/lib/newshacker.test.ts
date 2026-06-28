import { describe, expect, it } from 'vitest';
import {
  hackerNewsItemId,
  isHackerNewsFeed,
  newshackerItemUrl,
  newshackerUrlForItem,
} from './newshacker';
import type { Feed, Item } from './types';

function feed(over: Partial<Feed> = {}): Feed {
  return {
    id: 'f',
    url: 'https://news.ycombinator.com/rss',
    siteUrl: 'https://news.ycombinator.com',
    title: 'Hacker News',
    faviconUrl: null,
    errorCount: 0,
    lastError: null,
    parked: false,
    ...over,
  };
}

function item(over: Partial<Item> = {}): Item {
  return {
    id: 'i',
    feedId: 'f',
    guid: 'https://news.ycombinator.com/item?id=42662903',
    url: 'https://example.com/the-article',
    commentsUrl: null,
    title: 'A post',
    author: null,
    publishedAt: 0,
    contentHtml: '',
    summary: null,
    fullContentHtml: null,
    enclosures: [],
    ...over,
  };
}

describe('isHackerNewsFeed', () => {
  it('recognizes the official HN feed by site/feed host', () => {
    expect(isHackerNewsFeed(feed())).toBe(true);
    expect(
      isHackerNewsFeed(feed({ siteUrl: 'https://news.ycombinator.com/' })),
    ).toBe(true);
    // www. is stripped before matching.
    expect(
      isHackerNewsFeed(feed({ siteUrl: 'https://www.news.ycombinator.com' })),
    ).toBe(true);
  });

  it('recognizes hnrss.org feeds (the common third-party HN generator)', () => {
    expect(
      isHackerNewsFeed(
        feed({ url: 'https://hnrss.org/frontpage', siteUrl: 'https://hnrss.org' }),
      ),
    ).toBe(true);
  });

  it('matches when only the feed url (not the site url) is on an HN host', () => {
    expect(
      isHackerNewsFeed(feed({ url: 'https://hnrss.org/newest', siteUrl: null })),
    ).toBe(true);
  });

  it('rejects non–Hacker News feeds', () => {
    expect(
      isHackerNewsFeed(
        feed({ url: 'https://www.theverge.com/rss', siteUrl: 'https://www.theverge.com' }),
      ),
    ).toBe(false);
    // A lookalike host is not HN.
    expect(
      isHackerNewsFeed(feed({ url: 'https://evil-ycombinator.com/rss', siteUrl: null })),
    ).toBe(false);
  });

  it('does not throw on an unparseable url', () => {
    expect(isHackerNewsFeed(feed({ url: 'not a url', siteUrl: null }))).toBe(false);
  });
});

describe('hackerNewsItemId', () => {
  it('reads the id from the guid (HN/hnrss set it to the comments URL)', () => {
    expect(hackerNewsItemId(item())).toBe('42662903');
  });

  it('falls back to the url when the guid is not an HN item link', () => {
    expect(
      hackerNewsItemId(
        item({ guid: 'tag:example,2024:1', url: 'https://news.ycombinator.com/item?id=123' }),
      ),
    ).toBe('123');
  });

  it('reads the id from the description HTML for the official HN feed (no comments field)', () => {
    // news.ycombinator.com/rss puts the article in <link> and the discussion
    // only in <comments>, which the parser drops — but the sanitized
    // <description> we store as contentHtml is the "Comments" link.
    expect(
      hackerNewsItemId(
        item({
          guid: 'https://example.com/the-article',
          url: 'https://example.com/the-article',
          contentHtml:
            '<a href="https://news.ycombinator.com/item?id=44390000" rel="noopener">Comments</a>',
        }),
      ),
    ).toBe('44390000');
  });

  it('reads the structured commentsUrl first (the RSS <comments> / Atom replies link)', () => {
    expect(
      hackerNewsItemId(
        item({
          commentsUrl: 'https://news.ycombinator.com/item?id=42662903',
          // The article link / guid are not HN — commentsUrl is the only source.
          guid: 'https://example.com/the-article',
          url: 'https://example.com/the-article',
        }),
      ),
    ).toBe('42662903');
  });

  it('prefers commentsUrl over the guid, url and description HTML', () => {
    expect(
      hackerNewsItemId(
        item({
          commentsUrl: 'https://news.ycombinator.com/item?id=1',
          guid: 'https://news.ycombinator.com/item?id=2',
          url: 'https://news.ycombinator.com/item?id=3',
          contentHtml: '<a href="https://news.ycombinator.com/item?id=4">Comments</a>',
        }),
      ),
    ).toBe('1');
  });

  it('prefers the guid over the description HTML', () => {
    expect(
      hackerNewsItemId(
        item({
          guid: 'https://news.ycombinator.com/item?id=111',
          url: 'https://example.com/a',
          contentHtml:
            '<a href="https://news.ycombinator.com/item?id=999">Comments</a>',
        }),
      ),
    ).toBe('111');
  });

  it('returns null when no field and no stored HTML yields an HN item link', () => {
    expect(
      hackerNewsItemId(
        item({
          guid: 'guid-1',
          url: 'https://example.com/post',
          contentHtml: '<p>Just an article body with no HN link.</p>',
        }),
      ),
    ).toBeNull();
  });

  it('rejects non-numeric or missing ids and other HN paths', () => {
    expect(
      hackerNewsItemId(item({ guid: 'https://news.ycombinator.com/item?id=abc', url: '' })),
    ).toBeNull();
    expect(
      hackerNewsItemId(item({ guid: 'https://news.ycombinator.com/item', url: '' })),
    ).toBeNull();
    expect(
      hackerNewsItemId(item({ guid: 'https://news.ycombinator.com/newest', url: '' })),
    ).toBeNull();
  });

  it('only trusts the canonical HN host, not a lookalike', () => {
    expect(
      hackerNewsItemId(
        item({ guid: 'https://news.ycombinator.com.evil.test/item?id=9', url: '' }),
      ),
    ).toBeNull();
  });
});

describe('newshacker URLs', () => {
  it('builds the thread url for an id', () => {
    expect(newshackerItemUrl('42662903')).toBe('https://newshacker.app/item/42662903');
  });

  it('newshackerUrlForItem returns the thread url for an HN item', () => {
    expect(newshackerUrlForItem(item())).toBe('https://newshacker.app/item/42662903');
  });

  it('newshackerUrlForItem returns null when there is no derivable HN id', () => {
    expect(
      newshackerUrlForItem(item({ guid: 'guid-1', url: 'https://example.com/post' })),
    ).toBeNull();
  });
});
