import { describe, expect, it } from 'vitest';
import {
  buildMirrorPayload,
  resolveHackerNewsIds,
  type MirrorChange,
} from './newshackerSync';
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

describe('resolveHackerNewsIds', () => {
  it('maps HN-feed items to their numeric id', () => {
    const map = resolveHackerNewsIds([
      feedItem('a', { commentsUrl: `${HN}12345` }),
      feedItem('b', { guid: `${HN}7`, commentsUrl: null }),
    ]);
    expect(map.get('a')).toBe(12345);
    expect(map.get('b')).toBe(7);
  });

  it('omits non-Hacker-News feed items (even ones linking to HN in the body)', () => {
    const map = resolveHackerNewsIds([
      feedItem('a', { url: 'https://blog.example.com/post' }, BLOG_FEED),
      feedItem(
        'b',
        { contentHtml: `<a href="${HN}555">discuss on HN</a>` },
        BLOG_FEED,
      ),
    ]);
    expect(map.size).toBe(0);
  });
});

describe('buildMirrorPayload', () => {
  const ids = new Map<ItemId, number>([
    ['a', 12345],
    ['b', 7],
  ]);

  it('maps a dismissed item to a done entry', () => {
    const changes = new Map<ItemId, MirrorChange>([['a', { done: true, at: 111 }]]);
    expect(buildMirrorPayload(ids, changes)).toEqual({
      done: [{ id: 12345, at: 111 }],
      pinned: [],
    });
  });

  it('maps a pinned item to a pinned entry', () => {
    const changes = new Map<ItemId, MirrorChange>([['b', { pinned: true, at: 5 }]]);
    expect(buildMirrorPayload(ids, changes)).toEqual({
      done: [],
      pinned: [{ id: 7, at: 5 }],
    });
  });

  it('emits tombstones for un-dismiss and unpin', () => {
    const changes = new Map<ItemId, MirrorChange>([
      ['b', { done: false, pinned: false, at: 3 }],
    ]);
    expect(buildMirrorPayload(ids, changes)).toEqual({
      done: [{ id: 7, at: 3, deleted: true }],
      pinned: [{ id: 7, at: 3, deleted: true }],
    });
  });

  it('carries both lists when a pin clears done in one mutation', () => {
    const changes = new Map<ItemId, MirrorChange>([
      ['a', { pinned: true, done: false, at: 8 }],
    ]);
    expect(buildMirrorPayload(ids, changes)).toEqual({
      done: [{ id: 12345, at: 8, deleted: true }],
      pinned: [{ id: 12345, at: 8 }],
    });
  });

  it('drops changes for items with no resolved HN id', () => {
    const changes = new Map<ItemId, MirrorChange>([
      ['unknown', { done: true, at: 1 }],
    ]);
    expect(buildMirrorPayload(ids, changes)).toEqual({ done: [], pinned: [] });
  });
});
