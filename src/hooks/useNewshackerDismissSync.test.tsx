import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DataSourceProvider } from '../lib/data/context';
import {
  useNewshackerDismissSync,
  NEWSHACKER_LINK_QUERY_KEY,
} from './useNewshackerDismissSync';
import type { DataSource } from '../lib/data/DataSource';
import type { NewshackerDoneEntry } from '../lib/newshackerSync';
import { suppressNextDoneMirror } from '../lib/newshackerMirrorSuppress';
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
  const syncNewshackerDone = vi.fn(async (_entries: NewshackerDoneEntry[]) => {});
  const source = {
    stateStore: {
      subscribeMutations: (l: MutationListener) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    },
    getNewshackerLink: vi.fn(async () => ({ linked: true })),
    getItemsByIds: vi.fn(async (ids: ItemId[]) =>
      items.filter((it) => ids.includes(it.item.id)),
    ),
    syncNewshackerDone,
  } as unknown as DataSource;
  return {
    source,
    syncNewshackerDone,
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
  client.setQueryData(NEWSHACKER_LINK_QUERY_KEY, { linked });
  function Harness() {
    useNewshackerDismissSync();
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

describe('useNewshackerDismissSync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('mirrors a dismissed HN item after the debounce', async () => {
    const fake = makeFakeSource([hnItem('a', '12345')]);
    mount(fake.source, true);
    expect(fake.hasListener()).toBe(true);

    fake.emit('a', { done: true });
    await vi.advanceTimersByTimeAsync(1500);

    expect(fake.syncNewshackerDone).toHaveBeenCalledTimes(1);
    const entries = fake.syncNewshackerDone.mock.calls[0][0];
    expect(entries).toEqual([{ id: 12345, at: expect.any(Number) }]);
  });

  it('does not mirror a suppressed Done (open-on-newshacker handoff)', async () => {
    const fake = makeFakeSource([hnItem('a', '12345')]);
    mount(fake.source, true);

    // The open-on-newshacker path registers a one-shot suppression right before
    // marking Done; the mirror must skip that exact transition.
    suppressNextDoneMirror('a');
    fake.emit('a', { done: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(fake.syncNewshackerDone).not.toHaveBeenCalled();

    // A later real dismissal of the same item still mirrors (one-shot).
    fake.emit('a', { done: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(fake.syncNewshackerDone).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst into a single mirror call', async () => {
    const fake = makeFakeSource([hnItem('a', '1'), hnItem('b', '2')]);
    mount(fake.source, true);

    fake.emit('a', { done: true });
    fake.emit('b', { done: true });
    await vi.advanceTimersByTimeAsync(1500);

    expect(fake.syncNewshackerDone).toHaveBeenCalledTimes(1);
    expect(fake.syncNewshackerDone.mock.calls[0][0]).toHaveLength(2);
  });

  it('ignores non-done mutations', async () => {
    const fake = makeFakeSource([hnItem('a', '1')]);
    mount(fake.source, true);

    fake.emit('a', { pinned: true });
    await vi.advanceTimersByTimeAsync(1500);

    expect(fake.syncNewshackerDone).not.toHaveBeenCalled();
  });

  it('does nothing when the account is not linked', async () => {
    const fake = makeFakeSource([hnItem('a', '1')]);
    mount(fake.source, false);
    // The effect never subscribes when unlinked.
    expect(fake.hasListener()).toBe(false);
    expect(fake.syncNewshackerDone).not.toHaveBeenCalled();
  });
});
