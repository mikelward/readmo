import { act, screen, waitFor } from '@testing-library/react';
import { QueryClient, useQuery } from '@tanstack/react-query';
import { vi } from 'vitest';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemList } from '../components/ItemList';
import { MockDataSource } from '../lib/data/MockDataSource';
import { DEFAULT_ITEM_STATE, type FeedItem } from '../lib/types';
import type { FetchPage } from './useFeedItems';
import { useTitleFilters } from './useReadingPrefs';
import { SETTINGS_SYNCED_EVENT } from '../lib/settingsSync';

/**
 * Regression: after a persisted-cache restore, preexisting Done/Hidden item
 * state must cause the feed to refetch so stale rows disappear from the
 * cache (not just the rendered list).
 *
 * The fix has two layers:
 *   1. main.tsx: PersistQueryClientProvider.onSuccess calls
 *      queryClient.invalidateQueries({ queryKey: ['feed'] }) after hydration.
 *   2. ItemList: the client-side visibleItems filter drops Done/Hidden rows
 *      from the rendered list immediately, regardless of cache freshness, so
 *      a Done row never reaches the screen even before the refetch lands.
 *
 * This test verifies BOTH layers: the Done item is never rendered (layer 2),
 * AND `invalidateQueries` triggers a real refetch so the cache gets cleaned
 * up too (layer 1) — without it, the cached snapshot would still carry the
 * Done row for the next session.
 */
describe('boot with a persisted feed keeps the frozen set', () => {
  it('hides preexisting Done via the overlay without forcing a boot refetch', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const firstPage = await source.getHomeItems();
    const allItems: FeedItem[] = firstPage.items;
    expect(allItems.length).toBeGreaterThan(1);

    const doneItem = allItems[0];

    // Mark the item Done before rendering, simulating boot-time localStorage
    // hydration that happens before the React tree mounts.
    source.stateStore.set(doneItem.item.id, 'done', true);

    // fetchPage returns ALL items (including Done) — a persisted snapshot whose
    // cached page hasn't been re-filtered. The frozen-set contract means boot
    // must NOT force a refetch to clean it (that would re-materialize the set on
    // every reload, regardless of the TTL — Codex P2 on #411); the overlay hides
    // the Done row from render, and the cache re-materializes only on the normal
    // 6h/PTR/More path.
    const fetchPage = vi.fn((cursor: string | null) =>
      source.getHomeItems({ cursor }),
    );

    // A high staleTime keeps the persisted feed fresh (a within-TTL reload), so
    // no automatic refetch fires.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000, staleTime: 60_000 } },
    });

    renderWithProviders(
      <ItemList viewKey="home-all" fetchPage={fetchPage as FetchPage} emptyLabel="All caught up." />,
      { source, queryClient },
    );

    // item-title elements contain the full "title + source + time + author" as
    // one textContent string — use startsWith to match just the title portion.
    const hasDoneTitle = () =>
      screen.getAllByTestId('item-title').some((n) => n.textContent?.startsWith(doneItem.item.title));

    // The Done row was in the cached page but the overlay never lets it reach the
    // DOM — no refetch required to hide it.
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryAllByTestId('item-title').length).toBeGreaterThan(0));
    expect(hasDoneTitle()).toBe(false);

    // The frozen set is not re-materialized on boot: the persisted page stays put
    // (gated by staleTime), so nothing shifts under the reader.
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    const feedQuery = queryClient
      .getQueryCache()
      .find({ queryKey: ['feed', 'home-all'] });
    expect(feedQuery?.isStale()).toBe(false);
  });
});

