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
});
