import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { PushPinFilled } from './icons';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { FeedItem } from '../lib/types';
import { LibraryItemList } from './LibraryItemList';

describe('LibraryItemList', () => {
  it('keeps the remaining rows on screen (minus the toggled one) through the refetch a toggle triggers', async () => {
    // The bucket mutation changes the query key; the refetch for the new key
    // is held open so the in-flight window (the state under test) is
    // deterministic.
    class GatedSource extends MockDataSource {
      gate = false;
      resolvers: Array<(v: FeedItem[]) => void> = [];
      override async getItemsByIds(ids: string[]): Promise<FeedItem[]> {
        if (!this.gate) return super.getItemsByIds(ids);
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      }
    }
    const source = new GatedSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true);
    source.stateStore.set('item-2', 'pinned', true);

    renderWithProviders(
      <LibraryItemList
        field="pinned"
        actionLabel="Unpin"
        actionIcon={<PushPinFilled />}
        emptyLabel="No pinned items."
      />,
      { route: '/pinned', source },
    );
    expect(
      await screen.findByText('A foldable phone that actually folds flat, finally'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Webb telescope captures a galaxy cluster bending light'),
    ).toBeInTheDocument();

    // Unpin one row. The toggle is a purely local, optimistic mutation: the
    // toggled row leaves at once, the OTHER row must stay put — no "Loading…"
    // blanking the list for a network round-trip.
    source.gate = true;
    const row = screen
      .getByText('A foldable phone that actually folds flat, finally')
      .closest('li') as HTMLElement;
    fireEvent.click(within(row).getByTestId('library-action-pinned'));

    expect(
      screen.queryByText('A foldable phone that actually folds flat, finally'),
    ).toBeNull();
    expect(
      screen.getByText('Webb telescope captures a galaxy cluster bending light'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).toBeNull();

    // Release the refetch: the settled list matches what was already shown.
    const remaining = await new MockDataSource(`seed-${Math.random()}`).getItemsByIds(['item-2']);
    await act(async () => source.resolvers.forEach((r) => r(remaining)));
    expect(
      screen.getByText('Webb telescope captures a galaxy cluster bending light'),
    ).toBeInTheDocument();
  });

  it('does not present a previously-empty bucket\'s "No items" as the result of a growing bucket\'s in-flight fetch', async () => {
    // Mirror of the SearchPage placeholder-empty gate: an empty settled list
    // carried forward by keepPreviousData reads as a non-loading success, so
    // a cross-device pin landing in an empty view must show "Loading…", not
    // the stale empty label, while its fetch is in flight.
    class GatedSource extends MockDataSource {
      gate = false;
      resolvers: Array<(v: FeedItem[]) => void> = [];
      override async getItemsByIds(ids: string[]): Promise<FeedItem[]> {
        if (!this.gate) return super.getItemsByIds(ids);
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      }
    }
    const source = new GatedSource(`test-${Math.random()}`);
    renderWithProviders(
      <LibraryItemList
        field="pinned"
        actionLabel="Unpin"
        actionIcon={<PushPinFilled />}
        emptyLabel="No pinned items."
      />,
      { route: '/pinned', source },
    );
    expect(await screen.findByText('No pinned items.')).toBeInTheDocument();

    source.gate = true;
    act(() => source.stateStore.set('item-1', 'pinned', true));
    expect(screen.queryByText('No pinned items.')).toBeNull();
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    const pinned = await new MockDataSource(`seed-${Math.random()}`).getItemsByIds(['item-1']);
    await act(async () => source.resolvers.forEach((r) => r(pinned)));
    expect(
      await screen.findByText('A foldable phone that actually folds flat, finally'),
    ).toBeInTheDocument();
  });

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