describe('useFeedInvalidation query scoping', () => {
  it('refetches the unread-count query on a mutation but leaves feed-items fresh', async () => {
    // Codex P2 on #375: the unread-count query key (['feed','unread-counts',…])
    // shares the ['feed'] prefix, so it must be invalidated explicitly — after an
    // outbox write syncs and clears the local pending adjustment, the badge would
    // otherwise read a stale server count and jump back up. The count is a cheap
    // number that never reflows the list, so it must keep refetching.
    //
    // The feed-ITEMS query, by contrast, is left ENTIRELY alone: not refetched
    // (no reflow under the reader) and — the TTL fix — not even force-marked
    // stale. Force-staling it made refetchOnMount fire a full refetch every time
    // the reader navigated back to the feed, defeating the staleTime TTL. Leaving
    // it fresh means the back/remount refetch is gated by staleTime instead.
    const source = new MockDataSource(`test-${Math.random()}`);
    const itemsFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const countsFetch = vi.fn().mockResolvedValue({ 'feed-a': 3 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    // renderWithProviders mounts useFeedInvalidation; these two observers make
    // both queries "active" so an invalidation's default refetchType can refetch.
    function Probe() {
      useQuery({ queryKey: ['feed', 'home-all'], queryFn: itemsFetch });
      useQuery({ queryKey: ['feed', 'unread-counts', 'feed-a'], queryFn: countsFetch });
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(1));

    act(() => {
      source.stateStore.set('item-1', 'done', true);
    });

    // The count query refetches (a number, no list reflow)…
    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(2));
    // …but the feed-items query is untouched: no refetch under the reader…
    expect(itemsFetch).toHaveBeenCalledTimes(1);
    // …and left FRESH, not force-staled — so a remount within staleTime (the
    // back-navigation path) stays TTL-gated and won't refetch.
    const feedItemsQuery = queryClient
      .getQueryCache()
      .find({ queryKey: ['feed', 'home-all'] });
    expect(feedItemsQuery?.isStale()).toBe(false);
  });

  it('refetches the feed when a title-filter push is acknowledged', async () => {
    // The one deliberate exception to the frozen-set rule (Codex P1 on #625).
    // Once the server filters too (0072), the rows it excluded are not in the
    // cache — so removing a word cannot restore them by overlay, and SPEC
    // promises removal "restores every article it was hiding". The articles
    // that rise into the floor slots a new filter frees have likewise never
    // been fetched. Neither is expressible as an overlay, which is the test the
    // frozen-set rule uses.
    //
    // Keyed on the SERVER ACK rather than the local write: see the hook doc.
    // This asserts the wiring; that the engine emits the event after a
    // successful push is asserted in settingsSync.test.ts.
    const source = new MockDataSource(`test-${Math.random()}`);
    const itemsFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const countsFetch = vi.fn().mockResolvedValue({ 'feed-a': 1 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    function Probe() {
      useQuery({ queryKey: ['feed', 'home-all'], queryFn: itemsFetch });
      useQuery({ queryKey: ['feed', 'unread-counts', 'feed-a'], queryFn: countsFetch });
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(SETTINGS_SYNCED_EVENT, { detail: { keys: ['titleFilters'] } }),
      );
    });

    // Both halves: the rows, and the badges that count what the rows serve.
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(2));
  });

  it('does not refetch the feed when an unrelated setting is pushed', async () => {
    // The exception has to stay narrow — a push of any other setting must not
    // reflow the list.
    const source = new MockDataSource(`test-${Math.random()}`);
    const itemsFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    function Probe() {
      useQuery({ queryKey: ['feed', 'home-all'], queryFn: itemsFetch });
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(SETTINGS_SYNCED_EVENT, { detail: { keys: ['itemSort'] } }),
      );
    });

    // Asserted on staleness rather than by waiting to see whether a refetch
    // arrives — there is no moment at which "it never happened" becomes true,
    // so a timeout would only be testing the clock.
    const feed = queryClient.getQueryCache().find({ queryKey: ['feed', 'home-all'] });
    expect(feed?.isStale()).toBe(false);
    expect(itemsFetch).toHaveBeenCalledTimes(1);
  });

  it('does not refetch the feed on a LOCAL filter change before the push lands', async () => {
    // The bug the ack-keying exists to prevent (Codex P1 on #625, second pass):
    // refetching on the local store write asks the server while it still holds
    // the OLD list, gets the old rows, and marks the query fresh — after which
    // the ack invalidates nothing and the feed keeps the stale set until a
    // manual refresh. The reader still sees matched rows vanish at once; that
    // is the overlay, which needs no refetch.
    const source = new MockDataSource(`test-${Math.random()}`);
    const itemsFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    let filters!: ReturnType<typeof useTitleFilters>;
    function Probe() {
      useQuery({ queryKey: ['feed', 'home-all'], queryFn: itemsFetch });
      filters = useTitleFilters();
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(1));

    act(() => {
      filters.addTitleFilter('trump');
    });

    const feed = queryClient.getQueryCache().find({ queryKey: ['feed', 'home-all'] });
    expect(feed?.isStale()).toBe(false);
    expect(itemsFetch).toHaveBeenCalledTimes(1);
  });

  it('leaves the frozen feed set alone on a cross-device hydration (but refreshes the unread count)', async () => {
    // The frozen-set contract (reversing #408): a hydrate that changes the store
    // — a cross-device resync (useStateSync → resyncState → hydrate) — must NOT
    // re-materialize the published set. The overlay ItemList subscribes to
    // reflects the change in place (a pin badge, a dropped row); a change the
    // overlay can't express (a pin of an article outside the loaded window) waits
    // for the next re-materialization (load/return past the 6h TTL, PTR, or More)
    // rather than repainting the list now. The unread-count number, being a cheap
    // badge that never reflows the list, still refreshes.
    const source = new MockDataSource(`test-${Math.random()}`);
    const itemsFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const countsFetch = vi.fn().mockResolvedValue({ 'feed-a': 3 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    function Probe() {
      useQuery({ queryKey: ['feed', 'home-all'], queryFn: itemsFetch });
      useQuery({ queryKey: ['feed', 'unread-counts', 'feed-a'], queryFn: countsFetch });
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(1));

    // A hydration that actually changes the map (a pin arriving from the server).
    act(() => {
      source.stateStore.hydrate([
        ['cross-device-item', { ...DEFAULT_ITEM_STATE, pinned: true, pinnedAt: 1 }],
      ]);
    });

    // The unread count refreshes…
    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(2));
    // …but the frozen set is left untouched: no refetch under the reader, and the
    // query stays fresh so a later remount within the TTL won't refetch either.
    expect(itemsFetch).toHaveBeenCalledTimes(1);
    const feedItemsQuery = queryClient
      .getQueryCache()
      .find({ queryKey: ['feed', 'home-all'] });
    expect(feedItemsQuery?.isStale()).toBe(false);
  });

  it('does not churn a feed read on a no-op hydration', async () => {
    // A resync that returns identical state (the common case on a routine focus)
    // must not churn any feed read — a no-op hydrate returns before it emits, so
    // neither the frozen set nor the unread count refetches.
    const source = new MockDataSource(`test-${Math.random()}`);
    const itemsFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const countsFetch = vi.fn().mockResolvedValue({ 'feed-a': 3 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    function Probe() {
      useQuery({ queryKey: ['feed', 'home-all'], queryFn: itemsFetch });
      useQuery({ queryKey: ['feed', 'unread-counts', 'feed-a'], queryFn: countsFetch });
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(1));

    // Hydrating the empty store with no rows is a no-op — no map change.
    act(() => {
      source.stateStore.hydrate([]);
    });

    // Give any (unwanted) refetch a chance to fire before asserting it didn't.
    await Promise.resolve();
    expect(itemsFetch).toHaveBeenCalledTimes(1);
    expect(countsFetch).toHaveBeenCalledTimes(1);
  });
});
