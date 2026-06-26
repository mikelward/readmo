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
  COLLAPSED_FEEDS_KEY,
  resetCollapsedFeedsCacheForTest,
} from '../hooks/useCollapsedFeeds';
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
    resetCollapsedFeedsCacheForTest();
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

  it('renders a feed-section header per feed when grouping by feed', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const { container } = renderWithProviders(
      <ItemList
        viewKey="home-grouped"
        fetchPage={(cursor) =>
          source.getHomeItems({ cursor, groupByFeed: true, limit: 100 })
        }
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');
    // Read the title element (the header also carries the unread-count badge).
    const titles = [
      ...container.querySelectorAll('.item-list__group-title'),
    ].map((t) => t.textContent);
    // Seed has four non-muted feeds with items (verge, nasa, css, reddit-prog).
    expect(titles).toEqual([
      'The Verge',
      'NASA Breaking News',
      'CSS-Tricks',
      'r/programming',
    ]);
  });

  it('shows a per-feed unread count badge in each group header', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`gp-${Math.random()}`}
        fetchPage={(cursor) =>
          source.getHomeItems({ cursor, groupByFeed: true, limit: 100 })
        }
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');
    // All seed items are unread by default: verge 3, nasa 2, css 3, reddit 2.
    await waitFor(() => {
      expect(container.querySelectorAll('.item-list__group-count')).toHaveLength(4);
    });
    expect(
      [...container.querySelectorAll('.item-list__group-count')].map((c) => c.textContent),
    ).toEqual(['3', '2', '3', '2']);
    // The count rides the collapse button's accessible name (the badge span is
    // aria-hidden), so screen readers announce it.
    expect(
      screen.getAllByTestId('group-toggle')[0].getAttribute('aria-label'),
    ).toContain('3 unread');
  });

  it('renders no section headers when not grouping', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const { container } = renderHome(source);
    await screen.findAllByTestId('item-row');
    expect(
      container.querySelectorAll('.item-list__group-header'),
    ).toHaveLength(0);
  });

  function renderGrouped(source: MockDataSource) {
    return renderWithProviders(
      <ItemList
        viewKey={`grouped-${Math.random()}`}
        fetchPage={(cursor) =>
          source.getHomeItems({ cursor, groupByFeed: true, limit: 100 })
        }
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
  }

  it('collapses a feed section from its header toggle, hiding only its rows', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const { container } = renderGrouped(source);
    await screen.findAllByTestId('item-row');
    const before = container.querySelectorAll('[data-item-id]').length;
    expect(before).toBeGreaterThan(0);

    // Collapse the first feed section (The Verge).
    const firstToggle = screen.getAllByTestId('group-toggle')[0];
    expect(firstToggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(firstToggle);

    expect(screen.getAllByTestId('group-toggle')[0]).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // Fewer rows now, but still more than zero (other feeds remain) and all four
    // headers still present.
    const after = container.querySelectorAll('[data-item-id]').length;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    expect(container.querySelectorAll('.item-list__group-header')).toHaveLength(4);
  });

  it('Collapse all hides every row; Expand all restores them', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const { container } = renderGrouped(source);
    await screen.findAllByTestId('item-row');
    const total = container.querySelectorAll('[data-item-id]').length;

    await user.click(screen.getByTestId('collapse-all-btn'));
    // Every section collapsed → no rows, but all four headers remain.
    expect(container.querySelectorAll('[data-item-id]')).toHaveLength(0);
    expect(container.querySelectorAll('.item-list__group-header')).toHaveLength(4);
    expect(screen.getByTestId('collapse-all-btn')).toBeDisabled();

    await user.click(screen.getByTestId('expand-all-btn'));
    expect(container.querySelectorAll('[data-item-id]')).toHaveLength(total);
  });

  it('auto-skips collapsed-only pages when tapping More until visible rows appear', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    // One item per page, so a collapsed feed spans several all-hidden pages.
    renderWithProviders(
      <ItemList
        viewKey={`gp-${Math.random()}`}
        fetchPage={(cursor) =>
          source.getHomeItems({ cursor, groupByFeed: true, limit: 1 })
        }
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    // Page 1 is The Verge's first item; collapse The Verge.
    await screen.findByTestId('item-row');
    await user.click(screen.getAllByTestId('group-toggle')[0]);
    expect(screen.queryAllByTestId('item-row')).toHaveLength(0); // all hidden now

    // One More tap should page through the remaining (hidden) Verge items and
    // land on the next feed's first visible row (NASA, item-2) — not stop on a
    // page that shows nothing new.
    await user.click(screen.getByTestId('more-btn'));
    expect(
      await screen.findByText(
        'Webb telescope captures a galaxy cluster bending light',
      ),
    ).toBeInTheDocument();
    // It stopped at the first visible feed — later feeds weren't pulled in.
    expect(
      screen.queryByText('Container queries are finally everywhere'),
    ).not.toBeInTheDocument();
  });

  it('re-measures end-of-list when sections collapse, so the pinned bar fetches instead of paging down', async () => {
    const user = userEvent.setup();
    // Pin the bottom bar to the viewport (where "More" is a pager).
    window.localStorage.setItem(BOTTOM_BAR_KEY, 'screen');
    resetReadingPrefsCacheForTest();
    // Tall document at mount → the loaded list end is NOT in view.
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 5000,
      configurable: true,
    });
    const scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    vi.stubGlobal('scrollTo', vi.fn());

    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(
      <ItemList
        viewKey={`pin-${Math.random()}`}
        fetchPage={(cursor) =>
          source.getHomeItems({ cursor, groupByFeed: true, limit: 3 })
        }
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    // Collapsing the first section shrinks the rendered list so the loaded end is
    // now in view — even though items.length is unchanged.
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 100,
      configurable: true,
    });
    await user.click(screen.getAllByTestId('group-toggle')[0]);

    // The pinned-bar "More" must now take the fetch branch (atListEnd re-measured
    // true), not the page-down branch — so it doesn't just scroll into nothing.
    await user.click(screen.getByTestId('more-btn'));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('stops auto-skip when an already-collapsed feed’s header first appears', async () => {
    const user = userEvent.setup();
    // Pre-collapse the first TWO feeds (The Verge, NASA).
    window.localStorage.setItem(
      COLLAPSED_FEEDS_KEY,
      JSON.stringify(['feed-verge', 'feed-nasa']),
    );
    resetCollapsedFeedsCacheForTest();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(
      <ItemList
        viewKey={`gp-${Math.random()}`}
        fetchPage={(cursor) =>
          source.getHomeItems({ cursor, groupByFeed: true, limit: 1 })
        }
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    // Page 1 is a Verge item (collapsed) — only its header shows, no rows.
    await screen.findByText('The Verge');
    expect(screen.queryAllByTestId('item-row')).toHaveLength(0);

    // One More tap pages through the rest of (collapsed) Verge and STOPS as soon
    // as NASA's header appears — even though NASA is also collapsed, its header is
    // new visible progress. It must not skip past it to CSS-Tricks.
    await user.click(screen.getByTestId('more-btn'));
    expect(await screen.findByText('NASA Breaking News')).toBeInTheDocument();
    expect(screen.queryByText('CSS-Tricks')).not.toBeInTheDocument();
  });

  it('shows no collapse controls when not grouping', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderHome(source);
    await screen.findAllByTestId('item-row');
    expect(screen.queryByTestId('collapse-all-btn')).toBeNull();
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

  it('per-feed header Sweep dismisses only that feed’s visible rows; header Undo restores them', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`gp-${Math.random()}`}
        fetchPage={(cursor) =>
          source.getHomeItems({ cursor, groupByFeed: true, limit: 100 })
        }
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');
    const totalBefore = container.querySelectorAll('[data-item-id]').length;

    // Sweep the first feed (The Verge, 3 rows) from its header broom.
    await user.click(screen.getAllByTestId('group-sweep')[0]);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-item-id]').length).toBe(totalBefore - 3);
    });
    // The other feeds are untouched (Verge's now-empty section drops out — a
    // swept feed has no items left, unlike a merely collapsed one).
    expect(screen.getByText('NASA Breaking News')).toBeInTheDocument();
    expect(screen.queryByText('The Verge')).toBeNull();

    // A header Undo restores the swept batch (the global single-level undo).
    await user.click(screen.getAllByTestId('group-undo')[0]);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-item-id]').length).toBe(totalBefore);
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

  it('drops a locally-done row from the list immediately (no blank gap waiting for refetch)', async () => {
    // Regression: marking a row Done flips the store synchronously, but the
    // cached page from React Query still carries it until an invalidating
    // refetch lands. If the refetch is slow, fails (offline), or returns the
    // same page because the backend hasn't picked up the change yet, the
    // swiped `<article>` stays translated off-screen while the parent `<li>`
    // keeps its 56px height — an indefinite blank gap. The view must drop
    // the dismissed row from the rendered list as soon as the store flips,
    // not wait for the data layer.
    //
    // Use a custom fetchPage that always returns the SAME page (regardless
    // of store state). This mirrors the "refetch ran but the server didn't
    // see the change" path and isolates the client-side filter from the
    // MockDataSource's own done filtering.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems();
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    renderWithProviders(
      <ItemList
        viewKey={`gap-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );

    const rowsBefore = await screen.findAllByTestId('item-row');
    // data-item-id sits on the parent `<li>`, not the `<article>`.
    const firstId = rowsBefore[0].closest('li')!.getAttribute('data-item-id');
    expect(firstId).not.toBeNull();
    const countBefore = rowsBefore.length;

    // Flip done directly on the store (what handleHide does at the timer
    // commit). The fetchPage above never filters, so without the
    // client-side visibleItems filter the row would stick around.
    act(() => {
      source.stateStore.set(firstId!, 'done', true);
    });

    await waitFor(() => {
      const after = screen.getAllByTestId('item-row');
      expect(after).toHaveLength(countBefore - 1);
      // The dismissed row's `<li>` (data-item-id wrapper) is gone — not
      // just hidden behind a transform.
      expect(
        document.querySelector(`[data-item-id="${firstId}"]`),
      ).toBeNull();
    });
  });

  it('holds the loading state when an in-flight refetch is racing a local Sweep (no premature caught-up flash)', async () => {
    // Regression: ItemRows.isLoading used to key off raw `items.length`, so
    // a swipe/Sweep that locally empties the rendered list while an
    // invalidating refetch was still in flight let the empty label flash
    // before the refetch settled. The loading guard must follow visibleItems
    // so an unconfirmed cache can't surface a false "you're all caught up".
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems();

    // First fetch lands immediately; the post-invalidation refetch is held
    // open so the test can observe the racing window.
    let release: ((page: Awaited<ReturnType<typeof source.getHomeItems>>) => void) | null = null;
    let callCount = 0;
    const fetchPage = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ items: seed.items, nextCursor: null });
      }
      return new Promise<{ items: FeedItem[]; nextCursor: string | null }>((resolve) => {
        release = (page) => resolve({ items: page.items, nextCursor: page.nextCursor });
      });
    });
    renderWithProviders(
      <ItemList
        viewKey={`sweep-mid-refetch-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="You're all caught up."
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    // Mark every row Done in one batch via hideMany — a single emit kicks
    // off one invalidating refetch (callCount → 2), which we hold open via
    // the gated promise. Per-id `set` calls would emit once each and
    // multiply the in-flight refetch count.
    act(() => {
      source.stateStore.hideMany(seed.items.map((fi) => fi.item.id));
    });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

    // Refetch still in flight: must NOT yet show the caught-up label. The
    // miss-state for online+empty doesn't apply here (status === 'online'),
    // so the only protection is the loading guard — which must follow
    // visibleItems, not raw items.
    expect(screen.queryByText(/all caught up/i)).toBeNull();

    // Let the held refetch land with a server-confirmed empty page.
    act(() => {
      release?.({ items: [], nextCursor: null });
    });
    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
  });

  it('freezes the list body height during a background refresh so the window scroll is not clamped to the top', async () => {
    // Regression: pinning/dismissing invalidates ['feed'], and React Query
    // refetches the infinite query's pages sequentially, so the rendered list
    // briefly shrinks mid-refetch. On a short document (e.g. collapsed feed
    // sections) that let the browser clamp window scrollY toward 0 — jumping the
    // reader to the top a couple of seconds after they acted. ItemList now
    // freezes the body's height for the duration of the refresh. jsdom has no
    // layout, so we stub offsetHeight and assert the min-height lock is applied
    // while the refresh is in flight and released once it settles.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems();

    let release: (() => void) | null = null;
    let callCount = 0;
    const fetchPage = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ items: seed.items, nextCursor: null });
      }
      // The post-invalidation refetch is held open so we can observe the lock.
      return new Promise<{ items: FeedItem[]; nextCursor: string | null }>((resolve) => {
        release = () => resolve({ items: seed.items, nextCursor: null });
      });
    });

    renderWithProviders(
      <ItemList
        viewKey={`refresh-lock-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    // jsdom reports 0 for offsetHeight; pretend the populated list is 1000px
    // tall so the lock has a concrete value to freeze.
    Object.defineProperty(body, 'offsetHeight', { value: 1000, configurable: true });

    // A pin emits one store change → useFeedInvalidation invalidates ['feed'] →
    // one background refetch (callCount → 2), held open below.
    act(() => {
      source.stateStore.set(seed.items[0].item.id, 'pinned', true);
    });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

    // Refresh in flight: the body height is frozen so the document can't shrink
    // under the scroll offset.
    expect(body.style.minHeight).toBe('1000px');

    // Refresh settles: the lock is released and natural height resumes.
    act(() => {
      release?.();
    });
    await waitFor(() => expect(body.style.minHeight).toBe(''));
  });

  it('re-measures end-of-list when a local Done shrinks the rendered list, so the pinned bar fetches instead of paging down', async () => {
    // Regression: renderedCount used to derive from raw `items`, so a local
    // Done that shrunk the rendered list (without a successful refetch) left
    // atListEnd stale — the screen-pinned bottom "More" button stayed on its
    // page-down branch even though the list had no more content below. The
    // re-measure trigger must follow visibleItems.
    const user = userEvent.setup();
    window.localStorage.setItem(BOTTOM_BAR_KEY, 'screen');
    resetReadingPrefsCacheForTest();
    // Tall document at mount → the loaded list end is NOT in view.
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 5000,
      configurable: true,
    });
    const scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    vi.stubGlobal('scrollTo', vi.fn());

    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems();
    // fetchPage ignores Done state — the cached page stays even when local
    // Done shrinks the rendered list. Mirrors the slow/failed-refetch path.
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    renderWithProviders(
      <ItemList
        viewKey={`shrink-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    // Shrink the rendered list by marking all but one row Done. The DOM
    // collapses, the document gets short enough that the foot is now in view.
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 100,
      configurable: true,
    });
    act(() => {
      for (const fi of seed.items.slice(0, -1)) {
        source.stateStore.set(fi.item.id, 'done', true);
      }
    });

    // The pinned-bar "More" must take the (disabled / no-more-items) branch
    // now that atListEnd has been re-measured to true, NOT the page-down
    // branch that would scroll into nothing. With the bug, renderedCount
    // wouldn't change → atListEnd would stay false → tapping More would
    // call scrollBy.
    await user.click(screen.getByTestId('more-btn'));
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('shows the offline copy (not "all caught up") when the visible list is emptied by local Done while offline', async () => {
    // Regression: showMissState used to key off raw `items.length`, but the
    // client-side visibleItems filter can empty the rendered list while the
    // cached `items` still has rows. If the device is offline at the same
    // time, the user can't confirm with the server that they're really
    // caught up — claiming so is the same lie the offline-empty guard
    // catches for the items=[] path. visibleItems must drive the guard.
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));

    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems();
    // staleTime Infinity + retry off so the cached page stays put and no
    // background refetch races us into a real empty state.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: 0,
          staleTime: Infinity,
          networkMode: 'offlineFirst',
        },
      },
    });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    renderWithProviders(
      <ItemList
        viewKey={`offline-overlay-empty-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="You're all caught up."
      />,
      { source, queryClient },
    );

    await screen.findAllByTestId('item-row');
    // Mark every cached row Done locally — visibleItems collapses to [].
    act(() => {
      for (const fi of seed.items) {
        source.stateStore.set(fi.item.id, 'done', true);
      }
    });

    // Offline + visibleItems=[] → the offline miss-state must surface, not
    // a "you're all caught up" empty-label flash.
    await screen.findByText(/you’re offline/i);
    expect(screen.queryByText(/all caught up/i)).toBeNull();
  });

  it('keeps the section header on the surviving row when the first-of-feed is locally done (grouped)', async () => {
    // Regression: groupHeaders used to key off the unfiltered `items` list,
    // so if the very first cached row of a feed section was locally marked
    // Done before the refetch landed, the header attached to a row that no
    // longer rendered — and the surviving rows of that feed sat without a
    // header. Header derivation must follow the visibleItems list.
    //
    // Use a fetchPage that ALWAYS returns the same sectioned page (ignores
    // local Done state) so useFeedInvalidation's refetch can't paper over
    // the bug by silently re-filtering at the source layer.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ groupByFeed: true, limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`grouped-first-done-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );

    await screen.findAllByTestId('item-row');
    const headersBefore = container.querySelectorAll('.item-list__group-header');
    expect(headersBefore.length).toBeGreaterThan(1);
    // First feed section's first row id is the header's data-header-for.
    const firstHeader = headersBefore[0] as HTMLElement;
    const firstSectionFirstId = firstHeader.getAttribute('data-header-for');
    expect(firstSectionFirstId).not.toBeNull();
    const headerCountBefore = headersBefore.length;

    // Locally mark that first-of-section row Done.
    act(() => {
      source.stateStore.set(firstSectionFirstId!, 'done', true);
    });

    // The dismissed row is gone; the same number of section headers must
    // remain — the first section's header now keys off the next visible
    // row of that feed. With the buggy `items`-based derivation, the
    // header for the removed id would never match any visibleItem and
    // the feed-1 header would vanish, dropping headersAfter.length by 1.
    await waitFor(() => {
      expect(
        document.querySelector(`[data-item-id="${firstSectionFirstId}"]`),
      ).toBeNull();
    });
    const headersAfter = container.querySelectorAll('.item-list__group-header');
    expect(headersAfter.length).toBe(headerCountBefore);
    // No header is orphaned to the removed id.
    expect(
      container.querySelector(`[data-header-for="${firstSectionFirstId}"]`),
    ).toBeNull();
  });

  it('Sweep plays a slide+fade on every unpinned row before hiding them', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    // Pin the first row so it stays put through the sweep — it must never wear
    // the animation class even while the unpinned rows are sliding out.
    const page = await source.getHomeItems();
    const pinnedTitle = page.items[0].item.title;
    source.stateStore.set(page.items[0].item.id, 'pinned', true);

    renderHome(source);
    await screen.findAllByTestId('item-row');

    await user.click(screen.getByTestId('sweep-btn'));

    // The hide is deferred until the sweep-out animation finishes, so the
    // unpinned rows stay in the DOM for a moment wearing `--sweeping`. The
    // pinned row never gets the class.
    const pinnedRow = screen.getByText(pinnedTitle).closest('li')!;
    expect(pinnedRow.className).not.toContain('item-list__row--sweeping');
    const sweepingRows = document.querySelectorAll('.item-list__row--sweeping');
    expect(sweepingRows.length).toBeGreaterThan(0);
    // The pinned row is still mounted alongside its sweeping peers.
    expect(screen.getByText(pinnedTitle)).toBeInTheDocument();

    // Fallback timer eventually commits the hide — only the pinned row
    // survives.
    await waitFor(() => {
      const rows = screen.getAllByTestId('item-row');
      expect(rows).toHaveLength(1);
      expect(within(rows[0]).getByTestId('item-title')).toHaveTextContent(
        pinnedTitle,
      );
    });
  });

  it('Sweep commits on animationend (not just the fallback timer)', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderHome(source);
    const rowsBefore = await screen.findAllByTestId('item-row');
    const firstTitle = within(rowsBefore[0]).getByTestId('item-title').textContent;

    await user.click(screen.getByTestId('sweep-btn'));

    // Rows are still mounted, wearing the sweeping class — the fallback
    // timer (400ms) hasn't fired yet.
    const sweeping = document.querySelectorAll('.item-list__row--sweeping');
    expect(sweeping.length).toBeGreaterThan(0);

    // Synthesize a matching animationend on one of the swept rows. Handler
    // filters by animationName === 'item-list__sweep-out' and commits once,
    // so the whole batch hides immediately.
    act(() => {
      const ev = new Event('animationend', { bubbles: true }) as AnimationEvent;
      Object.defineProperty(ev, 'animationName', {
        value: 'item-list__sweep-out',
      });
      sweeping[0].dispatchEvent(ev);
    });

    await waitFor(() => {
      const titles = screen.queryAllByTestId('item-title').map((n) => n.textContent);
      expect(titles).not.toContain(firstTitle);
    });
  });

  it('Sweep skips the animation and the delay when prefers-reduced-motion is set', async () => {
    const user = userEvent.setup();
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const source = new MockDataSource(`test-${Math.random()}`);
      renderHome(source);
      await screen.findAllByTestId('item-row');

      await user.click(screen.getByTestId('sweep-btn'));

      // Reduced-motion path hides immediately — rows gone on the very next
      // render, and no row ever wore the sweeping class.
      await waitFor(() => {
        expect(screen.queryAllByTestId('item-row').length).toBe(0);
      });
      expect(
        document.querySelector('.item-list__row--sweeping'),
      ).toBeNull();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
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

    it('ignores a swept row that also scrolls off mid-animation, so Undo restores it', async () => {
      // Race: tap Sweep (hide is deferred ~200ms for the animation), then
      // scroll a swept row off the top before the animation commits. Without
      // the guard, the keyed auto-hide fires first ("not done" baseline →
      // marks done), then Sweep's keyless commit fires with a "done"
      // baseline and replaces the auto-hide undo batch — Undo then leaves
      // that row hidden. With the guard, the auto-hide IO skips ids that
      // are mid-sweep, so Sweep's batch is the only one for those ids and
      // Undo restores them.
      const user = userEvent.setup();
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const source = new MockDataSource(`test-${Math.random()}`);
      renderHome(source);

      const rows = await screen.findAllByTestId('item-row');
      const firstTitle = within(rows[0]).getByTestId('item-title').textContent;

      // Tap Sweep — animation in flight, hide not yet committed.
      await user.click(screen.getByTestId('sweep-btn'));
      // The first row is mid-sweep; while wearing the animation class, the
      // IO reports it as fully off-screen (the user scrolled it past the top
      // after tapping the broom). The guard must reject this so the
      // auto-hide undo batch never claims this id.
      act(() => {
        setVisibilityForTest(rows[0].closest('li')!, 0);
      });

      // Let Sweep's fallback timer commit the deferred hide.
      await waitFor(() => {
        expect(screen.queryAllByTestId('item-row').length).toBe(0);
      });

      // Undo restores the swept batch — including the row that also scrolled
      // off mid-animation.
      await user.click(screen.getByTestId('undo-btn'));
      await waitFor(() => {
        const titles = screen
          .getAllByTestId('item-title')
          .map((n) => n.textContent);
        expect(titles).toContain(firstTitle);
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

  describe('per-section More (group by feed)', () => {
    // Synthetic FeedItems for two feeds with controllable depth, cloned from a
    // real seed row so every Item/Feed field is populated.
    async function makeRows() {
      const source = new MockDataSource(`tpl-${Math.random()}`);
      const tpl = (await source.getHomeItems()).items[0];
      const mk = (feedId: string, title: string, n: number): FeedItem => ({
        item: { ...tpl.item, id: `${feedId}-${n}`, feedId, title: `${title} ${n}` },
        feed: { ...tpl.feed, id: feedId, title },
      });
      return { source, mk };
    }

    it('grows one feed section inline, leaving the others untouched, until exhausted', async () => {
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      // Base page: feed A opens at the window (3 rows → may have more), feed B is
      // short (2 rows → fully shown, no More).
      const base = [
        // Feed A: window (3) + 1 overfetched has-more probe (A3) → More shows;
        // the probe is not rendered until expanded. Feed B is short → no More.
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
        mk('B', 'Feed B', 0), mk('B', 'Feed B', 1),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      // First More pages from the window edge (offset 3): the probe (A3) reappears
      // here as the first appended row, then A4; then A5 exhausts the feed.
      const aMore: Record<string, { items: FeedItem[]; nextCursor: string | null }> = {
        '3': { items: [mk('A', 'Feed A', 3), mk('A', 'Feed A', 4)], nextCursor: '5' },
        '5': { items: [mk('A', 'Feed A', 5)], nextCursor: null },
      };
      const fetchFeedPage = vi.fn((feedId: string, cursor: string | null) =>
        Promise.resolve(
          feedId === 'A' ? aMore[cursor ?? ''] ?? { items: [], nextCursor: null } : { items: [], nextCursor: null },
        ),
      );
      renderWithProviders(
        <ItemList
          viewKey={`psm-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={K}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');

      // Only feed A (full window) offers a More; the short feed B does not.
      const moreButtons = () => screen.queryAllByTestId('group-more');
      expect(moreButtons()).toHaveLength(1);
      expect(moreButtons()[0].getAttribute('data-feed-more')).toBe('A');

      // Tapping A's More appends its next page inside A's own section.
      await user.click(moreButtons()[0]);
      await screen.findByText('Feed A 3');
      expect(screen.getByText('Feed A 4')).toBeInTheDocument();
      // The appended rows stay within A's section — before feed B's rows.
      const ids = [...document.querySelectorAll('[data-item-id]')].map((el) =>
        el.getAttribute('data-item-id'),
      );
      expect(ids).toContain('A-4');
      expect(ids.indexOf('A-4')).toBeLessThan(ids.indexOf('B-0'));
      // A still has more, so its More persists.
      expect(moreButtons()).toHaveLength(1);

      // Tap again → the last row lands and the section is exhausted (More gone).
      await user.click(moreButtons()[0]);
      await screen.findByText('Feed A 5');
      expect(moreButtons()).toHaveLength(0);
      expect(fetchFeedPage).toHaveBeenCalledWith('A', '3');
      expect(fetchFeedPage).toHaveBeenCalledWith('A', '5');
    });

    it('shows no per-section More in the flat (non-grouped) view', async () => {
      const { source, mk } = await makeRows();
      const base = [mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2)];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      renderWithProviders(
        <ItemList viewKey={`psm-flat-${viewKeySeq++}`} fetchPage={fetchPage} emptyLabel="x" />,
        { source },
      );
      await screen.findAllByTestId('item-row');
      expect(screen.queryAllByTestId('group-more')).toHaveLength(0);
    });

    it('suppresses the global bottom More in the windowed grouped view', async () => {
      const { source, mk } = await makeRows();
      const base = [mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2)];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      const fetchFeedPage = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
      renderWithProviders(
        <ItemList
          viewKey={`psm-noglobal-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={3}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');
      // Back to top remains; the global More is gone (per-section Mores replace it).
      expect(screen.getByTestId('back-to-top')).toBeInTheDocument();
      expect(screen.queryByTestId('more-btn')).toBeNull();
    });

    it('keeps the global More for the overflow (row-cap) case', async () => {
      const { source, mk } = await makeRows();
      const base = [mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2)];
      // A non-null base cursor models the windowed read filling the row cap →
      // more feed-sections exist beyond this page, so the global More stays.
      const fetchPage = vi.fn((cursor: string | null) =>
        Promise.resolve(cursor ? { items: [], nextCursor: null } : { items: base, nextCursor: '1' }),
      );
      const fetchFeedPage = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
      renderWithProviders(
        <ItemList
          viewKey={`psm-overflow-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={3}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');
      expect(screen.getByTestId('more-btn')).toBeInTheDocument();
    });

    it('keeps a section’s More retryable after a failed first fetch', async () => {
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      // Window (3) + overfetched probe (A3) so the section offers a More.
      const base = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      let attempts = 0;
      const fetchFeedPage = vi.fn((_feedId: string, _cursor: string | null) => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('boom')) // first More fails
          : Promise.resolve({ items: [mk('A', 'Feed A', 3)], nextCursor: null });
      });
      renderWithProviders(
        <ItemList
          viewKey={`psm-retry-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={K}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');

      // First tap fails — nothing appended, button stays present and enabled.
      await user.click(screen.getByTestId('group-more'));
      await waitFor(() => expect(fetchFeedPage).toHaveBeenCalledTimes(1));
      expect(screen.queryByText('Feed A 3')).toBeNull();
      expect(screen.getByTestId('group-more')).toBeEnabled();

      // Retry pages from the SAME cursor and succeeds (no permanently-inert button).
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 3');
      expect(fetchFeedPage).toHaveBeenNthCalledWith(1, 'A', '3');
      expect(fetchFeedPage).toHaveBeenNthCalledWith(2, 'A', '3');
    });

    it('drops a feed’s extras when its base window membership shifts, re-paging fresh', async () => {
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      // Window (3) + overfetched probe (A3) so feed A offers a More.
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
        mk('B', 'Feed B', 0), mk('B', 'Feed B', 1),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      const fetchFeedPage = vi.fn((feedId: string, cursor: string | null) =>
        Promise.resolve(
          feedId === 'A' && cursor === '3'
            ? { items: [mk('A', 'Feed A', 3), mk('A', 'Feed A', 4)], nextCursor: null }
            : { items: [], nextCursor: null },
        ),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-reset-${viewKeySeq++}`;
      renderWithProviders(
        <ItemList
          viewKey={viewKey}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={K}
        />,
        { source, queryClient },
      );
      await screen.findAllByTestId('item-row');
      // Expand feed A so it holds offset-based extras.
      await user.click(screen.getAllByTestId('group-more')[0]);
      await screen.findByText('Feed A 3');

      // A new item arrives at the top of feed A, pushing 'Feed A 2' out of the
      // displayed window — membership changed, so A's old extras no longer align.
      // (Still window + probe so the section keeps offering a fresh More.)
      basePage = [
        mk('A', 'Feed A', 9), mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2),
        mk('B', 'Feed B', 0), mk('B', 'Feed B', 1),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });

      // The new top item shows; the now-misaligned extras are dropped and A
      // offers a fresh More from its new window (no skipped/duplicated rows).
      await screen.findByText('Feed A 9');
      await waitFor(() => expect(screen.queryByText('Feed A 3')).toBeNull());
      expect(screen.queryByText('Feed A 4')).toBeNull();
      expect(
        screen.getAllByTestId('group-more').map((b) => b.getAttribute('data-feed-more')),
      ).toContain('A');
    });

    it('shows no per-section More for an exactly-full feed (no overfetch probe)', async () => {
      const { source, mk } = await makeRows();
      const K = 3;
      // Exactly the window, no probe row survived → no More: no dead button, no
      // wasted empty fetch. All window rows still render.
      const base = [mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2)];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      const fetchFeedPage = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
      renderWithProviders(
        <ItemList
          viewKey={`psm-exact-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={K}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');
      expect(screen.queryAllByTestId('group-more')).toHaveLength(0);
      expect(screen.getAllByTestId('item-row')).toHaveLength(3);
      expect(fetchFeedPage).not.toHaveBeenCalled();
    });

    it('discards an in-flight More response after the window resets mid-fetch', async () => {
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      // Hold the More response open so we can reset the window before it settles.
      let release: (() => void) | null = null;
      const fetchFeedPage = vi.fn(
        () =>
          new Promise<{ items: FeedItem[]; nextCursor: string | null }>((resolve) => {
            release = () =>
              resolve({ items: [mk('A', 'Feed A', 3), mk('A', 'Feed A', 4)], nextCursor: null });
          }),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-stale-${viewKeySeq++}`;
      renderWithProviders(
        <ItemList
          viewKey={viewKey}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={K}
        />,
        { source, queryClient },
      );
      await screen.findAllByTestId('item-row');

      // Start a More (in flight, gated open).
      await user.click(screen.getByTestId('group-more'));
      await waitFor(() => expect(fetchFeedPage).toHaveBeenCalledTimes(1));

      // The window membership shifts while the More is in flight — the reset
      // effect drops feed A's extras entry.
      basePage = [
        mk('A', 'Feed A', 9), mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await screen.findByText('Feed A 9');

      // Release the now-stale response: it must NOT write its old-offset page back
      // over the fresh window.
      await act(async () => {
        release?.();
        await Promise.resolve();
      });
      expect(screen.queryByText('Feed A 4')).toBeNull();
      expect(screen.queryByText('Feed A 3')).toBeNull();
    });
  });
});
