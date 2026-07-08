import { act, screen, waitFor } from '@testing-library/react';
import { QueryClient, useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { vi } from 'vitest';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemList } from '../components/ItemList';
import { MockDataSource } from '../lib/data/MockDataSource';
import { DEFAULT_ITEM_STATE, type FeedItem } from '../lib/types';
import type { FetchPage } from './useFeedItems';

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

  it('re-materializes the feed when a cross-device pin lands on an article NOT in the loaded set', async () => {
    // The frozen set has ONE exception (this fix): a cross-device pin of an
    // article the overlay can't surface — one absent from every loaded page — must
    // re-materialize the feed so the pin becomes visible, instead of staying
    // hidden until the next 6h TTL / PTR / More. This is the "my pinned article
    // vanished on a persisted (PWA) feed set" bug: the persisted set predates the
    // pin, so the pinned (older) article was never in it and the flag-overlay
    // can't add it. A pinned article must be visible.
    const source = new MockDataSource(`test-${Math.random()}`);
    // The loaded page is empty, so the pinned id below is genuinely absent.
    const itemsFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const countsFetch = vi.fn().mockResolvedValue({ 'feed-a': 3 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    // Mirror production: the feed LIST is an infinite query (data shape
    // `{ pages: [...] }`), which is what the invalidation hook scans for loaded ids.
    function Probe() {
      useInfiniteQuery({
        queryKey: ['feed', 'home-all'],
        queryFn: itemsFetch,
        initialPageParam: null as string | null,
        getNextPageParam: () => undefined,
      });
      useQuery({ queryKey: ['feed', 'unread-counts', 'feed-a'], queryFn: countsFetch });
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(1));

    // A cross-device pin of an article that isn't in the (empty) loaded set.
    act(() => {
      source.stateStore.hydrate([
        ['cross-device-pin', { ...DEFAULT_ITEM_STATE, pinned: true, pinnedAt: 1 }],
      ]);
    });

    // The feed re-materializes so the pinned article can appear — itemsFetch runs
    // again (exact refetch count is an RQ timing detail; the point is it re-reads).
    await waitFor(() =>
      expect(itemsFetch.mock.calls.length).toBeGreaterThan(1),
    );
    // …and the unread count refreshes too.
    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(2));
  });

  it('leaves the frozen set alone when a cross-device pin lands on an article already loaded', async () => {
    // The no-jump case (#411): a cross-device pin of a row that IS in the loaded
    // set is expressible by the overlay (its pin badge renders in place), so the
    // set must NOT re-materialize — the row must not leap to the top under the
    // reader. Only an ABSENT pin re-materializes (test above).
    const source = new MockDataSource(`test-${Math.random()}`);
    const page = await source.getHomeItems();
    const loadedItem = page.items[0];
    const itemsFetch = vi.fn().mockResolvedValue({
      items: [loadedItem],
      nextCursor: null,
    });
    const countsFetch = vi.fn().mockResolvedValue({ 'feed-a': 3 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    // Mirror production: the feed LIST is an infinite query, so its cached data is
    // `{ pages: [{ items: [loadedItem] }] }` and the hook sees the id as loaded.
    function Probe() {
      useInfiniteQuery({
        queryKey: ['feed', 'home-all'],
        queryFn: itemsFetch,
        initialPageParam: null as string | null,
        getNextPageParam: () => undefined,
      });
      useQuery({ queryKey: ['feed', 'unread-counts', 'feed-a'], queryFn: countsFetch });
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(1));

    // Pin the article that's already in the loaded page.
    act(() => {
      source.stateStore.hydrate([
        [loadedItem.item.id, { ...DEFAULT_ITEM_STATE, pinned: true, pinnedAt: 1 }],
      ]);
    });

    // The unread count refreshes…
    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(2));
    // …but the frozen set is untouched (the overlay renders the pin in place), so
    // no refetch under the reader and the query stays fresh.
    expect(itemsFetch).toHaveBeenCalledTimes(1);
    const feedItemsQuery = queryClient
      .getQueryCache()
      .find({ queryKey: ['feed', 'home-all'] });
    expect(feedItemsQuery?.isStale()).toBe(false);
  });

  it('re-materializes the ACTIVE list even when an inactive cached query already holds the pin', async () => {
    // Codex P2: the absence check is per ACTIVE list. A pinned article present in
    // an inactive folder/feed query left over from a previous route must not
    // suppress the refetch the active Home view needs — otherwise the pin stays
    // invisible in the view the reader is actually looking at until TTL/PTR.
    const source = new MockDataSource(`test-${Math.random()}`);
    const page = await source.getHomeItems();
    const pinnedItem = page.items[0];
    const itemsFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const countsFetch = vi.fn().mockResolvedValue({ 'feed-a': 3 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    // An INACTIVE feed-list query (no observer) that already holds the pinned item.
    queryClient.setQueryData(['feed', 'folder-old'], {
      pages: [{ items: [pinnedItem], nextCursor: null }],
      pageParams: [null],
    });

    // The ACTIVE Home list (has an observer) is missing the pinned item.
    function Probe() {
      useInfiniteQuery({
        queryKey: ['feed', 'home-all'],
        queryFn: itemsFetch,
        initialPageParam: null as string | null,
        getNextPageParam: () => undefined,
      });
      useQuery({ queryKey: ['feed', 'unread-counts', 'feed-a'], queryFn: countsFetch });
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(1));

    act(() => {
      source.stateStore.hydrate([
        [pinnedItem.item.id, { ...DEFAULT_ITEM_STATE, pinned: true, pinnedAt: 1 }],
      ]);
    });

    // The active Home list re-materializes despite the inactive cache holding it.
    await waitFor(() =>
      expect(itemsFetch.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it('marks an INACTIVE Home list stale so it refetches on next mount', async () => {
    // Codex P2: if the pin lands while no Home list is mounted (reader on a
    // reader/library route) — or a different home-all sort/group variant is
    // cached but inactive — an active-only invalidation would leave that Home
    // cache fresh for the 6h TTL, so returning to it serves the pre-pin list. The
    // inactive Home list that lacks the pin must be marked stale (invalidated) so
    // its next mount refetches.
    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    // An INACTIVE all-subscriptions Home list (no observer) missing the pin.
    queryClient.setQueryData(['feed', 'home-all:newest:grouped'], {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [null],
    });
    // The reader is on some non-feed route: nothing mounts a Home list.
    function Probe() {
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });

    const homeQuery = () =>
      queryClient
        .getQueryCache()
        .find({ queryKey: ['feed', 'home-all:newest:grouped'] });
    // Fresh to start (just seeded, within staleTime).
    expect(homeQuery()?.isStale()).toBe(false);

    act(() => {
      source.stateStore.hydrate([
        ['cross-device-pin', { ...DEFAULT_ITEM_STATE, pinned: true, pinnedAt: 1 }],
      ]);
    });

    // …now invalidated, so a Back/toggle to Home will refetch and surface the pin.
    await waitFor(() => expect(homeQuery()?.isStale()).toBe(true));
  });

  it('does not re-materialize a scoped (single-feed) active view for an out-of-scope pin', async () => {
    // Codex P2: `newlyPinned` comes from the whole item_state hydration, but a
    // folder/single-feed view's read is bounded server-side and can't surface a
    // pin from another feed. So a scoped active view must NOT re-materialize on an
    // unrelated cross-device pin — that would reflow the scoped list for nothing.
    // The exception is limited to the all-subscriptions (`home-all`) view.
    const source = new MockDataSource(`test-${Math.random()}`);
    const itemsFetch = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: 60_000 } },
    });

    // The active list is a SINGLE-FEED view (viewKey `feed:feed-b:…`), not home-all.
    function Probe() {
      useInfiniteQuery({
        queryKey: ['feed', 'feed:feed-b:newest:grouped'],
        queryFn: itemsFetch,
        initialPageParam: null as string | null,
        getNextPageParam: () => undefined,
      });
      return null;
    }
    renderWithProviders(<Probe />, { source, queryClient });
    await waitFor(() => expect(itemsFetch).toHaveBeenCalledTimes(1));

    // A cross-device pin of an article that isn't in this scoped view.
    act(() => {
      source.stateStore.hydrate([
        ['some-other-feed-article', { ...DEFAULT_ITEM_STATE, pinned: true, pinnedAt: 1 }],
      ]);
    });

    // Give any (unwanted) refetch a chance to fire before asserting it didn't.
    await act(async () => {
      await Promise.resolve();
    });
    expect(itemsFetch).toHaveBeenCalledTimes(1);
    const scoped = queryClient
      .getQueryCache()
      .find({ queryKey: ['feed', 'feed:feed-b:newest:grouped'] });
    expect(scoped?.isStale()).toBe(false);
  });

  it('leaves the frozen set alone on a cross-device dismiss (but refreshes the unread count)', async () => {
    // A cross-device Done/Hidden pins nothing, so it never re-materializes the set
    // — the overlay drops the row in place (or grays it, if on screen). Only a
    // new pin can force a re-materialization.
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

    act(() => {
      source.stateStore.hydrate([
        ['cross-device-done', { ...DEFAULT_ITEM_STATE, done: true, doneAt: 1 }],
      ]);
    });

    await waitFor(() => expect(countsFetch).toHaveBeenCalledTimes(2));
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
