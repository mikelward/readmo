import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
import { _resetIdbForTests } from '../lib/idbStorage';
import { OfflinePage } from './OfflinePage';

describe('OfflinePage', () => {
  beforeEach(() => {
    // A working IndexedDB so the storage-availability probe reads "available"
    // (the real-browser default); the unavailable-storage case stubs it off.
    globalThis.indexedDB = new IDBFactory();
    _resetIdbForTests();
  });
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

  it('switches a row from the cached feed-list copy to the warmed per-item copy', async () => {
    // The row is first shown from a cached feed list (no ['item', id] detail
    // yet). When the offline-cache lock later warms ['item', id] — same id, so
    // the resolved set is unchanged — the page must still re-render onto the
    // preferred per-item copy, not stay pinned to the stale feed-list object.
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true);

    const queryClient = cacheClient();
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

    // Warm a per-item detail with a distinct title; the row should follow it.
    const warmed = await seed.getItem('item-1');
    if (!warmed) throw new Error('seed item-1 missing');
    await act(async () => {
      queryClient.setQueryData(['item', 'item-1'], {
        ...warmed,
        item: { ...warmed.item, title: 'Warmed per-item title' },
      });
    });

    expect(
      await screen.findByText('Warmed per-item title'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('A foldable phone that actually folds flat, finally'),
    ).not.toBeInTheDocument();
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

  it('tells the user to leave incognito when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    _resetIdbForTests();
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true);

    renderWithProviders(<OfflinePage />, {
      route: '/offline',
      source,
      queryClient: cacheClient(),
    });

    expect(
      await screen.findByText(
        /please exit incognito mode or grant database permission/i,
      ),
    ).toBeInTheDocument();
  });

  it('does not claim nothing is saved when items are pinned but uncached on this device', async () => {
    // The bug report: with pins present but no cached body for them, `/offline`
    // wrongly read as "nothing saved". It must own that there ARE saved items.
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true);

    renderWithProviders(<OfflinePage />, {
      route: '/offline',
      source,
      queryClient: cacheClient(),
    });

    expect(
      await screen.findByText(/Your saved items aren't on this device yet/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Nothing saved offline yet/i),
    ).not.toBeInTheDocument();
  });

  it('updates live when a saved item is warmed into the cache after mount', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true);
    const queryClient = cacheClient();

    renderWithProviders(<OfflinePage />, { route: '/offline', source, queryClient });

    // Pinned, but its detail isn't cached yet → the "saved but not on this
    // device" copy (not the genuine "nothing saved").
    expect(
      await screen.findByText(/Your saved items aren't on this device yet/i),
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
