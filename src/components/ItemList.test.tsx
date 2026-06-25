import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemList } from './ItemList';
import type { FetchPage } from '../hooks/useFeedItems';
import { MockDataSource } from '../lib/data/MockDataSource';
import { _resetNetworkStatusForTests } from '../lib/networkStatus';
import type { FeedItem } from '../lib/types';
import { resetPromoDismissedCacheForTest } from '../hooks/usePromoDismissed';
import {
  BOTTOM_BAR_KEY,
  HIDE_ON_SCROLL_KEY,
  resetReadingPrefsCacheForTest,
} from '../hooks/useReadingPrefs';
import {
  installIntersectionObserverMock,
  setVisibilityForTest,
  uninstallIntersectionObserverMock,
} from '../test/intersectionObserver';

function renderHome(source: MockDataSource) {
  return renderWithProviders(
    <ItemList
      viewKey="home-all"
      fetchPage={(cursor) => source.getHomeItems({ cursor })}
      emptyLabel="All caught up."
    />,
    { source },
  );
}

let viewKeySeq = 0;

// Render a feed paged into fixed-size chunks so the More button's enabled →
// "No more items" transition is exercisable (the seed feed fits in one page).
function renderPaged(source: MockDataSource, items: FeedItem[], pageSize: number) {
  const fetchPage = vi.fn((cursor: string | null) => {
    const offset = cursor ? Number(cursor) : 0;
    const slice = items.slice(offset, offset + pageSize);
    const next = offset + pageSize < items.length ? String(offset + pageSize) : null;
    return Promise.resolve({ items: slice, nextCursor: next });
  });
  const utils = renderWithProviders(
    <ItemList
      viewKey={`paged-${viewKeySeq++}`}
      fetchPage={fetchPage}
      emptyLabel="All caught up."
    />,
    { source },
  );
  return { ...utils, fetchPage };
}

