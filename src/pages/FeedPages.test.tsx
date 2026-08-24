import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
import { useHomeFeed, type HomeFeed } from '../hooks/useHomeFeed';
import { FeedPage, HomePage } from './FeedPages';
import {
  GROUP_BY_FEED_KEY,
  ITEM_SORT_KEY,
  ARTICLES_PER_PAGE_KEY,
  ARTICLES_PER_SECTION_KEY,
  resetReadingPrefsCacheForTest,
} from '../hooks/useReadingPrefs';
import { DEFAULT_ARTICLES_PER_PAGE } from '../lib/types';

function renderFeed(source: MockDataSource, feedId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/feed/:feedId" element={<FeedPage />} />
    </Routes>,
    { source, route: `/feed/${feedId}` },
  );
}

/** A MockDataSource with every seeded subscription removed — a brand-new
 * account that hasn't added any feeds yet. */
async function emptyAccount(): Promise<MockDataSource> {
  const source = new MockDataSource(`test-${Math.random()}`);
  for (const { feed } of await source.getSubscriptions()) {
    await source.unsubscribe(feed.id);
  }
  return source;
}

/** Sets the per-device Home preference (the drawer's folder/all picker) via the
 * real hook so HomePage sees it through `useHomeFeed`. */
function HomeFeedSetter({ feed }: { feed: HomeFeed }) {
  const { setHomeFeed } = useHomeFeed();
  useEffect(() => {
    setHomeFeed(feed);
  }, [feed, setHomeFeed]);
  return null;
}

describe('HomePage (no-feeds coach)', () => {
  // The Home preference lives in a module-level cache in useHomeFeed; reset it
  // to 'all' after each case so a folder override set in one test can't leak
  // into the next.
  afterEach(async () => {
    await act(async () => {
      renderWithProviders(<HomeFeedSetter feed={{ kind: 'all' }} />);
    });
  });

  it('coaches a subscription-less account to add a feed instead of "all caught up"', async () => {
    const source = await emptyAccount();
    renderWithProviders(<HomePage />, { source, route: '/' });

    const coach = await screen.findByTestId('home-empty-coach');
    expect(coach).toHaveTextContent('No feeds yet');
    const cta = screen.getByRole('link', { name: /add a feed/i });
    expect(cta).toHaveAttribute('href', '/feeds');
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
  });

  it('shows the feed (not the coach) once subscriptions exist', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(<HomePage />, { source, route: '/' });

    await screen.findAllByTestId('item-row');
    expect(screen.queryByTestId('home-empty-coach')).not.toBeInTheDocument();
  });

  it('does not strand on the coach when the cached subscriptions are a stale empty array', async () => {
    // The account actually has feeds (seeded), but this device's persisted
    // React Query cache holds an empty ['subscriptions'] from a prior sync,
    // still "fresh" under the production 5-minute staleTime.
    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } },
    });
    queryClient.setQueryData(['subscriptions'], []);

    renderWithProviders(<HomePage />, { source, queryClient, route: '/' });

    // refetchOnMount:'always' re-reads, finds the real subscriptions, and the
    // feed mounts — the coach must not win on the stale empty value.
    await screen.findAllByTestId('item-row');
    expect(screen.queryByTestId('home-empty-coach')).not.toBeInTheDocument();
  });

  it('does not show the coach when the forced subscriptions refresh fails over a stale empty cache', async () => {
    // Offline/outage: the persisted cache holds an empty ['subscriptions'], the
    // forced mount refetch rejects, and the account actually has feeds. The
    // failed refetch leaves `subs` stale but flips the result to status 'error'
    // (isSuccess false), so the coach must not render from it.
    const source = new MockDataSource(`test-${Math.random()}`);
    vi.spyOn(source, 'getSubscriptions').mockRejectedValue(new Error('offline'));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } },
    });
    queryClient.setQueryData(['subscriptions'], []);

    renderWithProviders(<HomePage />, { source, queryClient, route: '/' });

    // The feed view (its own read) mounts and shows items; no coach.
    await screen.findAllByTestId('item-row');
    expect(screen.queryByTestId('home-empty-coach')).not.toBeInTheDocument();
  });

  it('coaches even when Home is pinned to a folder, if there are no subscriptions', async () => {
    const source = await emptyAccount();
    renderWithProviders(
      <>
        <HomeFeedSetter feed={{ kind: 'folder', name: 'News' }} />
        <HomePage />
      </>,
      { source, route: '/' },
    );

    // The zero-subscription coach wins over the folder override; the user isn't
    // stranded on a dead-end "No items in News." folder empty state.
    expect(await screen.findByTestId('home-empty-coach')).toBeInTheDocument();
    expect(screen.queryByText(/No items in News/)).not.toBeInTheDocument();
  });
});

