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
  resetReadingPrefsCacheForTest,
} from '../hooks/useReadingPrefs';

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
    expect(cta).toHaveAttribute('href', '/settings');
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
