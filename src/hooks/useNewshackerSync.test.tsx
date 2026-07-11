import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DataSourceProvider } from '../lib/data/context';
import {
  useNewshackerSync,
  NEWSHACKER_LINK_QUERY_KEY,
} from './useNewshackerSync';
import type { DataSource } from '../lib/data/DataSource';
import type { MirrorPayload } from '../lib/newshackerSync';
import { suppressNextDoneMirror } from '../lib/newshackerMirrorSuppress';
import { rememberHackerNewsItemId } from '../lib/newshackerItemIds';
import type { Feed, FeedItem, Item, ItemId, ItemStateField } from '../lib/types';

type MutationListener = (
  id: ItemId,
  changed: Partial<Record<ItemStateField, boolean>>,
) => void;

function hnItem(id: string, hnId: string): FeedItem {
  return {
    item: {
      id,
      feedId: 'f',
      guid: 'g',
      url: 'https://example.com/a',
      commentsUrl: `https://news.ycombinator.com/item?id=${hnId}`,
      title: 't',
      spoilerFreeTitle: null,
      author: null,
      publishedAt: 0,
      contentHtml: '',
      summary: null,
      fullContentHtml: null,
      aiSummary: null,
      enclosures: [],
    } as Item,
    feed: {
      url: 'https://news.ycombinator.com/rss',
      siteUrl: 'https://news.ycombinator.com/',
    } as Feed,
  };
}

function makeFakeSource(items: FeedItem[]) {
  let listener: MutationListener | null = null;
  const syncNewshackerState = vi.fn(async (_payload: MirrorPayload) => {});
  const source = {
    stateStore: {
      subscribeMutations: (l: MutationListener) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    },
    getNewshackerLink: vi.fn(async () => ({ linked: true, supported: true })),
    getItemsByIds: vi.fn(async (ids: ItemId[]) =>
      items.filter((it) => ids.includes(it.item.id)),
    ),
    syncNewshackerState,
  } as unknown as DataSource;
  return {
    source,
    syncNewshackerState,
    emit: (id: ItemId, changed: Partial<Record<ItemStateField, boolean>>) => {
      listener?.(id, changed);
    },
    hasListener: () => listener != null,
  };
}

function mount(source: DataSource, linked: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // Seed the link status so the hook reads it synchronously from cache.
  client.setQueryData(NEWSHACKER_LINK_QUERY_KEY, { linked, supported: true });
  function Harness() {
    useNewshackerSync();
    return null;
  }
  render(
    <QueryClientProvider client={client}>
      <DataSourceProvider source={source}>
        <Harness />
      </DataSourceProvider>
    </QueryClientProvider>,
  );
}

describe('useNewshackerSync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('mirrors a dismissed HN item after the debounce', async () => {
    const fake = makeFakeSource([hnItem('a', '12345')]);
    mount(fake.source, true);
    expect(fake.hasListener()).toBe(true);

    fake.emit('a', { done: true });
    await vi.advanceTimersByTimeAsync(1500);

    expect(fake.syncNewshackerState).toHaveBeenCalledTimes(1);
    expect(fake.syncNewshackerState.mock.calls[0][0]).toEqual({
      done: [{ id: 12345, at: expect.any(Number) }],
      pinned: [],
    });
  });

  it('mirrors a pinned HN item after the debounce', async () => {
    const fake = makeFakeSource([hnItem('a', '777')]);
    mount(fake.source, true);

    fake.emit('a', { pinned: true });
    await vi.advanceTimersByTimeAsync(1500);

    expect(fake.syncNewshackerState).toHaveBeenCalledTimes(1);
    expect(fake.syncNewshackerState.mock.calls[0][0]).toEqual({
      done: [],
      pinned: [{ id: 777, at: expect.any(Number) }],
    });
  });

  it('does not mirror a suppressed Done (open-on-newshacker handoff)', async () => {
    const fake = makeFakeSource([hnItem('a', '12345')]);
    mount(fake.source, true);

    // The open-on-newshacker path registers a one-shot suppression right before
    // marking Done; the mirror must skip that exact transition (and any pin it
    // clears in the same mutation).
    suppressNextDoneMirror('a');
    fake.emit('a', { done: true, pinned: false });
    await vi.advanceTimersByTimeAsync(1500);
    expect(fake.syncNewshackerState).not.toHaveBeenCalled();

    // A later real dismissal of the same item still mirrors (one-shot).
    fake.emit('a', { done: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(fake.syncNewshackerState).toHaveBeenCalledTimes(1);
  });

  it('mirrors an unpin tombstone from the render cache when the item is gone', async () => {
    // Simulate unpinning an unsubscribed feed's item: the row is no longer
    // fetchable (getItemsByIds returns nothing), but its HN id was remembered
    // while it was on screen, so the tombstone must still be sent.
    const fake = makeFakeSource([]); // getItemsByIds resolves nothing
    rememberHackerNewsItemId('gone', 999);
    mount(fake.source, true);

    fake.emit('gone', { pinned: false });
    await vi.advanceTimersByTimeAsync(1500);

    expect(fake.syncNewshackerState).toHaveBeenCalledTimes(1);
    expect(fake.syncNewshackerState.mock.calls[0][0]).toEqual({
      done: [],
      pinned: [{ id: 999, at: expect.any(Number), deleted: true }],
    });
  });

  it('coalesces a burst into a single mirror call', async () => {
    const fake = makeFakeSource([hnItem('a', '1'), hnItem('b', '2')]);
    mount(fake.source, true);

    fake.emit('a', { done: true });
    fake.emit('b', { pinned: true });
    await vi.advanceTimersByTimeAsync(1500);

    expect(fake.syncNewshackerState).toHaveBeenCalledTimes(1);
    const payload = fake.syncNewshackerState.mock.calls[0][0];
    expect(payload.done).toHaveLength(1);
    expect(payload.pinned).toHaveLength(1);
  });

  it('ignores mutations that touch neither Done nor Pinned', async () => {
    const fake = makeFakeSource([hnItem('a', '1')]);
    mount(fake.source, true);

    fake.emit('a', { favorite: true });
    fake.emit('a', { opened: true });
    await vi.advanceTimersByTimeAsync(1500);

    expect(fake.syncNewshackerState).not.toHaveBeenCalled();
  });

  it('does nothing when the account is not linked', async () => {
    const fake = makeFakeSource([hnItem('a', '1')]);
    mount(fake.source, false);
    // The effect never subscribes when unlinked.
    expect(fake.hasListener()).toBe(false);
    expect(fake.syncNewshackerState).not.toHaveBeenCalled();
  });
});