describe('HomePage (group-by-feed toolbar toggle)', () => {
  afterEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });

  it('toggles the readmo:group-by-feed preference from the top toolbar', async () => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(<HomePage />, { source, route: '/' });

    await screen.findAllByTestId('item-row');
    const toggle = screen.getByTestId('group-by-feed-btn');
    // Default off: flat river, no section headers.
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(window.localStorage.getItem(GROUP_BY_FEED_KEY)).not.toBe('1');

    await user.click(toggle);

    // The persisted preference flips on, and the view re-keys into the grouped
    // layout (section headers appear).
    expect(window.localStorage.getItem(GROUP_BY_FEED_KEY)).toBe('1');
    await waitFor(() => {
      expect(
        document.querySelectorAll('.item-list__group-header').length,
      ).toBeGreaterThan(0);
    });
    expect(screen.getByTestId('group-by-feed-btn')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('fetches the grouped view in one batched read with no client-side fetch cap', async () => {
    // The grouped home read is ONE request carrying every section in full —
    // not a request per feed. The client sends no per-feed fetch cap (the
    // server decides what each section carries; SPEC: More reveals fetched
    // rows until they're spent).
    window.localStorage.setItem(GROUP_BY_FEED_KEY, '1');
    resetReadingPrefsCacheForTest();
    const source = new MockDataSource(`test-${Math.random()}`);
    const spy = vi.spyOn(source, 'getHomeItems');
    renderWithProviders(<HomePage />, { source, route: '/' });

    await screen.findAllByTestId('item-row');
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ groupByFeed: true }),
    );
    expect(spy).not.toHaveBeenCalledWith(
      expect.objectContaining({ perFeedLimit: expect.anything() }),
    );
  });
});

