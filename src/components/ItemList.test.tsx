import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemList } from './ItemList';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { FeedItem } from '../lib/types';
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
    return Promise.resolve({ items: slice, nextCursor: next, total: items.length });
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
  });

  afterEach(() => {
    uninstallIntersectionObserverMock();
    vi.unstubAllGlobals();
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
      total: number;
    }) => void = () => {};
    const fetchPage = vi.fn(
      () =>
        new Promise<{
          items: FeedItem[];
          nextCursor: string | null;
          total: number;
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

    act(() => release({ items, nextCursor: null, total: items.length }));

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

    // Error/retry UI, not an exhausted-feed message.
    await screen.findByText(/couldn’t load items/i);
    expect(screen.queryByTestId('more-btn')).toBeNull();
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
});
