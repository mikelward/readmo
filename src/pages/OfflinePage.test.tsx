import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
import { OfflinePage } from './OfflinePage';

describe('OfflinePage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A client that keeps set data alive (no GC) and never retries, so cache
   * seeding in a test survives until asserted. */
  function cacheClient(): QueryClient {
    return new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
    });
  }

  it('lists saved items straight from the per-item cache, never fetching', async () => {
    // If the page tried a batch fetch this would throw and surface an error
    // instead of the cached row — the offline list must not depend on it.
    const getItemsByIds = vi.fn(async () => {
      throw new Error('offline — must not be called');
    });
    class NoFetchSource extends MockDataSource {
      getItemsByIds = getItemsByIds;
    }
    const source = new NoFetchSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true);

    const queryClient = cacheClient();
    const seed = new MockDataSource(`seed-${Math.random()}`);
    queryClient.setQueryData(['item', 'item-1'], await seed.getItem('item-1'));

    renderWithProviders(<OfflinePage />, { route: '/offline', source, queryClient });

    expect(
      await screen.findByText('A foldable phone that actually folds flat, finally'),
    ).toBeInTheDocument();
    expect(getItemsByIds).not.toHaveBeenCalled();
  });

  it('recovers a saved item from a cached feed list when its detail was never warmed', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'favorite', true);

    const queryClient = cacheClient();
    // No ['item','item-1'] detail — only a feed page that happens to carry it,
    // the way Home/folder/feed views persist their loaded rows.
    const seed = new MockDataSource(`seed-${Math.random()}`);
    const page = await seed.getHomeItems();
    queryClient.setQueryData(['feed', 'home-all:test'], {
      pages: [page],
      pageParams: [null],
    });

    renderWithProviders(<OfflinePage />, { route: '/offline', source, queryClient });

    expect(
      await screen.findByText('A foldable phone that actually folds flat, finally'),
    ).toBeInTheDocument();
  });

  it('shows the empty copy when nothing is saved', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(<OfflinePage />, {
      route: '/offline',
      source,
      queryClient: cacheClient(),
    });

    expect(
      await screen.findByText(/Nothing saved offline yet/i),
    ).toBeInTheDocument();
  });

  it('updates live when a saved item is warmed into the cache after mount', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true);
    const queryClient = cacheClient();

    renderWithProviders(<OfflinePage />, { route: '/offline', source, queryClient });

    // Pinned, but its detail isn't cached yet → empty.
    expect(
      await screen.findByText(/Nothing saved offline yet/i),
    ).toBeInTheDocument();

    // The offline-cache lock warms the detail; the list should pick it up.
    const seed = new MockDataSource(`seed-${Math.random()}`);
    await act(async () => {
      queryClient.setQueryData(['item', 'item-1'], await seed.getItem('item-1'));
    });

    expect(
      await screen.findByText('A foldable phone that actually folds flat, finally'),
    ).toBeInTheDocument();
  });

  it('has a Back to top button in the bottom toolbar that scrolls to the top', async () => {
    const user = userEvent.setup();
    const scrollToSpy = vi.fn();
    vi.stubGlobal('scrollTo', scrollToSpy);
    renderWithProviders(<OfflinePage />, { route: '/offline' });

    const backToTop = await screen.findByTestId('back-to-top');
    expect(backToTop).toHaveAccessibleName(/back to top/i);
    await user.click(backToTop);
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });
});