describe('Feed views (article load sizes)', () => {
  afterEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
    vi.restoreAllMocks();
  });

  it('sends the default page size on the flat home read', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const spy = vi.spyOn(source, 'getHomeItems');
    renderWithProviders(<HomePage />, { source, route: '/' });

    await screen.findAllByTestId('item-row');
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: DEFAULT_ARTICLES_PER_PAGE }),
    );
  });

  it('sends the persisted page size on the flat home read', async () => {
    window.localStorage.setItem(ARTICLES_PER_PAGE_KEY, '10');
    resetReadingPrefsCacheForTest();
    const source = new MockDataSource(`test-${Math.random()}`);
    const spy = vi.spyOn(source, 'getHomeItems');
    renderWithProviders(<HomePage />, { source, route: '/' });

    await screen.findAllByTestId('item-row');
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
    expect(spy).not.toHaveBeenCalledWith(
      expect.objectContaining({ limit: DEFAULT_ARTICLES_PER_PAGE }),
    );
  });

  it('sends the persisted page size on a single feed read', async () => {
    window.localStorage.setItem(ARTICLES_PER_PAGE_KEY, '10');
    resetReadingPrefsCacheForTest();
    const source = new MockDataSource(`test-${Math.random()}`);
    const spy = vi.spyOn(source, 'getFeedItems');
    renderFeed(source, 'feed-verge');

    await screen.findAllByTestId('item-row');
    expect(spy).toHaveBeenCalledWith(
      'feed-verge',
      expect.objectContaining({ limit: 10 }),
    );
  });

  // The size in effect is folded into the view key, so changing it restarts the
  // view at its first page rather than appending a differently-sized page onto
  // the offsets the old size produced.
  it('re-reads from the first page when the page size changes', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const spy = vi.spyOn(source, 'getHomeItems');
    const { rerender } = renderWithProviders(<HomePage />, {
      source,
      route: '/',
    });

    await screen.findAllByTestId('item-row');
    spy.mockClear();

    act(() => {
      window.localStorage.setItem(ARTICLES_PER_PAGE_KEY, '10');
      window.dispatchEvent(new Event('readmo:reading-pref-changed'));
    });
    rerender(<HomePage />);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, cursor: null }),
      );
    });
  });

  // Grouped, the client sends NO fetch cap — the server decides what each
  // section carries. Sending the flat page size here would cap the deep read
  // and truncate the later sections.
  it('sends no limit on the grouped read, whatever the page size', async () => {
    window.localStorage.setItem(GROUP_BY_FEED_KEY, '1');
    window.localStorage.setItem(ARTICLES_PER_PAGE_KEY, '10');
    resetReadingPrefsCacheForTest();
    const source = new MockDataSource(`test-${Math.random()}`);
    const spy = vi.spyOn(source, 'getHomeItems');
    renderWithProviders(<HomePage />, { source, route: '/' });

    await screen.findAllByTestId('item-row');
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ groupByFeed: true }),
    );
    for (const [opts] of spy.mock.calls) {
      expect(opts?.limit).toBeUndefined();
    }
  });

  // Every offered size, so a section window pinned back to a constant fails.
  // The section window is a display window over the one deep read — it never
  // reaches the server.
  it.each([10, 20, 30])(
    'opens each grouped section at %i rows',
    async (size) => {
      window.localStorage.setItem(GROUP_BY_FEED_KEY, '1');
      window.localStorage.setItem(ARTICLES_PER_SECTION_KEY, String(size));
      resetReadingPrefsCacheForTest();
      const source = new MockDataSource(`test-${Math.random()}`);
      // One feed carrying more rows than any offered size, so the rendered
      // count is the window rather than the whole set. The grouped read carries
      // every section in full (no client fetch cap), so the page is the feed.
      const [sample] = (await source.getHomeItems()).items;
      const many = Array.from({ length: 35 }, (_, i) => ({
        ...sample,
        item: { ...sample.item, id: `bulk-${i}`, guid: `bulk-guid-${i}` },
      }));
      vi.spyOn(source, 'getHomeItems').mockResolvedValue({
        items: many,
        nextCursor: null,
      });
      renderWithProviders(<HomePage />, { source, route: '/' });

      await waitFor(() => {
        expect(screen.getAllByTestId('item-row')).toHaveLength(size);
      });
    },
  );

  // Guardrail 11: the view key is what the persisted query cache is stored
  // under, so a default-sized view must keep the exact key it had before the
  // sizes were configurable — otherwise a PWA that upgrades and opens OFFLINE
  // meets an empty query instead of its cached articles. (Codex P2 on #667.)
  it.each([
    { label: 'flat home', route: '/', grouped: false, key: 'home-all:newest:flat' },
    {
      label: 'grouped home',
      route: '/',
      grouped: true,
      key: 'home-all:newest:grouped',
    },
  ])('keys the default-sized $label view legacily', async ({ grouped, key }) => {
    if (grouped) window.localStorage.setItem(GROUP_BY_FEED_KEY, '1');
    resetReadingPrefsCacheForTest();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(<HomePage />, { source, route: '/', queryClient });

    await screen.findAllByTestId('item-row');
    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey)
      .filter((k) => k[0] === 'feed')
      .map((k) => k[1]);
    expect(keys).toContain(key);
  });

  it('keys the default-sized single-feed view legacily', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(
      <Routes>
        <Route path="/feed/:feedId" element={<FeedPage />} />
      </Routes>,
      { source, route: '/feed/feed-verge', queryClient },
    );

    await screen.findAllByTestId('item-row');
    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey)
      .filter((k) => k[0] === 'feed')
      .map((k) => k[1]);
    expect(keys).toContain('feed:feed-verge:newest');
  });

  // A chosen non-default size does take its own key — different size, different
  // page contents, so sharing the default's cache would be wrong.
  it('keys a non-default page size distinctly', async () => {
    window.localStorage.setItem(ARTICLES_PER_PAGE_KEY, '10');
    resetReadingPrefsCacheForTest();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(<HomePage />, { source, route: '/', queryClient });

    await screen.findAllByTestId('item-row');
    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey)
      .filter((k) => k[0] === 'feed')
      .map((k) => k[1]);
    expect(keys).toContain('home-all:newest:flat:10');
  });

  // The section window is display-only over a read that already carries every
  // section in full, so keying the query on it would discard the cached
  // response to re-window rows already in hand — and offline, replace a good
  // cached list with an error. (Codex P1 on #667.)
  it('does not refetch the grouped view when the section window changes', async () => {
    window.localStorage.setItem(GROUP_BY_FEED_KEY, '1');
    resetReadingPrefsCacheForTest();
    const source = new MockDataSource(`test-${Math.random()}`);
    const spy = vi.spyOn(source, 'getHomeItems');
    const { rerender } = renderWithProviders(<HomePage />, {
      source,
      route: '/',
    });

    await screen.findAllByTestId('item-row');
    spy.mockClear();

    act(() => {
      window.localStorage.setItem(ARTICLES_PER_SECTION_KEY, '20');
      window.dispatchEvent(new Event('readmo:reading-pref-changed'));
    });
    rerender(<HomePage />);

    await screen.findAllByTestId('item-row');
    expect(spy).not.toHaveBeenCalled();
  });

  // …but it must still re-window, in BOTH directions. The seeding effect only
  // ever extends a section (the sticky window is what stops rows moving under
  // the reader), so a SHRINK is the case that needs ItemList's explicit reset.
  it.each([
    { from: '10', to: '20' },
    { from: '20', to: '10' },
  ])(
    're-windows grouped sections from $from to $to with no refetch',
    async ({ from, to }) => {
      window.localStorage.setItem(GROUP_BY_FEED_KEY, '1');
      window.localStorage.setItem(ARTICLES_PER_SECTION_KEY, from);
      resetReadingPrefsCacheForTest();
      const source = new MockDataSource(`test-${Math.random()}`);
      const [sample] = (await source.getHomeItems()).items;
      const many = Array.from({ length: 35 }, (_, i) => ({
        ...sample,
        item: { ...sample.item, id: `bulk-${i}`, guid: `bulk-guid-${i}` },
      }));
      const spy = vi
        .spyOn(source, 'getHomeItems')
        .mockResolvedValue({ items: many, nextCursor: null });
      const { rerender } = renderWithProviders(<HomePage />, {
        source,
        route: '/',
      });

      await waitFor(() => {
        expect(screen.getAllByTestId('item-row')).toHaveLength(Number(from));
      });
      spy.mockClear();

      act(() => {
        window.localStorage.setItem(ARTICLES_PER_SECTION_KEY, to);
        window.dispatchEvent(new Event('readmo:reading-pref-changed'));
      });
      rerender(<HomePage />);

      await waitFor(() => {
        expect(screen.getAllByTestId('item-row')).toHaveLength(Number(to));
      });
      expect(spy).not.toHaveBeenCalled();
    },
  );

  // The section window doesn't reach the read at all, so changing it must not
  // re-key the flat view and cost a refetch.
  it('does not refetch the flat view when the section window changes', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const spy = vi.spyOn(source, 'getHomeItems');
    const { rerender } = renderWithProviders(<HomePage />, {
      source,
      route: '/',
    });

    await screen.findAllByTestId('item-row');
    spy.mockClear();

    act(() => {
      window.localStorage.setItem(ARTICLES_PER_SECTION_KEY, '30');
      window.dispatchEvent(new Event('readmo:reading-pref-changed'));
    });
    rerender(<HomePage />);

    await screen.findAllByTestId('item-row');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('HomePage (sort-order toolbar toggle)', () => {
  afterEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });

  it('toggles the readmo:item-sort preference from the top toolbar', async () => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(<HomePage />, { source, route: '/' });

    await screen.findAllByTestId('item-row');
    const toggle = screen.getByTestId('sort-order-btn');
    // Default newest-first.
    expect(toggle).toHaveAccessibleName('Newest first');
    expect(window.localStorage.getItem(ITEM_SORT_KEY)).not.toBe('oldest');

    await user.click(toggle);

    // The persisted preference flips, and the re-keyed view re-reads oldest-first.
    expect(window.localStorage.getItem(ITEM_SORT_KEY)).toBe('oldest');
    await waitFor(() => {
      expect(screen.getByTestId('sort-order-btn')).toHaveAccessibleName(
        'Oldest first',
      );
    });
  });
});

