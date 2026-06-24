import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { resolveSavedItems } from './offlineItems';
import type { DataSource } from './data/DataSource';
import type { FeedItem, ItemId } from './types';

function feedItem(id: string): FeedItem {
  return {
    item: {
      id,
      feedId: 'f1',
      title: `Item ${id}`,
      url: `https://x/${id}`,
      author: null,
      publishedAt: '2026-06-20T00:00:00.000Z',
      contentHtml: '<p>x</p>',
      summary: null,
      enclosures: [],
      fullContentHtml: null,
    },
    feed: {
      id: 'f1',
      title: 'Feed 1',
      siteUrl: 'https://x',
      feedUrl: 'https://x/rss',
      errorCount: 0,
      lastError: null,
    },
  } as unknown as FeedItem;
}

/** Minimal DataSource stub: only getItemsByIds matters here. */
function dsWith(getItemsByIds: (ids: ItemId[]) => Promise<FeedItem[]>): DataSource {
  return { getItemsByIds } as unknown as DataSource;
}

describe('resolveSavedItems', () => {
  it('returns the batch fetch result when it succeeds', async () => {
    const qc = new QueryClient();
    const ds = dsWith(async () => [feedItem('a'), feedItem('b')]);
    const out = await resolveSavedItems(ds, qc, ['a', 'b']);
    expect(out.map((fi) => fi.item.id)).toEqual(['a', 'b']);
  });

  it('returns a SUCCESSFUL empty as empty (not a failure)', async () => {
    const qc = new QueryClient();
    const ds = dsWith(async () => []);
    // No cache warmed, but the fetch succeeded → genuine empty, no throw.
    await expect(resolveSavedItems(ds, qc, ['gone'])).resolves.toEqual([]);
  });

  it('falls back to the per-item cache when the batch fetch throws', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['item', 'a'], feedItem('a'));
    const ds = dsWith(async () => {
      throw new Error('offline');
    });
    const out = await resolveSavedItems(ds, qc, ['a', 'b']);
    expect(out.map((fi) => fi.item.id)).toEqual(['a']); // 'b' not cached
  });

  it('re-throws when the fetch fails and NOTHING is recoverable from cache', async () => {
    const qc = new QueryClient();
    const ds = dsWith(async () => {
      throw new Error('backend down');
    });
    // Persisted ids but no warmed cache → surface the failure rather than
    // masquerading it as an empty library.
    await expect(resolveSavedItems(ds, qc, ['a', 'b'])).rejects.toThrow(/backend down/);
  });
});
