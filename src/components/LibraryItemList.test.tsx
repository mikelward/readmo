import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { PushPinFilled } from './icons';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
import { LibraryItemList } from './LibraryItemList';

describe('LibraryItemList', () => {
  it('lists pinned items from the warmed per-item cache when the batch fetch fails offline', async () => {
    // Source whose batch fetch fails (Supabase offline) but whose getItem still
    // seeds the per-item cache (as useOfflineCacheLock does).
    class OfflineBatchSource extends MockDataSource {
      async getItemsByIds(): Promise<never> {
        throw new Error('offline');
      }
    }
    const source = new OfflineBatchSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const seed = new MockDataSource(`seed-${Math.random()}`);
    queryClient.setQueryData(['item', 'item-1'], await seed.getItem('item-1'));

    renderWithProviders(
      <LibraryItemList
        field="pinned"
        actionLabel="Unpin"
        actionIcon={<PushPinFilled />}
        emptyLabel="No pinned items."
      />,
      { route: '/pinned', source, queryClient },
    );

    expect(
      await screen.findByText('A foldable phone that actually folds flat, finally'),
    ).toBeInTheDocument();
  });

  it('shows the LoadError miss-state when the batch fetch fails and nothing is cached', async () => {
    // Persisted pin id but the batch fetch throws AND no per-item cache is
    // warmed → resolveSavedItems re-throws, so the view surfaces the failure
    // (with the cause) instead of a misleading "No pinned items." empty label.
    class DownSource extends MockDataSource {
      async getItemsByIds(): Promise<never> {
        throw new Error('backend down');
      }
    }
    const source = new DownSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    renderWithProviders(
      <LibraryItemList
        field="pinned"
        actionLabel="Unpin"
        actionIcon={<PushPinFilled />}
        emptyLabel="No pinned items."
      />,
      { route: '/pinned', source, queryClient },
    );

    // Names the failure (online → "Unexpected response loading your library")
    // and surfaces the cause behind Details — not the empty label.
    expect(
      await screen.findByText(/unexpected response loading your library/i),
    ).toBeInTheDocument();
    expect(screen.getByText('backend down')).toBeInTheDocument();
    expect(screen.queryByText('No pinned items.')).toBeNull();
  });
});