describe('FeedPage (parked-feed retry)', () => {
  // `feed-park` is seeded with parked: true (src/lib/data/seed.ts).
  it('clears the retry badge after a successful retry', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderFeed(source, 'feed-park');

    const retry = await screen.findByRole('button', {
      name: /Feed has errors · Retry now/,
    });
    await user.click(retry);

    // The mutation invalidates ['feed-meta', …]; the refetched, un-parked feed
    // removes the badge without any remount.
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Feed has errors · Retry now/ }),
      ).toBeNull();
    });
  });

  it('offers the sort toggle but not the group toggle on a single feed', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderFeed(source, 'feed-verge');
    await screen.findAllByTestId('item-row');
    // Sort applies to a single feed; grouping is a no-op there.
    expect(screen.getByTestId('sort-order-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('group-by-feed-btn')).toBeNull();
  });
});

describe('FeedPage (feed settings link)', () => {
  it('links the header pencil to the feed-management page', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderFeed(source, 'feed-verge');
    // The pencil is the route to rename / mute / unsubscribe this feed.
    const link = await screen.findByTestId('feed-settings-link');
    // The `feed` query param tells the Feeds page which row to scroll to.
    expect(link).toHaveAttribute('href', '/feeds?feed=feed-verge');
    expect(link).toHaveAccessibleName('Feed settings');
  });
});

describe('FeedPage (header favicon)', () => {
  it("shows the feed's favicon left of the title", async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderFeed(source, 'feed-verge');
    const favicon = await screen.findByTestId('feed-header-favicon');
    // The Verge's favicon, decorative, inside the page-header title.
    expect(favicon).toHaveAttribute('src', 'https://www.theverge.com/favicon.ico');
    expect(favicon).toHaveAttribute('alt', '');
    expect(favicon.closest('.page-header__title')).not.toBeNull();
  });

  it('shows an initials badge when the feed advertises no favicon', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const verge = (await source.getFeed('feed-verge'))!;
    vi.spyOn(source, 'getFeed').mockResolvedValue({ ...verge, faviconUrl: null });
    renderFeed(source, 'feed-verge');
    await screen.findByRole('heading', { level: 1, name: 'The Verge' });
    // No <img>, but the feed's initials badge (The Verge → "V") stands in.
    const badge = screen.getByTestId('feed-header-favicon');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).toHaveClass('favicon--initials');
    expect(badge.textContent).toBe('V');
  });
});
