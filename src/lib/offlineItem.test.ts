// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Feed, FeedItem, Item } from './types';
import { findCachedFeedItem } from './offlineItem';

function feedItem(id: string, contentHtml = `<p>body of ${id}</p>`): FeedItem {
  const feed: Feed = {
    id: 'feed-1',
    url: 'https://example.com',
    siteUrl: 'https://example.com',
    title: 'Example',
    faviconUrl: null,
    errorCount: 0,
    lastError: null,
    parked: false,
  };
  const item: Item = {
    id,
    feedId: 'feed-1',
    guid: id,
    url: `https://example.com/${id}`,
    title: `Title ${id}`,
    author: null,
    publishedAt: 0,
    contentHtml,
    summary: null,
    fullContentHtml: null,
    enclosures: [],
  };
  return { item, feed };
}

describe('findCachedFeedItem', () => {
  it('finds an item inside an infinite-query feed-view cache (pages[*].items)', () => {
    const client = new QueryClient();
    // The Home/folder/feed views use useInfiniteQuery, so the cached shape is
    // { pages: Page<FeedItem>[], pageParams }, not a bare Page.
    client.setQueryData(['feed', 'home'], {
      pages: [
        { items: [feedItem('a')], nextCursor: '1' },
        { items: [feedItem('b'), feedItem('c')], nextCursor: null },
      ],
      pageParams: [null, '1'],
    });
    expect(findCachedFeedItem(client, 'c')?.item.contentHtml).toBe('<p>body of c</p>');
  });

  it('finds an item inside a single Page<FeedItem> cache', () => {
    const client = new QueryClient();
    client.setQueryData(['feed', 'home'], {
      items: [feedItem('a'), feedItem('b')],
      nextCursor: null,
    });
    expect(findCachedFeedItem(client, 'b')?.item.contentHtml).toBe('<p>body of b</p>');
  });

  it('finds an item inside a bare FeedItem[] library cache', () => {
    const client = new QueryClient();
    client.setQueryData(['library', 'pinned', 'x,y'], [feedItem('x'), feedItem('y')]);
    expect(findCachedFeedItem(client, 'y')?.item.id).toBe('y');
  });

  it('returns null when no cached list holds the item', () => {
    const client = new QueryClient();
    client.setQueryData(['feed', 'home'], {
      items: [feedItem('a')],
      nextCursor: null,
    });
    expect(findCachedFeedItem(client, 'missing')).toBeNull();
  });

  it('ignores unrelated cache entries of other shapes', () => {
    const client = new QueryClient();
    // A fulltext result and an item-detail object must not throw or match.
    client.setQueryData(['fulltext', 'a'], { status: 'ok', contentHtml: '<p>x</p>' });
    client.setQueryData(['item', 'a'], feedItem('a'));
    client.setQueryData(['misc'], 42);
    // The single-item ['item', id] cache is not a list, so it is skipped.
    expect(findCachedFeedItem(client, 'a')).toBeNull();
  });
});