describe('ItemList', () => {
  // Sweep hides only rows fully in the viewport, tracked via an
  // IntersectionObserver that jsdom lacks — the mock reports every observed
  // row as fully visible by default (see intersectionObserver.ts).
  beforeEach(() => {
    installIntersectionObserverMock();
    // Start every case with the promo bar un-dismissed: clear both the
    // persisted flag and the module-level cache so an earlier dismissal can't
    // mask a later "bar is absent" assertion (it would return null for the
    // wrong reason).
    window.localStorage.clear();
    resetPromoDismissedCacheForTest();
    resetReadingPrefsCacheForTest();
  });

  afterEach(() => {
    uninstallIntersectionObserverMock();
    vi.unstubAllGlobals();
    // The offline-message test toggles navigator.onLine + the network tracker;
    // bring the browser back online first so the 'online' transition re-syncs
    // React Query's singleton onlineManager (otherwise later tests' queries stay
    // paused), then reset the tracker's own module state.
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    window.dispatchEvent(new Event('online'));
    _resetNetworkStatusForTests();
    // Reset scroll geometry to jsdom defaults so each test starts with the
    // "More" pager at the foot of the list (scrollY 0 + innerHeight ≥
    // scrollHeight 0 → atListEnd). Tests that exercise paging set their own.
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 0,
      configurable: true,
    });
  });

  it('renders the first page of items with the sticky toolbar', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderHome(source);
    await waitFor(() => {
      expect(screen.getAllByTestId('item-row').length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId('undo-btn')).toBeInTheDocument();
    expect(screen.getByTestId('sweep-btn')).toBeInTheDocument();
  });

  it('shows the dismissable pin-to-download promo bar above the rows', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderHome(source);
    await screen.findAllByTestId('item-row');

    expect(screen.getByText('Pin an article to download it')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(
      screen.queryByText('Pin an article to download it'),
    ).not.toBeInTheDocument();
  });

  it('does not show the promo bar on an empty feed', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    renderWithProviders(
      <ItemList viewKey={`empty-${Math.random()}`} fetchPage={fetchPage} emptyLabel="All caught up." />,
      { source },
    );
    // Wait for the empty state to settle (the bar must not be promised here —
    // there's nothing to pin).
    expect(await screen.findByText('All caught up.')).toBeInTheDocument();
    expect(
      screen.queryByText('Pin an article to download it'),
    ).not.toBeInTheDocument();
  });

  it('has a Back to top button in the bottom toolbar that scrolls to the top', async () => {
    const user = userEvent.setup();
    const scrollToSpy = vi.fn();
    vi.stubGlobal('scrollTo', scrollToSpy);
    const source = new MockDataSource(`test-${Math.random()}`);
    renderHome(source);
    await screen.findAllByTestId('item-row');

    const backToTop = screen.getByTestId('back-to-top');
    expect(backToTop).toHaveAccessibleName(/back to top/i);
    await user.click(backToTop);
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('prepends a pinned item to the top of the list', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    // Pin an item that is not already first.
    const page = await source.getHomeItems();
    const target = page.items[3].item;
    source.stateStore.set(target.id, 'pinned', true);

    renderHome(source);
    await waitFor(() => {
      const rows = screen.getAllByTestId('item-title');
      expect(rows[0]).toHaveTextContent(target.title);
    });
  });

  it('hiding an item via the row menu removes it from the list', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderHome(source);

    const firstRow = (await screen.findAllByTestId('item-row'))[0];
    const titleEl = within(firstRow).getByTestId('item-title');
    const titleText = titleEl.textContent;
    titleEl.focus();
    await user.keyboard(' ');
    const hide = await screen.findByTestId('item-row-menu-hide');
    await user.click(hide);

    await waitFor(() => {
      const titles = screen.queryAllByTestId('item-title').map((n) => n.textContent);
      expect(titles).not.toContain(titleText);
    });
  });

  it('Sweep hides all unpinned rows and Undo restores them', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderHome(source);
    await screen.findAllByTestId('item-row');

    await user.click(screen.getByTestId('sweep-btn'));
    await waitFor(() => {
      expect(screen.queryAllByTestId('item-row').length).toBe(0);
    });

    await user.click(screen.getByTestId('undo-btn'));
    await waitFor(() => {
      expect(screen.getAllByTestId('item-row').length).toBeGreaterThan(0);
    });
  });

  it('Sweep only hides rows fully in the viewport, leaving off-screen rows', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderHome(source);
    const rows = await screen.findAllByTestId('item-row');

    // Drop the last row below the "fully visible" threshold, as if it were
    // scrolled partway off-screen.
    const offScreen = rows[rows.length - 1];
    const offScreenTitle =
      within(offScreen).getByTestId('item-title').textContent;
    act(() => {
      setVisibilityForTest(offScreen.closest('li')!, 0.4);
    });

    await user.click(screen.getByTestId('sweep-btn'));

    // The off-screen row survives; it's the only row left.
    await waitFor(() => {
      const titles = screen
        .getAllByTestId('item-title')
        .map((n) => n.textContent);
      expect(titles).toEqual([offScreenTitle]);
    });
  });

  it('disables Sweep when no row is fully visible', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderHome(source);
    const rows = await screen.findAllByTestId('item-row');

    act(() => {
      for (const row of rows) {
        setVisibilityForTest(row.closest('li')!, 0.5);
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('sweep-btn')).toBeDisabled();
    });
  });

  describe('auto-hide on scroll (readmo:hide-on-scroll)', () => {
    it('marks an unpinned row Done once it scrolls off the top', async () => {
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const source = new MockDataSource(`test-${Math.random()}`);
      renderHome(source);

      const firstRow = (await screen.findAllByTestId('item-row'))[0];
      const titleText =
        within(firstRow).getByTestId('item-title').textContent;

      // Simulate the row scrolling fully off the top of the viewport.
      act(() => {
        setVisibilityForTest(firstRow.closest('li')!, 0);
      });

      await waitFor(() => {
        const titles = screen
          .queryAllByTestId('item-title')
          .map((n) => n.textContent);
        expect(titles).not.toContain(titleText);
      });
    });

    it('shields a pinned row from auto-hide', async () => {
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const source = new MockDataSource(`test-${Math.random()}`);
      // Pin the first item up front so it leads the list and stays put.
      const page = await source.getHomeItems();
      const pinned = page.items[0].item;
      source.stateStore.set(pinned.id, 'pinned', true);

      renderHome(source);
      const firstRow = (await screen.findAllByTestId('item-row'))[0];
      const titleEl = within(firstRow).getByTestId('item-title');
      expect(titleEl).toHaveTextContent(pinned.title);
      const titleText = titleEl.textContent;

      act(() => {
        setVisibilityForTest(firstRow.closest('li')!, 0);
      });

      // Give any (incorrect) hide a chance to flush, then assert it survived.
      await Promise.resolve();
      expect(
        screen.getAllByTestId('item-title').map((n) => n.textContent),
      ).toContain(titleText);
    });

    it('restores the whole scroll burst with one Undo', async () => {
      const user = userEvent.setup();
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const source = new MockDataSource(`test-${Math.random()}`);
      renderHome(source);

      const titles = () =>
        screen.queryAllByTestId('item-title').map((n) => n.textContent);

      let rows = await screen.findAllByTestId('item-row');
      const first = within(rows[0]).getByTestId('item-title').textContent;
      const second = within(rows[1]).getByTestId('item-title').textContent;

      // Scroll the first row off the top → auto-hidden.
      act(() => setVisibilityForTest(rows[0].closest('li')!, 0));
      await waitFor(() => expect(titles()).not.toContain(first));

      // Scroll the next row off too, within the batch window.
      rows = screen.getAllByTestId('item-row');
      act(() => setVisibilityForTest(rows[0].closest('li')!, 0));
      await waitFor(() => expect(titles()).not.toContain(second));

      // A single Undo brings back BOTH, not just the last one.
      await user.click(screen.getByTestId('undo-btn'));
      await waitFor(() => {
        const t = titles();
        expect(t).toContain(first);
        expect(t).toContain(second);
      });
    });

    it('leaves rows alone when the setting is off (default)', async () => {
      const source = new MockDataSource(`test-${Math.random()}`);
      renderHome(source);

      const firstRow = (await screen.findAllByTestId('item-row'))[0];
      const titleText =
        within(firstRow).getByTestId('item-title').textContent;

      act(() => {
        setVisibilityForTest(firstRow.closest('li')!, 0);
      });

      await Promise.resolve();
      expect(
        screen.getAllByTestId('item-title').map((n) => n.textContent),
      ).toContain(titleText);
    });

    it('does not let two feed views share an undo batch (unique burst keys)', async () => {
      const user = userEvent.setup();
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const source = new MockDataSource(`test-${Math.random()}`);
      const pool = (await source.getHomeItems()).items;
      const a = pool.slice(0, 2);
      const b = pool.slice(2, 4);
      // Each view returns its own slice, filtering out rows marked Done (as the
      // real feed query does) so an auto-hidden row drops on refetch.
      const fp = (items: typeof pool) => () =>
        Promise.resolve({
          items: items.filter((fi) => !source.stateStore.get(fi.item.id).done),
          nextCursor: null as string | null,
        });
      renderWithProviders(
        <>
          <ItemList viewKey="view-a" fetchPage={fp(a)} emptyLabel="x" />
          <ItemList viewKey="view-b" fetchPage={fp(b)} emptyLabel="x" />
        </>,
        { source },
      );
      const aTitle = a[0].item.title;
      const bTitle = b[0].item.title;
      await screen.findByText(aTitle);

      // Auto-hide a row on view A, then a row on view B (separate mounts whose
      // per-view batch counters both start at 0).
      act(() => setVisibilityForTest(screen.getByText(aTitle).closest('li')!, 0));
      await waitFor(() => expect(screen.queryByText(aTitle)).toBeNull());
      act(() => setVisibilityForTest(screen.getByText(bTitle).closest('li')!, 0));
      await waitFor(() => expect(screen.queryByText(bTitle)).toBeNull());

      // One Undo restores only the latest burst (B's row); A's stays hidden.
      await user.click(screen.getAllByTestId('undo-btn')[0]);
      await waitFor(() => expect(screen.getByText(bTitle)).toBeInTheDocument());
      expect(screen.queryByText(aTitle)).toBeNull();
    });
  });

  it('renders the More button inside the bottom toolbar', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const page = await source.getHomeItems();
    const { container } = renderPaged(source, page.items, 5);
    await screen.findAllByTestId('item-row');

    const more = screen.getByTestId('more-btn');
    expect(more).toHaveTextContent('More');
    expect(more.closest('.list-toolbar--bottom')).not.toBeNull();
    // It's the only More entry point — no standalone control above the bar.
    expect(container.querySelector('.item-list__more')).toBeNull();
  });

  it('does not show the More button until the first page lands', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const items = (await source.getHomeItems()).items;
    // Hold the first page open so the list stays in its loading state.
    let release: (page: {
      items: FeedItem[];
      nextCursor: string | null;
    }) => void = () => {};
    const fetchPage = vi.fn(
      () =>
        new Promise<{
          items: FeedItem[];
          nextCursor: string | null;
        }>((resolve) => {
          release = resolve;
        }),
    );
    renderWithProviders(
      <ItemList viewKey={`pending-${viewKeySeq++}`} fetchPage={fetchPage} />,
      { source },
    );

    // Skeletons are up; no exhausted-feed message should flash under them.
    await screen.findByTestId('back-to-top');
    expect(screen.queryByTestId('more-btn')).toBeNull();

    act(() => release({ items, nextCursor: null }));

    await screen.findAllByTestId('item-row');
    expect(screen.getByTestId('more-btn')).toHaveTextContent('No more items');
  });

  it('does not show the More button when the first page errors', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const fetchPage = vi.fn(() => Promise.reject(new Error('boom')));
    renderWithProviders(
      <ItemList viewKey={`err-${viewKeySeq++}`} fetchPage={fetchPage} />,
      { source },
    );

    // Error/retry UI, not an exhausted-feed message. Online + errored names the
    // action ("Unexpected response fetching the feed list") — NOT "offline" and
    // NOT the connectivity "isn't responding" lie, since the server did respond.
    await screen.findByText(/unexpected response fetching the feed list/i);
    expect(screen.queryByText(/isn’t responding/i)).toBeNull();
    expect(screen.queryByTestId('more-btn')).toBeNull();
  });

  it('shows error UI instead of empty label when a cached-empty feed refetch fails', async () => {
    // Simulate a returning visit: the persisted cache has an empty page from a
    // previous session, so React Query treats the next fetch as a background
    // refetch (not an initial load). In RQ v5 that keeps status=’success’ and
    // only sets query.error — isError stays false — so the bug was the empty
    // label silently showing instead of the error UI.
    const source = new MockDataSource(`test-${Math.random()}`);
    const viewKey = `cached-empty-err-${viewKeySeq++}`;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    queryClient.setQueryData(['feed', viewKey], {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [null],
    });

    const fetchPage = vi.fn(() => Promise.reject(new Error('network timeout')));
    renderWithProviders(
      <ItemList viewKey={viewKey} fetchPage={fetchPage} emptyLabel="All caught up." />,
      { source, queryClient },
    );

    // Must show the error/retry UI — NOT the empty label. Online + errored
    // names the action rather than blaming the connection.
    await screen.findByText(/unexpected response fetching the feed list/i);
    expect(screen.queryByText(/all caught up/i)).toBeNull();
  });

  it('says "offline" only when the device has no network, not on a server error', async () => {
    // Genuine disconnect: the browser reports offline. The list error must own
    // up to that ("you're offline"), distinct from the server-problem copy a
    // failed-but-reachable read gets.
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));

    const source = new MockDataSource(`test-${Math.random()}`);
    // 'offlineFirst' (the app's global networkMode) lets the read still attempt
    // and fail while offline → isError → the error UI; the default 'online' mode
    // would pause the query and never surface it.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, networkMode: 'offlineFirst' } },
    });
    const fetchPage = vi.fn(() => Promise.reject(new Error('boom')));
    renderWithProviders(
      <ItemList viewKey={`offline-${viewKeySeq++}`} fetchPage={fetchPage} />,
      { source, queryClient },
    );

    await screen.findByText(/you’re offline/i);
    expect(screen.queryByText(/server isn’t responding/i)).toBeNull();
  });

  it('does not claim "all caught up" on a successful empty result while offline', async () => {
    // The fetch *succeeds* but returns nothing — e.g. a stale service-worker
    // cache or a fresh-enough persisted-empty page that skips the refetch. With
    // no error, isError/refreshFailed stay false, so the bug was the reassuring
    // "all caught up" label rendering even though we never reached the server to
    // confirm it. Offline + empty must show the connectivity copy instead.
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));

    const source = new MockDataSource(`test-${Math.random()}`);
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    renderWithProviders(
      <ItemList
        viewKey={`offline-empty-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="You’re all caught up."
      />,
      { source },
    );

    await screen.findByText(/you’re offline/i);
    expect(screen.queryByText(/all caught up/i)).toBeNull();
  });

  it('still shows "all caught up" on a genuine empty feed while online', async () => {
    // The mirror of the offline case: online + empty is a real caught-up state,
    // so the empty label must still render (the offline guard mustn't swallow
    // it). navigator.onLine defaults to true here.
    const source = new MockDataSource(`test-${Math.random()}`);
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    renderWithProviders(
      <ItemList
        viewKey={`online-empty-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="You’re all caught up."
      />,
      { source },
    );

    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryByText(/you’re offline/i)).toBeNull();
  });

  it('forces a confirming refetch on reconnect before clearing the empty miss state', async () => {
    // Regression for the staleTime race: an empty page served from a stale cache
    // while offline can stay "fresh" under the 5-min staleTime, so when the
    // browser fires `online` and status flips, React Query wouldn't refetch — and
    // the caught-up label would render off that unconfirmed empty result. The
    // reconnect must force a refetch and hold a loading state until it confirms.
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));

    const source = new MockDataSource(`test-${Math.random()}`);
    // staleTime Infinity so the empty page stays fresh — isolating the explicit
    // reconnect refetch (which ignores staleTime) from onlineManager's
    // refetch-on-reconnect, which only fires for stale queries.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: Infinity, networkMode: 'offlineFirst' },
      },
    });

    // First (offline) read resolves empty immediately; the reconnect refetch is
    // held open behind `releaseRefetch` so we can assert the caught-up label
    // doesn't appear until it settles.
    const empty = { items: [] as FeedItem[], nextCursor: null };
    let releaseRefetch: (page: typeof empty) => void = () => {};
    let calls = 0;
    const fetchPage = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(empty);
      return new Promise<typeof empty>((resolve) => {
        releaseRefetch = resolve;
      });
    });

    renderWithProviders(
      <ItemList
        viewKey={`reconnect-${viewKeySeq++}`}
        fetchPage={fetchPage as FetchPage}
        emptyLabel="You’re all caught up."
      />,
      { source, queryClient },
    );

    // Offline + empty → miss-state, not a caught-up claim.
    await screen.findByText(/you’re offline/i);
    expect(screen.queryByText(/all caught up/i)).toBeNull();

    // Reconnect.
    act(() => {
      Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });

    // A confirming refetch fires; while it's in flight we must not claim caught up.
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/all caught up/i)).toBeNull();

    // The live server confirms the feed really is empty → now it's genuinely
    // caught up.
    act(() => {
      releaseRefetch(empty);
    });
    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
  });

  it('treats an in-flight fetch as the confirming one on reconnect (no double fetch)', async () => {
    // Regression: the recovering request flips status to 'online' (via
    // trackedFetch) before useInfiniteQuery resolves. The reconnect effect must
    // NOT call refetch() again over the cached empty data — that can cancel or
    // duplicate the in-flight request and discard a successful recovery.
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));

    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: Infinity, networkMode: 'offlineFirst' },
      },
    });

    // The (offlineFirst) read is held open the whole time, so it's still in
    // flight when we reconnect.
    const empty = { items: [] as FeedItem[], nextCursor: null };
    let release: (page: typeof empty) => void = () => {};
    const fetchPage = vi.fn(
      () => new Promise<typeof empty>((resolve) => {
        release = resolve;
      }),
    );

    renderWithProviders(
      <ItemList
        viewKey={`reconnect-inflight-${viewKeySeq++}`}
        fetchPage={fetchPage as FetchPage}
        emptyLabel="You’re all caught up."
      />,
      { source, queryClient },
    );

    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));

    // Reconnect while the fetch is still in flight — the guard must skip starting
    // a second one.
    await act(async () => {
      Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);

    // The in-flight fetch confirms empty → caught up, with only one request.
    act(() => {
      release(empty);
    });
    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('holds a loading state (no caught-up flash) when reconnecting mid-retry over cached-empty data', async () => {
    // Regression for the reconnect-while-fetching case: the user's Retry is in
    // flight and its recovering response flips status to 'online' before React
    // Query applies the page. We adopt that in-flight fetch as the confirming one
    // (no duplicate request) AND hold the loading state until it settles — so the
    // caught-up label never paints off the cached empty page in the meantime.
    const user = userEvent.setup();
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));

    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0, staleTime: Infinity, networkMode: 'offlineFirst' },
      },
    });

    const empty = { items: [] as FeedItem[], nextCursor: null };
    let releaseRetry: () => void = () => {};
    let calls = 0;
    const fetchPage = vi.fn(() => {
      calls += 1;
      // Initial offline read resolves empty; the Retry (2nd call) is held open so
      // it's still in flight when we reconnect.
      if (calls === 1) return Promise.resolve(empty);
      return new Promise<typeof empty>((resolve) => {
        releaseRetry = () => resolve(empty);
      });
    });

    renderWithProviders(
      <ItemList
        viewKey={`reconnect-midretry-${viewKeySeq++}`}
        fetchPage={fetchPage as FetchPage}
        emptyLabel="You’re all caught up."
      />,
      { source, queryClient },
    );

    // Offline + cached-empty → offline miss-state with a Retry.
    const retry = await screen.findByRole('button', { name: /retry/i });
    await user.click(retry);
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

    // Reconnect while the Retry is still in flight: no duplicate fetch, and we
    // must NOT yet claim caught up (nor still say offline) — the result isn't in.
    await act(async () => {
      Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/all caught up/i)).toBeNull();
    expect(screen.queryByText(/you’re offline/i)).toBeNull();

    // The adopted in-flight fetch confirms empty → now genuinely caught up.
    act(() => {
      releaseRetry();
    });
    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('does not flash caught-up while a boot/persist-restored empty feed is being validated', async () => {
    // A persisted empty page is restored on boot while the browser reports
    // online; the boot-time feed invalidation (refetchOnMount here) kicks off a
    // validating refetch. There's no offline→online transition, but the empty
    // label must still wait for that fetch to settle — not render "all caught up"
    // off the unconfirmed cached page while it's in flight.
    const source = new MockDataSource(`test-${Math.random()}`);
    const viewKey = `boot-empty-${viewKeySeq++}`;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    queryClient.setQueryData(['feed', viewKey], {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [null],
    });

    const empty = { items: [] as FeedItem[], nextCursor: null };
    let release: () => void = () => {};
    const fetchPage = vi.fn(
      () => new Promise<typeof empty>((resolve) => { release = () => resolve(empty); }),
    );

    renderWithProviders(
      <ItemList viewKey={viewKey} fetchPage={fetchPage as FetchPage} emptyLabel="You’re all caught up." />,
      { source, queryClient },
    );

    // The validating refetch is in flight over the empty cached page — a loading
    // state, NOT a caught-up claim.
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/all caught up/i)).toBeNull();

    // Validation confirms empty → now genuinely caught up.
    act(() => { release(); });
    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
  });

  it('More loads the next page, then disables as "No more items" when exhausted', async () => {
    const user = userEvent.setup();
    // The pager scrolls the new page into view (jsdom lacks scrollTo).
    vi.stubGlobal('scrollTo', vi.fn());
    const source = new MockDataSource(`test-${Math.random()}`);
    const items = (await source.getHomeItems()).items;
    const total = items.length;
    const pageSize = 4;
    expect(total).toBeGreaterThan(pageSize); // need at least one More click
    renderPaged(source, items, pageSize);

    let shown = Math.min(pageSize, total);
    await waitFor(() => {
      expect(screen.getAllByTestId('item-row')).toHaveLength(shown);
    });

    // Page through to the end; each click reveals the next chunk.
    while (shown < total) {
      await user.click(screen.getByTestId('more-btn'));
      shown = Math.min(shown + pageSize, total);
      await waitFor(() => {
        expect(screen.getAllByTestId('item-row')).toHaveLength(shown);
      });
    }

    const more = screen.getByTestId('more-btn');
    expect(more).toHaveTextContent('No more items');
    expect(more).toBeDisabled();
  });

  it('More scrolls the first row of the new page into view', async () => {
    const user = userEvent.setup();
    const scrollToSpy = vi.fn();
    vi.stubGlobal('scrollTo', scrollToSpy);
    // The bottom toolbar is pinned to the viewport foot, so the appended page
    // lands below the fold; the pager scrolls it up using the anchor row's
    // page-relative top (rect.top + scrollY − top chrome). With no chrome
    // measured and scrollY pinned at 1000, the target is exactly scrollY.
    Object.defineProperty(window, 'scrollY', { value: 1000, configurable: true });

    const source = new MockDataSource(`test-${Math.random()}`);
    const items = (await source.getHomeItems()).items;
    expect(items.length).toBeGreaterThan(4);
    renderPaged(source, items, 4);

    await waitFor(() => {
      expect(screen.getAllByTestId('item-row')).toHaveLength(4);
    });
    // Nothing scrolls until the reader taps More.
    expect(scrollToSpy).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('more-btn'));

    await waitFor(() => {
      expect(screen.getAllByTestId('item-row')).toHaveLength(8);
    });
    await waitFor(() => {
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
    });
  });

  it('Sweep works while a next-page fetch is in flight', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('scrollTo', vi.fn());

    const source = new MockDataSource(`test-${Math.random()}`);
    const pageSize = 4;
    // Capture the page-1 titles before anything is swept, so we can assert
    // they're gone afterwards.
    const page1 = await source.getHomeItems({ limit: pageSize });
    expect(page1.nextCursor).not.toBeNull(); // need a second page for isFetchingMore
    const page1Titles = page1.items.map((fi) => fi.item.title);

    // Gate on the page-2 fetch so we can interleave a sweep while it's in
    // flight. Page-1 fetches (cursor = null) always resolve immediately via
    // the real source so the refetch after sweep returns correctly-filtered
    // data (the real source reads stateStore at call time).
    let releaseNextPage: (() => void) | null = null;
    const fetchPage = vi.fn((cursor: string | null) => {
      if (cursor === null) {
        return source.getHomeItems({ limit: pageSize });
      }
      return new Promise<Awaited<ReturnType<typeof source.getHomeItems>>>((resolve) => {
        releaseNextPage = () =>
          void source.getHomeItems({ cursor, limit: pageSize }).then(resolve);
      });
    });

    renderWithProviders(
      <ItemList
        viewKey={`sweep-mid-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );

    // Wait for page 1.
    await waitFor(() => {
      expect(screen.getAllByTestId('item-row')).toHaveLength(pageSize);
    });

    // Trigger fetchNextPage — jsdom scrollHeight is 0 so atListEnd is true,
    // which means "More" goes directly to fetchMore() (not scroll behavior).
    await user.click(screen.getByTestId('more-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('more-btn')).toHaveTextContent('Loading…');
    });

    // Sweep while fetchNextPage is in flight.
    expect(screen.getByTestId('sweep-btn')).toBeEnabled();
    await user.click(screen.getByTestId('sweep-btn'));

    // Release the held page-2 fetch. TanStack Query v5 defaults cancelRefetch
    // to true, so the in-flight fetchNextPage is cancelled when invalidateQueries
    // fires and a fresh page-1 refetch starts. Even if the release fires first,
    // the stale result is discarded.
    act(() => { releaseNextPage?.(); });

    // The page-1 titles that were swept must not remain visible.
    await waitFor(() => {
      const visible = screen
        .queryAllByTestId('item-title')
        .map((el) => el.textContent);
      for (const title of page1Titles) {
        expect(visible).not.toContain(title);
      }
    });
  });

  it('More pages down through loaded rows, then settles on "No more items" at the foot', async () => {
    const user = userEvent.setup();
    // The page-down pager is a pinned-bar ('screen') behavior; in the default
    // relative mode the bar lives at the foot so "More" just fetches.
    window.localStorage.setItem(BOTTOM_BAR_KEY, 'screen');
    resetReadingPrefsCacheForTest();
    const scrollBySpy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBySpy);
    vi.stubGlobal('scrollTo', vi.fn());

    // The whole feed is loaded (one page, nothing more to fetch) but it's taller
    // than the viewport, so its foot sits below the fold. The pinned "More" must
    // not claim the feed is exhausted — it should offer to scroll down.
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 2400,
      configurable: true,
    });

    const source = new MockDataSource(`test-${Math.random()}`);
    const items = (await source.getHomeItems()).items;
    renderPaged(source, items, items.length); // one page holds everything

    await screen.findAllByTestId('item-row');

    const more = screen.getByTestId('more-btn');
    expect(more).toHaveTextContent('More');
    expect(more).toBeEnabled();

    // Tapping scrolls a page down rather than fetching (there's no next page).
    await user.click(more);
    expect(scrollBySpy).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'smooth' }),
    );

    // Once scrolled to the foot, "More" settles into a disabled "No more items".
    Object.defineProperty(window, 'scrollY', { value: 1600, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('more-btn')).toHaveTextContent('No more items');
    });
    expect(screen.getByTestId('more-btn')).toBeDisabled();
  });

  it('relative bar (default): More fetches the next page without a page-down scroll', async () => {
    const user = userEvent.setup();
    const scrollBySpy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBySpy);
    vi.stubGlobal('scrollTo', vi.fn());

    // Loaded rows extend below the fold AND another page is fetchable. In the
    // default relative mode "More" should fetch straight away (no second tap to
    // page down first), since the reader only reaches it at the list foot.
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 2400,
      configurable: true,
    });

    const source = new MockDataSource(`test-${Math.random()}`);
    const items = (await source.getHomeItems()).items;
    const { fetchPage } = renderPaged(source, items, 5); // multiple pages

    await screen.findAllByTestId('item-row');
    const callsBefore = fetchPage.mock.calls.length;

    await user.click(screen.getByTestId('more-btn'));

    await waitFor(() => {
      expect(fetchPage.mock.calls.length).toBeGreaterThan(callsBefore);
    });
    expect(scrollBySpy).not.toHaveBeenCalled();
  });
});
