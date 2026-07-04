import { describe, expect, it } from 'vitest';
import { buildDoneEntries, type DoneChange } from './newshackerSync';
import type { Feed, FeedItem, Item, ItemId } from './types';

const HN_FEED = {
  url: 'https://news.ycombinator.com/rss',
  siteUrl: 'https://news.ycombinator.com/',
} as Feed;
const BLOG_FEED = {
  url: 'https://blog.example.com/rss',
  siteUrl: 'https://blog.example.com/',
} as Feed;

function feedItem(
  id: string,
  item: Partial<Item> = {},
  feed: Feed = HN_FEED,
): FeedItem {
  return {
    item: {
      id,
      feedId: 'f',
      guid: 'g',
      url: 'https://example.com/article',
      commentsUrl: null,
      title: 't',
      spoilerFreeTitle: null,
      author: null,
      publishedAt: 0,
      contentHtml: '',
      summary: null,
      fullContentHtml: null,
      enclosures: [],
      ...item,
    },
    feed,
  };
}

const HN = 'https://news.ycombinator.com/item?id=';

describe('buildDoneEntries', () => {
  it('maps a dismissed HN item to its numeric id', () => {
    const items = [feedItem('a', { commentsUrl: `${HN}12345` })];
    const changes = new Map<ItemId, DoneChange>([['a', { done: true, at: 111 }]]);
    expect(buildDoneEntries(items, changes)).toEqual([{ id: 12345, at: 111 }]);
  });

  it('emits a tombstone when Done was turned off (un-dismiss)', () => {
    const items = [feedItem('a', { commentsUrl: `${HN}7` })];
    const changes = new Map<ItemId, DoneChange>([['a', { done: false, at: 222 }]]);
    expect(buildDoneEntries(items, changes)).toEqual([
      { id: 7, at: 222, deleted: true },
    ]);
  });

  it('drops non-Hacker-News items (no derivable id)', () => {
    const items = [
      feedItem('a', { url: 'https://blog.example.com/post', guid: 'x' }),
    ];
    const changes = new Map<ItemId, DoneChange>([['a', { done: true, at: 1 }]]);
    expect(buildDoneEntries(items, changes)).toEqual([]);
  });

  it('drops a non-HN-feed item even when its body links to an HN discussion', () => {
    // A blog post that merely links to an HN thread must NOT mirror that
    // unrelated story as Done — gate on the feed, not just a derivable id.
    const items = [
      feedItem(
        'a',
        { contentHtml: `<a href="${HN}555">discuss on HN</a>` },
        BLOG_FEED,
      ),
    ];
    const changes = new Map<ItemId, DoneChange>([['a', { done: true, at: 1 }]]);
    expect(buildDoneEntries(items, changes)).toEqual([]);
  });

  it('skips items with no recorded change', () => {
    const items = [
      feedItem('a', { commentsUrl: `${HN}1` }),
      feedItem('b', { commentsUrl: `${HN}2` }),
    ];
    const changes = new Map<ItemId, DoneChange>([['a', { done: true, at: 5 }]]);
    expect(buildDoneEntries(items, changes)).toEqual([{ id: 1, at: 5 }]);
  });

  it('derives the id from the item body when no structured link exists', () => {
    // The official news.ycombinator.com/rss feed carries the discussion link
    // only in the item HTML.
    const items = [
      feedItem('a', {
        commentsUrl: null,
        guid: 'https://news.ycombinator.com/rss-guid',
        url: 'https://example.com/story',
        contentHtml: `<a href="${HN}99">Comments</a>`,
      }),
    ];
    const changes = new Map<ItemId, DoneChange>([['a', { done: true, at: 9 }]]);
    expect(buildDoneEntries(items, changes)).toEqual([{ id: 99, at: 9 }]);
  });
});
