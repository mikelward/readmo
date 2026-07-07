import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemList } from './ItemList';
import type { FetchPage } from '../hooks/useFeedItems';
import { MockDataSource } from '../lib/data/MockDataSource';
import { _resetNetworkStatusForTests } from '../lib/networkStatus';
import { DEFAULT_ITEM_STATE, type FeedItem } from '../lib/types';
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

/** Record every write to `el.style.overflowAnchor`, returning the history array.
 * The sweep's anchor opt-out is applied and then dropped a frame later (a
 * post-paint effect), so its `none` value isn't observable on the element by the
 * time `act()` has flushed effects — capturing the write history is how a test
 * proves the opt-out was applied at all, and that it ends cleared. */
function recordOverflowAnchorWrites(el: HTMLElement): string[] {
  const writes: string[] = [];
  let value = el.style.overflowAnchor;
  Object.defineProperty(el.style, 'overflowAnchor', {
    configurable: true,
    get: () => value,
    set: (next: string) => {
      value = next;
      writes.push(next);
    },
  });
  return writes;
}

// Install a faithful-enough scroll/layout model on jsdom (which otherwise has
// none): the body's height is the larger of its natural content (rendered rows ×
// rowHeight) and any applied min-height, the document's scrollHeight tracks it
// (plus any fixed `chromeHeight` above the body), and window.scrollY is clamped
// to [0, scrollHeight − innerHeight] on every read. So clearing a min-height lock
// that leaves the document shorter than the offset clamps the scroll toward the
// top exactly as a real browser would — which is what lets these tests fail if
// the scroll-preservation logic regresses. Two real-browser subtleties are
// modeled deliberately: `documentElement.scrollHeight` is floored at the viewport
// height (a sub-viewport document still reports one viewport tall), and the body
// exposes a document-space `getBoundingClientRect().top` (chrome − scroll). The
// release logic relies on both — a scrollHeight-based deficit under-provisions a
// sub-viewport document, so it measures the body top instead. Returns helpers to
// drive and read the (clamped) scroll position.
function installScrollModel(
  body: HTMLElement,
  container: HTMLElement,
  {
    innerHeight,
    rowHeight,
    chromeHeight = 0,
    footerHeight = 0,
  }: {
    innerHeight: number;
    rowHeight: number;
    chromeHeight?: number;
    footerHeight?: number;
  },
) {
  let rawScrollY = 0;
  // When set, overrides the row-count-derived natural height — used to model the
  // momentary, self-inflicted document collapse a dismiss triggers (the list
  // reflows to a far shorter height for a beat, then recovers). The min-height
  // freeze must span it; `bodyHeight` still floors at any applied min-height, so
  // an engaged freeze keeps the document tall through the injected collapse.
  let naturalOverride: number | null = null;
  const naturalHeight = () =>
    naturalOverride ??
    container.querySelectorAll('[data-item-id]').length * rowHeight;
  const bodyHeight = () =>
    Math.max(naturalHeight(), parseFloat(body.style.minHeight) || 0);
  // Real browsers floor documentElement.scrollHeight at the viewport height, so a
  // document shorter than one viewport still reports a viewport tall. `chrome`
  // sits above the body, `footer` (the relative-mode bottom toolbar / refresh
  // strip) in flow below it — both count toward the document height but only
  // chrome shifts the body's top.
  // The live viewport height. Mutable so a test can model a transient
  // window.innerHeight change (Chromium's dynamic toolbar momentarily reporting
  // a doubled viewport at the bottom) — which shrinks maxScroll and clamps the
  // scroll even though scrollHeight is unchanged.
  let vh = innerHeight;
  const docHeight = () =>
    Math.max(chromeHeight + bodyHeight() + footerHeight, vh);
  const maxScroll = () => Math.max(0, docHeight() - vh);
  const clamped = () => Math.min(Math.max(0, rawScrollY), maxScroll());
  Object.defineProperty(body, 'offsetHeight', { configurable: true, get: bodyHeight });
  // The body sits `chromeHeight` below the document top; getBoundingClientRect
  // reports its position relative to the (scrolled) viewport.
  body.getBoundingClientRect = () =>
    ({ top: chromeHeight - clamped(), bottom: chromeHeight - clamped() + bodyHeight(), left: 0, right: 0, width: 0, height: bodyHeight(), x: 0, y: chromeHeight - clamped(), toJSON: () => ({}) }) as DOMRect;
  // The `.item-list` root spans chrome → body → footer; its bottom sits a footer's
  // height below the body's bottom (floor-free, unlike documentElement.scrollHeight).
  const root = body.closest('.item-list');
  if (root instanceof HTMLElement) {
    root.getBoundingClientRect = () => {
      const bottom = chromeHeight + bodyHeight() + footerHeight - clamped();
      return { top: -clamped(), bottom, left: 0, right: 0, width: 0, height: chromeHeight + bodyHeight() + footerHeight, x: 0, y: -clamped(), toJSON: () => ({}) } as DOMRect;
    };
  }
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    get: docHeight,
  });
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => vh });
  // The visual viewport reports the TRUE visible height — it does NOT follow the
  // bogus dynamic-toolbar innerHeight spike. `setViewport` moves `vh`
  // (window.innerHeight) only, so during a modeled spike innerHeight lies tall
  // while this stays at the real height (the original `innerHeight`), which is how
  // the code tells the spike from a real viewport change.
  // Defaults to the true height at scale 1; `setVisualViewport` models pinch-zoom
  // (a shorter visual viewport at scale > 1), which must NOT read as a spike.
  let vvHeight = innerHeight;
  let vvScale = 1;
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    get: () => ({
      height: vvHeight,
      width: 0,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: vvScale,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: clamped });
  Object.defineProperty(window, 'scrollTo', {
    configurable: true,
    value: (_x: number, y: number) => {
      rawScrollY = y;
    },
  });
  return {
    setScrollY: (y: number) => {
      rawScrollY = y;
    },
    getScrollY: clamped,
    maxScroll,
    // Inject (px) or clear (null) a transient natural-height collapse.
    setNaturalCollapse: (px: number | null) => {
      naturalOverride = px;
    },
    // Change the live viewport height, modeling a transient window.innerHeight
    // jump (the dynamic-toolbar clamp at the bottom of the list).
    setViewport: (px: number) => {
      vh = px;
    },
    // Model the visual viewport directly — pinch-zoom shrinks its height and
    // raises its scale above 1 while window.innerHeight (the layout viewport) holds.
    setVisualViewport: ({ height, scale }: { height: number; scale: number }) => {
      vvHeight = height;
      vvScale = scale;
    },
  };
}

// A controllable requestAnimationFrame: queues callbacks so a test can flush
// them deterministically (the no-refetch height-freeze release is deferred a few
// animation frames — see DISMISS_SETTLE_FRAMES). Returns a `flush` that drains
// the queue repeatedly until it stays empty, so a chain that re-schedules itself
// each frame runs to completion, and a `restore` to reinstate the real timers.
function installManualRaf() {
  let nextId = 1;
  let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue = queue.filter((entry) => entry.id !== id);
  });
  const flush = () => {
    // Drain in waves: a callback may enqueue the next frame, so keep going until
    // no new frames are pending (bounded so a runaway self-reschedule can't hang
    // the test).
    for (let guard = 0; guard < 100 && queue.length > 0; guard += 1) {
      const wave = queue;
      queue = [];
      for (const entry of wave) entry.cb(performance.now());
    }
  };
  // Run exactly one frame (the currently-queued callbacks) without draining the
  // frames they schedule — lets a test hold state (e.g. a doubled viewport)
  // across a single settle frame before advancing.
  const flushOne = () => {
    const wave = queue;
    queue = [];
    for (const entry of wave) entry.cb(performance.now());
  };
  return {
    flush,
    flushOne,
    restore: () => {
      vi.stubGlobal('requestAnimationFrame', realRaf);
      vi.stubGlobal('cancelAnimationFrame', realCancel);
    },
  };
}

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

  it('discounts pending (unsynced) Sweep/Done writes from the badge immediately', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    // Freeze the pre-sweep page + count to simulate the real backend: it keeps
    // returning the swept rows and their unread total until the outbox syncs —
    // the sync lag this adjustment papers over. (The mock's own store is the
    // "server", so without this freeze it would never lag.)
    const page = await source.getHomeItems({ groupByFeed: true, limit: 100 });
    source.getHomeItems = async () => page;
    source.getFeedUnreadCounts = async () => ({ 'feed-verge': 3 });
    const vergeIds = page.items
      .filter((fi) => fi.item.feedId === 'feed-verge')
      .map((fi) => fi.item.id);
    expect(vergeIds.length).toBe(3);
    const swept = vergeIds.slice(0, 2);
    source.pendingItemIds = () => new Set(swept);

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
    // Before triage the badge shows the (stale) server count.
    expect(container.querySelector('.item-list__group-count')?.textContent).toBe(
      '3',
    );

    // Sweep two of Verge's three rows: marked Done locally + pending (unsynced).
    act(() => {
      swept.forEach((id) => source.stateStore.set(id, 'done', true));
    });

    // The badge drops to 1 immediately — 3 (stale server count) − 2 pending —
    // without waiting for the server count to catch up.
    await waitFor(() => {
      expect(
        container.querySelector('.item-list__group-count')?.textContent,
      ).toBe('1');
    });
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

  it('links each feed-section header name to that feed’s own view', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderGrouped(source);
    await screen.findAllByTestId('item-row');
    const links = screen.getAllByTestId('group-link');
    // One link per feed section, each pointing at /feed/<its feed id>.
    expect(links).toHaveLength(4);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/^\/feed\/[^/]+$/);
    }
    // The names still render inside the links.
    expect(screen.getByText('The Verge').closest('a')).toBe(links[0]);
  });

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
    expect(screen.getByTestId('collapse-all-btn')).toHaveAttribute(
      'aria-disabled',
      'true',
    );

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

  it('auto-skips a duplicate-only page (offset drift) when tapping More', async () => {
    // Regression: pages are deduped against the already-loaded list (offset
    // drift re-serves the previous page's tail), so an appended page can render
    // nothing new. The pager must measure progress on that same deduped view —
    // counting the raw page contents made it stop on the invisible page, so a
    // More tap visibly did nothing.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const all = (await source.getHomeItems()).items;
    expect(all.length).toBeGreaterThanOrEqual(3);
    const pagesByCursor: Record<string, { items: FeedItem[]; nextCursor: string | null }> = {
      start: { items: [all[0], all[1]], nextCursor: '1' },
      // The poller shifted every offset by a full page: this page re-serves
      // only already-loaded items.
      '1': { items: [all[0], all[1]], nextCursor: '2' },
      '2': { items: [all[2]], nextCursor: null },
    };
    renderWithProviders(
      <ItemList
        viewKey={`dup-${Math.random()}`}
        fetchPage={(cursor) => Promise.resolve(pagesByCursor[cursor ?? 'start'])}
        emptyLabel="All caught up."
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');
    expect(screen.queryByText(all[2].item.title)).not.toBeInTheDocument();

    // One More tap pages past the duplicate-only page and lands the next new
    // item, instead of stopping on a page that shows nothing.
    await user.click(screen.getByTestId('more-btn'));
    expect(await screen.findByText(all[2].item.title)).toBeInTheDocument();
    // And the duplicates still render only once each.
    expect(screen.getAllByTestId('item-row')).toHaveLength(3);
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

  it('omits the group-by-feed toggle when no onToggleGroupByFeed is wired', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderHome(source);
    await screen.findAllByTestId('item-row');
    expect(screen.queryByTestId('group-by-feed-btn')).toBeNull();
  });

  it('surfaces a group-by-feed toggle reflecting the current state, even when flat', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const onToggle = vi.fn();
    renderWithProviders(
      <ItemList
        viewKey={`gp-${Math.random()}`}
        fetchPage={(cursor) => source.getHomeItems({ cursor })}
        emptyLabel="All caught up."
        onToggleGroupByFeed={onToggle}
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');
    // Available even with grouping off (it's how you turn it on), reflecting the
    // off state, and tapping it flips the preference via the wired callback.
    const btn = screen.getByTestId('group-by-feed-btn');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.setup().click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows the group-by-feed toggle pressed in the grouped view', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(
      <ItemList
        viewKey={`gp-${Math.random()}`}
        fetchPage={(cursor) =>
          source.getHomeItems({ cursor, groupByFeed: true, limit: 100 })
        }
        emptyLabel="All caught up."
        groupByFeed
        onToggleGroupByFeed={vi.fn()}
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');
    expect(screen.getByTestId('group-by-feed-btn')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('omits the sort-order toggle when no onToggleSort is wired', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderHome(source);
    await screen.findAllByTestId('item-row');
    expect(screen.queryByTestId('sort-order-btn')).toBeNull();
  });

  it('surfaces a sort-order toggle naming the current order and flips it on tap', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const onToggle = vi.fn();
    renderWithProviders(
      <ItemList
        viewKey={`sort-${Math.random()}`}
        fetchPage={(cursor) => source.getHomeItems({ cursor })}
        emptyLabel="All caught up."
        itemSort="oldest"
        onToggleSort={onToggle}
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');
    const btn = screen.getByTestId('sort-order-btn');
    expect(btn).toHaveAccessibleName('Oldest first');
    await userEvent.setup().click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
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

  it('keeps an in-session pin at its position instead of jumping it to the top', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderHome(source);

    const rows = await screen.findAllByTestId('item-row');
    const firstTitle = within(rows[0]).getByTestId('item-title').textContent;
    const target = rows[3];
    const targetTitle = within(target).getByTestId('item-title').textContent;

    // Pin the 4th row while looking at it.
    await user.click(within(target).getByTestId('pin-btn'));

    // It must not jump to the top: the first row is unchanged and the pinned
    // row keeps its slot (the data source orders pins to the top, but an
    // in-session pin holds its place — SPEC.md "pinning a body row keeps its
    // position").
    await waitFor(() => {
      const after = screen.getAllByTestId('item-row');
      expect(within(after[3]).getByTestId('pin-btn')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    const after = screen.getAllByTestId('item-row');
    expect(within(after[0]).getByTestId('item-title')).toHaveTextContent(
      firstTitle!,
    );
    expect(within(after[3]).getByTestId('item-title')).toHaveTextContent(
      targetTitle!,
    );
  });

  it('consolidates an in-session pin to the top once Sweep clears the in-body hold', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderHome(source);

    const rows = await screen.findAllByTestId('item-row');
    const target = rows[3];
    const targetTitle = within(target).getByTestId('item-title').textContent;
    await user.click(within(target).getByTestId('pin-btn'));
    // Held in place by the in-session rule.
    await waitFor(() => {
      const after = screen.getAllByTestId('item-row');
      expect(within(after[3]).getByTestId('item-title')).toHaveTextContent(
        targetTitle!,
      );
    });

    // Sweep dismisses the unpinned rows and clears the in-body hold: the pinned
    // row is the sole survivor, standing at the top of the list. A mutation no
    // longer refetches, so this consolidation is purely the local overlay — the
    // unpinned rows drop from view and the pin remains at the top.
    await user.click(screen.getByTestId('sweep-btn'));
    await waitFor(() => {
      const after = screen.getAllByTestId('item-row');
      expect(after).toHaveLength(1);
      expect(within(after[0]).getByTestId('item-title')).toHaveTextContent(
        targetTitle!,
      );
    });

    // Undo restores the dismissed rows; the pinned target is still present.
    await user.click(screen.getByTestId('undo-btn'));
    await waitFor(() => {
      expect(screen.getAllByTestId('item-row').length).toBeGreaterThan(1);
    });
    const restored = screen.getAllByTestId('item-row');
    expect(
      restored.some(
        (r) => within(r).getByTestId('item-title').textContent === targetTitle,
      ),
    ).toBe(true);
  });

  it('keeps a held row in the body through an unpin (before the refetch lands)', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const page = await source.getHomeItems();
    const target = page.items[3].item;
    const viewKey = `home-unpin-${viewKeySeq++}`;
    renderWithProviders(
      <ItemList
        viewKey={viewKey}
        fetchPage={(cursor) => source.getHomeItems({ cursor })}
        emptyLabel="x"
      />,
      { source, queryClient },
    );
    const rows = await screen.findAllByTestId('item-row');
    const targetTitle = within(rows[3]).getByTestId('item-title').textContent;

    // Pin the 4th row, then refresh the cache so it is now pinned-first — the
    // row is held in the body by the in-session rule.
    await user.click(within(rows[3]).getByTestId('pin-btn'));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
    });
    await waitFor(() => {
      const after = screen.getAllByTestId('item-row');
      expect(within(after[3]).getByTestId('item-title')).toHaveTextContent(
        targetTitle!,
      );
    });

    // Unpin it. The cache is still pinned-first until the unpin's refetch lands;
    // the row must stay anchored to its body slot, not snap to the top.
    await user.click(
      within(
        document.querySelector(`[data-item-id="${target.id}"]`) as HTMLElement,
      ).getByTestId('pin-btn'),
    );
    await waitFor(() => {
      const a = document.querySelector(
        `[data-item-id="${target.id}"]`,
      ) as HTMLElement;
      expect(within(a).getByTestId('pin-btn')).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });
    const afterUnpin = screen.getAllByTestId('item-row');
    expect(within(afterUnpin[0]).getByTestId('item-title')).not.toHaveTextContent(
      targetTitle!,
    );
    expect(within(afterUnpin[3]).getByTestId('item-title')).toHaveTextContent(
      targetTitle!,
    );
  });

  it('does not hold a pin applied by background hydration in the body', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const page = await source.getHomeItems();
    const target = page.items[3].item;
    const viewKey = `home-hydrate-${viewKeySeq++}`;
    renderWithProviders(
      <ItemList
        viewKey={viewKey}
        fetchPage={(cursor) => source.getHomeItems({ cursor })}
        emptyLabel="x"
      />,
      { source, queryClient },
    );
    await screen.findAllByTestId('item-row');

    // Cold/slow hydration path: server item_state arrives AFTER the feed has
    // painted, flipping a pre-existing pin false→true in the local store. That
    // is not an in-session pin, so it must lift to the top (resting state), not
    // get held in the body.
    await act(async () => {
      source.stateStore.hydrate([
        [target.id, { ...DEFAULT_ITEM_STATE, pinned: true, pinnedAt: 1000 }],
      ]);
      await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
    });

    await waitFor(() => {
      const rows = screen.getAllByTestId('item-row');
      expect(within(rows[0]).getByTestId('item-title')).toHaveTextContent(
        target.title,
      );
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

  it('per-feed header Sweep leaves a row scrolled off-screen, sweeping only the visible ones', async () => {
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

    // Push the first of The Verge's 3 rows below the "fully visible" threshold,
    // as if it were scrolled partway off-screen. The header broom is
    // viewport-scoped like the toolbar Sweep, so it must NOT touch a row the
    // reader can't currently see — only the 2 fully-visible rows are swept.
    const vergeRows = container.querySelectorAll('[data-item-id]');
    const offScreenId = vergeRows[0].getAttribute('data-item-id');
    act(() => {
      setVisibilityForTest(vergeRows[0].closest('li')!, 0.4);
    });

    await user.click(screen.getAllByTestId('group-sweep')[0]);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-item-id]').length).toBe(totalBefore - 2);
    });
    // The off-screen Verge row survives, so the section is still present; the
    // other feeds are untouched.
    expect(
      container.querySelector(`[data-item-id="${offScreenId}"]`),
    ).not.toBeNull();
    expect(screen.getByText('The Verge')).toBeInTheDocument();
    expect(screen.getByText('NASA Breaking News')).toBeInTheDocument();
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

  // Removed: mutations no longer refetch the active view (refetchType:'none'),
  // so neither "a Sweep racing its own invalidating refetch" nor "a pin's
  // background refetch shrinking the list mid-refresh" can occur. A Sweep that
  // empties the list now shows the caught-up label immediately off the local
  // store (correctly — the reader swept everything). The height-freeze on a
  // genuine background refresh (pull-to-refresh / focus) is exercised by the
  // Sweep freeze tests below via lockBodyHeight.

  it('freezes the body at its PRE-sweep height when a grouped section is swept, so the page does not jump', async () => {
    // Regression: a grouped Sweep drops its rows from `visibleItems`
    // synchronously, in the same commit the feed invalidation flips
    // isRefreshing true. The height lock's layout effect measures only on that
    // edge — so it read the already-shrunken height and froze the document too
    // short, letting the browser clamp scrollY toward the top (the reported
    // jump, worst with a whole section swept at once + short collapsed
    // sections). commitSweep now grabs the height BEFORE hiding the rows.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ groupByFeed: true, limit: 100 });

    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );

    const { container } = renderWithProviders(
      <ItemList
        viewKey={`gp-jump-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    // jsdom has no layout: model offsetHeight as 100px per rendered row, so the
    // measured height shrinks the instant the swept section's rows leave the
    // DOM. The lock must capture the height while every row is still present.
    Object.defineProperty(body, 'offsetHeight', {
      configurable: true,
      get: () => container.querySelectorAll('[data-item-id]').length * 100,
    });
    const fullRows = container.querySelectorAll('[data-item-id]').length;
    const fullHeight = fullRows * 100;
    const anchorWrites = recordOverflowAnchorWrites(body);

    // Sweep the first feed's whole section from its header broom; the commit
    // fires off the sweep animation's fallback timer. The rows leave the DOM
    // synchronously (no refetch) — commitSweep captures the pre-sweep height
    // first, then the release holds the scroll (exercised by the scroll-model
    // sweep tests below).
    void fullHeight;
    await user.click(screen.getAllByTestId('group-sweep')[0]);
    await waitFor(() =>
      expect(container.querySelectorAll('[data-item-id]').length).toBeLessThan(
        fullRows,
      ),
    );

    // The body was opted out of scroll anchoring while the swept rows left the
    // DOM, so the section's collapse couldn't rewind window.scrollY to the top…
    expect(anchorWrites).toContain('none');
    // …then anchoring is handed back a frame later (so a later auto-hide still
    // gets it).
    expect(body.style.overflowAnchor).toBe('');
  });

  it('holds the scroll offset when releasing the lock would shrink the document below it, so the group headers do not slide down', async () => {
    // Regression ("the group header moves when you sweep a group"): a Sweep
    // removes rows for good, so the post-sweep document is permanently shorter.
    // If the reader swept a feed near the bottom of the loaded list, simply
    // clearing the min-height lock lets the browser clamp window.scrollY toward
    // the top — sliding every still-pinned group header down. The release now
    // keeps just enough min-height to hold the current scroll and defers the
    // final drop to the reader's next scroll. The scroll model clamps scrollY
    // when the document shrinks, so this fails if that preservation regresses.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const fetchPage = vi.fn((cursor: string | null) =>
      source.getHomeItems({ cursor, groupByFeed: true, limit: 100 }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`gp-bottom-sweep-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, { innerHeight: 400, rowHeight: 100 });
    // The no-refetch release is deferred a few animation frames (it spans the
    // dismiss's momentary collapse); drive those frames deterministically so the
    // deferred-on-scroll slack is armed before the reader scrolls.
    const raf = installManualRaf();
    // The reader is scrolled to the very bottom of the loaded list.
    const rowsBefore = container.querySelectorAll('[data-item-id]').length;
    scroll.setScrollY(scroll.maxScroll());
    const before = scroll.getScrollY();
    expect(before).toBeGreaterThan(0);

    // Sweep the first feed's section; the post-sweep refetch settles (not held),
    // so the lock releases via the layout effect.
    await user.click(screen.getAllByTestId('group-sweep')[0]);
    // The swept section really did shrink the rendered list...
    await waitFor(() =>
      expect(container.querySelectorAll('[data-item-id]').length).toBeLessThan(
        rowsBefore,
      ),
    );
    // ...but the release held min-height so the document stayed tall enough that
    // the scroll offset was never clamped toward the top: the headers don't move.
    await waitFor(() => expect(body.style.minHeight).not.toBe(''));
    expect(scroll.getScrollY()).toBe(before);

    // The settle frames elapse: the freeze hands off to the deferred-on-scroll
    // slack (still holding the offset — the document is genuinely shorter now).
    raf.flush();
    expect(scroll.getScrollY()).toBe(before);

    // The reader scrolls back up to where the natural document can hold the
    // offset: the held slack drops to nothing, so there's no persistent blank
    // tail, and the scroll lands exactly where they put it.
    scroll.setScrollY(0);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(body.style.minHeight).toBe('');
    expect(scroll.getScrollY()).toBe(0);
    raf.restore();
  });

  it('keeps the reader in place when sweeping the bottom group leaves a sub-viewport document', async () => {
    // Regression (reported): sweeping the bottom feed group while scrolled to the
    // bottom of an otherwise-collapsed list snapped the whole page to the top.
    // Once the swept rows are gone the surviving document is SHORTER THAN ONE
    // VIEWPORT, and the browser floors documentElement.scrollHeight at the
    // viewport height — so the release's old scrollHeight-based deficit read 0,
    // under-provisioned the min-height, and the document couldn't hold the offset:
    // scrollY clamped to 0. The release now sizes the hold from the body's
    // (unclamped) document-space top instead, so a sub-viewport document is held
    // tall enough and the reader stays put. Big innerHeight so the post-sweep
    // document (chrome + survivors) sits below one viewport.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const fetchPage = vi.fn((cursor: string | null) =>
      source.getHomeItems({ cursor, groupByFeed: true, limit: 100 }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`gp-subvp-sweep-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    // 100px of fixed chrome above the body; a viewport far taller than the
    // post-sweep content so that content is sub-viewport after the sweep.
    const scroll = installScrollModel(body, container, {
      innerHeight: 1000,
      rowHeight: 100,
      chromeHeight: 100,
    });
    const raf = installManualRaf();
    const rowsBefore = container.querySelectorAll('[data-item-id]').length;
    const sweeps = screen.getAllByTestId('group-sweep');
    // Reader is at the very bottom of the loaded list.
    scroll.setScrollY(scroll.maxScroll());
    const before = scroll.getScrollY();
    expect(before).toBeGreaterThan(0);

    // Sweep the LAST (bottom) feed section.
    await user.click(sweeps[sweeps.length - 1]);
    // The bottom section's rows really left the list...
    await waitFor(() =>
      expect(container.querySelectorAll('[data-item-id]').length).toBeLessThan(
        rowsBefore,
      ),
    );
    // ...and the post-sweep document is shorter than one viewport (the condition
    // that used to trip the clamp): natural max scroll is 0.
    const survivors = container.querySelectorAll('[data-item-id]').length;
    expect(100 + survivors * 100).toBeLessThan(1000);
    // The reader did NOT snap to the top: the hold kept the offset exactly.
    await waitFor(() => expect(body.style.minHeight).not.toBe(''));
    expect(scroll.getScrollY()).toBe(before);

    // Let the settle frames elapse so the deferred-on-scroll slack is armed.
    raf.flush();
    expect(scroll.getScrollY()).toBe(before);

    // On the reader's next scroll up to the top, the slack clears — no blank tail.
    scroll.setScrollY(0);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(body.style.minHeight).toBe('');
    expect(scroll.getScrollY()).toBe(0);
    raf.restore();
  });

  it('counts trailing in-flow content (the relative bottom bar) when releasing the deferred hold', async () => {
    // Codex P2 on #321: the deferred release decides whether the natural document
    // can hold the offset. In the default bottom-bar mode a relative ListToolbar
    // (and the refresh strip) render in flow BELOW the body, so the natural
    // document is taller than the body alone. Sizing that decision from the body
    // height only ignores the footer, so the slack lingers a footer's height
    // longer than needed as the reader scrolls up — a small persistent blank tail.
    // The release now reconciles the body-derived height with the real
    // documentElement.scrollHeight, so the footer counts and the slack clears at
    // the right point.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const fetchPage = vi.fn((cursor: string | null) =>
      source.getHomeItems({ cursor, groupByFeed: true, limit: 100 }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`gp-footer-sweep-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    // 100px of trailing in-flow footer below the body (the relative bottom bar).
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
      footerHeight: 100,
    });
    const raf = installManualRaf();
    const rowsBefore = container.querySelectorAll('[data-item-id]').length;
    const sweeps = screen.getAllByTestId('group-sweep');
    scroll.setScrollY(scroll.maxScroll());
    const before = scroll.getScrollY();
    expect(before).toBeGreaterThan(0);

    await user.click(sweeps[sweeps.length - 1]);
    await waitFor(() =>
      expect(container.querySelectorAll('[data-item-id]').length).toBeLessThan(
        rowsBefore,
      ),
    );
    // Held at the pre-sweep offset (the offset sits past the post-sweep bottom).
    await waitFor(() => expect(body.style.minHeight).not.toBe(''));
    expect(scroll.getScrollY()).toBe(before);
    // Let the settle frames elapse so the deferred-on-scroll slack is armed and
    // sized to the natural (recovered) document.
    raf.flush();
    // The hold is sized EXACTLY: the held max scroll is the offset itself, not a
    // footer's height past it. Sizing the body as if it were the final document
    // content (no trailing subtraction) would leave `footerHeight` of extra
    // scrollable slack below the reader until the release clears.
    expect(scroll.maxScroll()).toBe(before);

    // Scroll up to a row-only bottom the *footer-inclusive* document can hold but
    // the body alone cannot: survivors×100 − innerHeight < target ≤
    // survivors×100 + footer − innerHeight. The release must drop the slack here.
    const survivors = container.querySelectorAll('[data-item-id]').length;
    const bodyOnlyMax = survivors * 100 - 400;
    const withFooterMax = survivors * 100 + 100 - 400;
    const target = bodyOnlyMax + 50; // between the two maxes
    expect(target).toBeGreaterThan(bodyOnlyMax);
    expect(target).toBeLessThanOrEqual(withFooterMax);
    scroll.setScrollY(target);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    // With the footer counted, the natural document already holds `target`, so the
    // slack is fully released — no lingering blank tail.
    expect(body.style.minHeight).toBe('');
    expect(scroll.getScrollY()).toBe(target);
    raf.restore();
  });

  it('counts the footer even when the post-sweep document is sub-viewport (scrollHeight floored)', async () => {
    // Codex P2 on #321 (follow-up): when the surviving body PLUS the relative
    // bottom toolbar is still shorter than one viewport, documentElement's
    // scrollHeight reports exactly innerHeight — floored — so a scrollHeight-based
    // trailing measurement can't see the footer and would leave a toolbar-height
    // of extra scroll range below the reader. Measuring the footer floor-free from
    // the layout boxes (`.item-list` root bottom − body bottom) counts it even
    // here, so the hold is exact. Viewport is taller than the post-sweep content
    // so the document is sub-viewport, but pre-sweep it overflows (before > 0).
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const fetchPage = vi.fn((cursor: string | null) =>
      source.getHomeItems({ cursor, groupByFeed: true, limit: 100 }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`gp-subvp-footer-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    // innerHeight 1000 > survivors×100 (800) + footer (100) = 900, so the
    // post-sweep document is sub-viewport and scrollHeight floors to 1000.
    const scroll = installScrollModel(body, container, {
      innerHeight: 1000,
      rowHeight: 100,
      footerHeight: 100,
    });
    const rowsBefore = container.querySelectorAll('[data-item-id]').length;
    const sweeps = screen.getAllByTestId('group-sweep');
    scroll.setScrollY(scroll.maxScroll());
    const before = scroll.getScrollY();
    expect(before).toBeGreaterThan(0);

    await user.click(sweeps[sweeps.length - 1]);
    await waitFor(() =>
      expect(container.querySelectorAll('[data-item-id]').length).toBeLessThan(
        rowsBefore,
      ),
    );
    const survivors = container.querySelectorAll('[data-item-id]').length;
    // Post-sweep document is genuinely sub-viewport (content < innerHeight).
    expect(survivors * 100 + 100).toBeLessThan(1000);
    // Held at the offset. The defensive freeze first over-provisions the tail (to
    // survive a viewport spike), then relaxes to the tight hold once the settle
    // releases — at which point the floored scrollHeight still counts the footer,
    // so there's no toolbar-height of extra scrollable slack. Wait for that tight
    // release (min-height stays non-empty throughout).
    await waitFor(() => expect(scroll.maxScroll()).toBe(before));
    expect(scroll.getScrollY()).toBe(before);
    expect(body.style.minHeight).not.toBe('');
  });

  it('folds the held offset into a fresh lock when a second in-viewport Done lands before the reader scrolls', async () => {
    // Codex P2 on #300: after a bottom sweep deferred the release, the slack
    // min-height is the only thing keeping window.scrollY off the natural (now
    // shorter) bottom. A second in-viewport Done/Sweep before any scroll takes a
    // fresh lock via lockBodyHeight — which must NOT clear that slack first, or
    // the browser clamps the scroll back and re-measures the already-short
    // document, bringing the header jump back. The fresh lock measures with the
    // slack still applied so the held offset survives.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const fetchPage = vi.fn((cursor: string | null) =>
      source.getHomeItems({ cursor, groupByFeed: true, limit: 100 }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`gp-relock-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, { innerHeight: 400, rowHeight: 100 });
    scroll.setScrollY(scroll.maxScroll());
    const before = scroll.getScrollY();
    expect(before).toBeGreaterThan(0);

    await user.click(screen.getAllByTestId('group-sweep')[0]);
    // Deferred release active: slack held, offset preserved.
    await waitFor(() => expect(body.style.minHeight).not.toBe(''));
    expect(scroll.getScrollY()).toBe(before);

    // A second in-viewport Done on a surviving row, WITHOUT scrolling first.
    const survivor = container.querySelector('[data-item-id]');
    expect(survivor).not.toBeNull();
    act(() => {
      source.stateStore.hide(survivor!.getAttribute('data-item-id')!);
    });

    // The fresh lock folded the slack in instead of clearing it: the offset
    // survives the clamp it would otherwise have suffered. (Clearing first would
    // have shrunk the document and pulled scrollY back toward the top.)
    expect(scroll.getScrollY()).toBe(before);
    expect(body.style.minHeight).not.toBe('');
  });

  it('detaches a pending deferred release when a general background refresh takes the lock', async () => {
    // Codex P2 (#2) on #300: a bottom-sweep release leaves a scroll listener
    // armed to finish the release. If a genuine background refresh (pull-to-
    // refresh / focus) then takes the lock WITHOUT the reader scrolling first,
    // the layout-effect take branch must detach that stale listener — otherwise
    // a scroll during the refetch runs the stale release and clears min-height
    // while the refetch is still locked, letting the sequential refetch
    // shrink/clamp the document under the reader. (A mutation no longer
    // refetches, so the general refresh is driven here by an explicit
    // invalidation — the pull-to-refresh / focus path.)
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    let releaseRefresh: (() => void) | null = null;
    let calls = 0;
    const fetchPage = vi.fn((cursor: string | null) => {
      calls += 1;
      // 1 = initial load (settles so the sweep — which no longer refetches —
      // arms its deferred release off the local removal); 2 = the background
      // refresh, held open so isRefreshing stays true while we probe the
      // general lock's take branch.
      if (calls <= 1) return source.getHomeItems({ cursor, groupByFeed: true, limit: 100 });
      return new Promise<Awaited<ReturnType<typeof source.getHomeItems>>>(
        (resolve) => {
          releaseRefresh = () =>
            resolve(source.getHomeItems({ cursor, groupByFeed: true, limit: 100 }));
        },
      );
    });
    const viewKey = `gp-general-relock-${viewKeySeq++}`;
    const { container } = renderWithProviders(
      <ItemList
        viewKey={viewKey}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source, queryClient },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, { innerHeight: 400, rowHeight: 100 });
    scroll.setScrollY(scroll.maxScroll());
    const before = scroll.getScrollY();
    expect(before).toBeGreaterThan(0);

    // Bottom sweep → deferred release armed (slack held, scroll listener live).
    // The sweep no longer refetches, so the release lands off the local removal.
    await user.click(screen.getAllByTestId('group-sweep')[0]);
    await waitFor(() => expect(body.style.minHeight).not.toBe(''));
    expect(scroll.getScrollY()).toBe(before);

    // A genuine background refresh (pull-to-refresh / focus) WITHOUT scrolling:
    // the take branch grabs a fresh lock and must drop the stale
    // deferred-release listener.
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
    });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

    // The reader scrolls up mid-refetch. With the stale listener detached this is
    // a no-op on the lock; if it weren't, the stale release would clear
    // min-height while still locked and the document would clamp under them.
    scroll.setScrollY(0);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(body.style.minHeight).not.toBe('');

    // Settle the held refetch so the lock releases cleanly.
    await act(async () => {
      releaseRefresh?.();
    });
    await waitFor(() => expect(body.style.minHeight).toBe(''));
  });

  it('opts out of scroll anchoring when a single row is marked Done, so the scroll position and the rows above hold', async () => {
    // Regression: marking ONE visible article Done (row menu Done, the Done
    // button, the `d` shortcut, or swipe-right — all route through store.hide)
    // drops that row from the rendered list. The browser's scroll anchoring
    // would react by rewinding window.scrollY to keep a row below the removed
    // one fixed — moving the scroll position and shifting every row above. The
    // single-dismiss path takes the same anchor opt-out (+ height freeze) the
    // Sweep uses so the offset holds exactly and only the rows below the
    // dismissed one slide up. The opt-out is applied synchronously around the
    // local removal (a mutation no longer refetches, so there's nothing to hold
    // it through) and handed back once the shorter row-list has painted.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems();
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );

    const { container } = renderWithProviders(
      <ItemList
        viewKey={`single-done-anchor-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rowsBefore = await screen.findAllByTestId('item-row');
    const firstId = rowsBefore[0].closest('li')!.getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    Object.defineProperty(body, 'offsetHeight', { value: 1000, configurable: true });
    const anchorWrites = recordOverflowAnchorWrites(body);

    // Mark the first (visible) row Done — the single-dismiss store path every
    // row-level Done action funnels through. The height freeze + anchor opt-out
    // are applied synchronously, while the row is still on screen.
    act(() => {
      source.stateStore.hide(firstId);
    });

    // The dismissed row really did leave the rendered list...
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${firstId}"]`)).toBeNull(),
    );
    // ...and the body was opted out of scroll anchoring for the frame in which
    // the row left the DOM, so its removal couldn't rewind window.scrollY.
    expect(anchorWrites).toContain('none');
    // No refetch to hold the lock through: once the shorter list paints, the
    // transient freeze is released and anchoring is handed back.
    await waitFor(() => expect(body.style.minHeight).toBe(''));
    expect(body.style.overflowAnchor).toBe('');
  });

  it('holds the scroll offset through the momentary document collapse a single Done triggers', async () => {
    // Regression (scroll-jump diagnostics): a dismiss triggers a self-inflicted
    // document collapse a beat AFTER the row-removal paints — the list reflows to
    // a fraction of its height for ~2 frames, then recovers. The freeze is taken
    // (correctly, at the tall pre-collapse height) when the row is marked Done,
    // but used to be cleared on the removal commit — BEFORE the dip — so the
    // browser clamped window.scrollY toward the top and the clamp stuck once the
    // height recovered. The freeze is now held across the settle frames, so the
    // document never gets short enough to clamp.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`single-done-collapse-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    const firstId = rows[0].closest('li')!.getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    // Sit at the offset the list will still hold AFTER one row leaves, so the
    // only thing that could clamp is the transient collapse — not the permanent
    // one-row shrink.
    const rowCount = container.querySelectorAll('[data-item-id]').length;
    const target = (rowCount - 1) * 100 - 400;
    expect(target).toBeGreaterThan(0);
    scroll.setScrollY(target);
    expect(scroll.getScrollY()).toBe(target);

    // Mark the first (visible) row Done — takes the freeze synchronously while
    // the row is still on screen (measured at the tall pre-collapse height).
    act(() => {
      source.stateStore.hide(firstId);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${firstId}"]`)).toBeNull(),
    );

    // The release is deferred (settle frames still pending), so the freeze is
    // engaged. Now the dismiss's momentary collapse hits: the document reflows to
    // a fraction of its height for a couple of frames.
    expect(body.style.minHeight).not.toBe('');
    scroll.setNaturalCollapse(200);
    // The freeze holds the document tall through the dip — the offset is NOT
    // clamped (with the old immediate release it would snap toward the top here).
    expect(scroll.getScrollY()).toBe(target);

    // The collapse recovers, then the settle frames elapse and the freeze
    // releases onto the settled (recovered) height. The offset is preserved.
    scroll.setNaturalCollapse(null);
    raf.flush();
    expect(scroll.getScrollY()).toBe(target);
    expect(body.style.minHeight).toBe('');
    raf.restore();
  });

  it('holds the scroll offset through the momentary collapse a Sweep triggers', async () => {
    // The same self-inflicted collapse fires on a Sweep (a batch local removal),
    // not just a lone Done — both take lockBodyHeight and release through the same
    // no-refetch effect, so the freeze must span the dip for either. A per-feed
    // header Sweep removes one section's visible rows.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const fetchPage = vi.fn((cursor: string | null) =>
      source.getHomeItems({ cursor, groupByFeed: true, limit: 100 }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`sweep-collapse-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const before = container.querySelectorAll('[data-item-id]').length;
    // A modest offset every remaining row-set comfortably holds, so the release
    // (a genuine multi-row shrink) doesn't itself clamp — the collapse is what
    // we're guarding against.
    const target = 300;
    scroll.setScrollY(target);
    expect(scroll.getScrollY()).toBe(target);

    await user.click(screen.getAllByTestId('group-sweep')[0]);
    await waitFor(() =>
      expect(container.querySelectorAll('[data-item-id]').length).toBeLessThan(
        before,
      ),
    );
    // Enough rows survived that the settled document still holds `target` — so a
    // clamp here can only come from the transient, not the permanent shrink.
    const survivors = container.querySelectorAll('[data-item-id]').length;
    expect(survivors * 100 - 400).toBeGreaterThanOrEqual(target);

    // Freeze still engaged (settle deferred); inject the momentary collapse.
    expect(body.style.minHeight).not.toBe('');
    scroll.setNaturalCollapse(200);
    expect(scroll.getScrollY()).toBe(target);

    // Recover + settle: the freeze releases onto the settled height, offset kept.
    scroll.setNaturalCollapse(null);
    raf.flush();
    expect(scroll.getScrollY()).toBe(target);
    await waitFor(() => expect(body.style.minHeight).toBe(''));
    raf.restore();
  });

  it('defensively holds the reader when a dismiss at the bottom triggers a viewport spike', async () => {
    // Regression (scroll-jump diagnostics, Pixel/Brave): dismissing at the very
    // bottom of the list snapped the page toward the top. The probe timeline
    // showed the document height (scrollHeight) was stable — what changed was
    // window.innerHeight, which momentarily DOUBLED (Chromium's dynamic toolbar
    // reporting a doubled viewport for a frame). maxScroll = scrollHeight −
    // innerHeight, so the doubled viewport slashed the ceiling and the browser
    // clamped the reader down. Rather than let that clamp fire and undo it after
    // (a visible jump-then-restore), the freeze is now sized to survive a PEAK
    // spike: it holds enough height that even a doubled innerHeight keeps maxScroll
    // at or above where the reader sits, so the clamp never happens in the first
    // place — the reader holds position with a blank tail below.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`bottom-viewport-clamp-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    // Dismiss a row the reader can actually SEE at the bottom — a Sweep/swipe only
    // ever removes in-viewport rows, never off-screen content above the reader, so
    // the content above them is unchanged and they must stay put (a blank tail
    // fills the gap), not follow the collapsed bottom up.
    const lastId = rows[rows.length - 1]
      .closest('li')!
      .getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const rowCount = container.querySelectorAll('[data-item-id]').length;
    // Need enough rows that a doubled (800px) viewport still clamps below the
    // reader's bottom offset.
    expect(rowCount).toBeGreaterThan(8);
    // The reader is scrolled to the very bottom — a genuine scroll, so the
    // tracked offset is recorded while the lock is off.
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const before = scroll.getScrollY();
    expect(before).toBe(rowCount * 100 - 400);

    // Dismiss the bottom row (the freeze is taken, the lock goes on).
    act(() => {
      source.stateStore.hide(lastId);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${lastId}"]`)).toBeNull(),
    );

    // The dynamic toolbar doubles the viewport for a frame. Because the freeze was
    // sized for a peak (2×) spike while the row was still on screen, maxScroll stays
    // at or above where the reader is — so the browser does NOT clamp them. They
    // hold exactly where they were even mid-spike (no jump to undo later).
    scroll.setViewport(800);
    scroll.setScrollY(scroll.getScrollY());
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(scroll.getScrollY()).toBe(before);

    // One settle frame runs WHILE the viewport is still doubled; the freeze holds
    // through it (it never relaxes mid-spike). The viewport then reverts and the
    // remaining frames release to the tight hold.
    raf.flushOne();
    scroll.setViewport(400);
    raf.flush();
    // Held EXACTLY where they were — the removed row is below them, so a blank
    // tail (held min-height) fills the gap rather than snapping them to the new,
    // one-row-shorter bottom.
    expect(scroll.getScrollY()).toBe(before);
    expect(body.style.minHeight).not.toBe('');
    // The tail is transient: on the reader's next scroll up it clears with no
    // persistent blank space.
    scroll.setScrollY(0);
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(body.style.minHeight).toBe('');
    expect(scroll.getScrollY()).toBe(0);
    raf.restore();
  });

  it('defensively holds through a spike that reverts on its own clock (real-device timing)', async () => {
    // Regression (scroll-jump diagnostics, second capture): the dynamic-toolbar
    // innerHeight spike fires-and-reverts on the browser's own clock, its
    // scroll/resize events routinely arriving before the passive-effect rAF settle
    // even begins sampling. The defensive freeze doesn't depend on sampling the
    // spike at all — it was sized for a peak spike at the commit, before the row
    // left — so the clamp never fires regardless of when (or whether) an event or
    // frame observes the doubled viewport. The reader holds their pre-spike offset.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`clamp-late-revert-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    const lastId = rows[rows.length - 1]
      .closest('li')!
      .getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const rowCount = container.querySelectorAll('[data-item-id]').length;
    expect(rowCount).toBeGreaterThan(8);
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const before = scroll.getScrollY();

    act(() => {
      source.stateStore.hide(lastId);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${lastId}"]`)).toBeNull(),
    );

    // The viewport doubles and reverts, surfaced ONLY via the real resize/scroll
    // events, with NO settle frame flushed during the spike. The freeze absorbs it
    // either way — maxScroll never drops below the reader, so no clamp fires.
    act(() => {
      scroll.setViewport(800);
      scroll.setScrollY(scroll.getScrollY());
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('scroll'));
    });
    expect(scroll.getScrollY()).toBe(before);
    act(() => {
      scroll.setViewport(400);
      window.dispatchEvent(new Event('resize'));
    });

    // The settle frames run against the reverted viewport and release to the tight
    // hold — the reader is held EXACTLY at their pre-spike offset with a blank tail
    // (the removed row was below them), never snapped down to the row-shorter bottom.
    raf.flush();
    expect(scroll.getScrollY()).toBe(before);
    expect(body.style.minHeight).not.toBe('');
    raf.restore();
  });

  it('restores after a sweep when the viewport is ALREADY spiking at commit (synchronous capture)', async () => {
    // Regression (sweep capture, third report): on this device the dynamic-toolbar
    // spike runs on its own clock — the viewport was already lying tall BEFORE the
    // sweep and reverted within ~40 ms, so NO scroll/resize/frame my watcher hears
    // ever samples it (the diagnostics only caught it on the synchronous Done
    // marker). The fix samples the viewport synchronously in lockBodyHeight (the
    // commit), where innerHeight is observably disagreeing with the visual
    // viewport, and restores once it's honest again. Here the spike is set before
    // the dismiss and never surfaced via any event.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`spiked-at-commit-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    const lastId = rows[rows.length - 1]
      .closest('li')!
      .getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    // innerHeight 400, visual viewport stays 400 (the truth) even when we spike.
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const rowCount = container.querySelectorAll('[data-item-id]').length;
    expect(rowCount).toBeGreaterThan(8);
    // Reader at the bottom, recorded while the viewport is honest.
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const before = scroll.getScrollY();

    // The viewport is ALREADY spiking (innerHeight lies 800 vs. the true 400) when
    // the reader taps sweep — the browser has clamped them down. No event is fired
    // for it; only the synchronous commit sees it.
    act(() => {
      scroll.setViewport(800);
      scroll.setScrollY(scroll.getScrollY());
    });
    expect(scroll.getScrollY()).toBeLessThan(before);

    act(() => {
      source.stateStore.hide(lastId);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${lastId}"]`)).toBeNull(),
    );

    // The spike reverts (honest again) with no event surfacing it, then the settle
    // frames run. The synchronous capture at commit is the only reason a restore
    // fires — holding the reader EXACTLY where they were, a blank tail below (the
    // removed row was in view, below them), not stuck near the top nor snapped to
    // the new bottom.
    act(() => scroll.setViewport(400));
    raf.flush();
    expect(scroll.getScrollY()).toBe(before);
    expect(body.style.minHeight).not.toBe('');
    raf.restore();
  });

  it('restores when the spike has already reverted before the settle first runs (Codex P2 #402)', async () => {
    // The animated-sweep case: the spike is captured synchronously at the commit
    // but reverts (~40ms) before the settle effect's first sample runs (commit is
    // ~200ms behind). The settle then sees `spikeSeen=true` but an honest viewport
    // with scrollY ALREADY clamped. If the watch seeded `lastWatchY` from the
    // pre-clamp `intended`, that first sample would read the clamp as an honest
    // reader move and clear `sawSpike` — no restore. Seeding from the real scrollY
    // fixes it. Here the viewport reverts in the SAME act as the dismiss, so the
    // settle's first run already sees it honest.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`spike-reverted-before-settle-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    const lastId = rows[rows.length - 1]
      .closest('li')!
      .getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const before = scroll.getScrollY();

    // Spike + clamp + dismiss, THEN revert — all in one act, so the dismiss's
    // settle effect first runs against an already-honest, already-clamped viewport.
    act(() => {
      scroll.setViewport(800);
      scroll.setScrollY(scroll.getScrollY());
      source.stateStore.hide(lastId);
      scroll.setViewport(400);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${lastId}"]`)).toBeNull(),
    );

    raf.flush();
    // The restore still fires from the synchronous capture — the reader stays
    // EXACTLY where they were (blank tail below), not stuck at the clamped offset
    // nor snapped to the row-shorter bottom.
    expect(scroll.getScrollY()).toBe(before);
    expect(body.style.minHeight).not.toBe('');
    raf.restore();
  });

  it('holds the reader when a big bottom sweep leaves the pre-spike offset past the new bottom', async () => {
    // Regression (scroll-jump diagnostics, latest capture): the reader was NOT at
    // the very bottom (y=4985, max=5303 — headroom below) and a Sweep near the
    // bottom removed more in-viewport content than that headroom. The pre-spike
    // offset now exceeds the collapsed natural bottom, so the spike restore's old
    // `min(intended, max)` clamped the reader to the NEW bottom (y=4853) instead of
    // holding them at 4985 — the reported "it didn't scroll back to the correct
    // position". A Sweep only removes rows the reader can SEE (never off-screen
    // content above them — `inViewIds`), so the content above is unchanged and they
    // must stay exactly put with a blank tail below, however short the survivors
    // leave the document ("even only the More button. it should strictly not move").
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`big-bottom-sweep-headroom-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const rowCount = container.querySelectorAll('[data-item-id]').length;
    expect(rowCount).toBeGreaterThan(8);
    // Reader sits 200px above the bottom — genuine headroom, recorded honest.
    const before = scroll.maxScroll() - 200;
    scroll.setScrollY(before);
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(scroll.getScrollY()).toBe(before);

    // Sweep the four bottom rows the reader can see — 400px of removed content,
    // more than the 200px of headroom, so the surviving document's max scroll
    // (before − 400) ends up BELOW where the reader was (before − 200).
    const sweptIds = rows
      .slice(-4)
      .map((r) => r.closest('li')!.getAttribute('data-item-id')!);
    // The dynamic-toolbar spike is already lying (800 vs. the true 400) as the
    // sweep commits and clamps the reader down; then it reverts.
    act(() => {
      scroll.setViewport(800);
      scroll.setScrollY(scroll.getScrollY());
      for (const id of sweptIds) source.stateStore.hide(id);
      scroll.setViewport(400);
    });
    await waitFor(() =>
      expect(
        container.querySelector(`[data-item-id="${sweptIds[0]}"]`),
      ).toBeNull(),
    );

    // The post-sweep document is genuinely shorter than where the reader sits.
    const survivors = container.querySelectorAll('[data-item-id]').length;
    expect(survivors * 100 - 400).toBeLessThan(before);

    raf.flush();
    // Held EXACTLY at the pre-spike offset via a min-height blank tail — NOT
    // snapped to the collapsed new bottom.
    expect(scroll.getScrollY()).toBe(before);
    expect(body.style.minHeight).not.toBe('');
    // And the tail is transient: scrolling up clears it, no persistent blank space.
    scroll.setScrollY(0);
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(body.style.minHeight).toBe('');
    expect(scroll.getScrollY()).toBe(0);
    raf.restore();
  });

  it('defensively holds the reader when Sweeping at the bottom triggers a viewport spike', async () => {
    // The stated goal, for BOTH Done and Sweep: content ABOVE the removed rows must
    // not move. This drives the real broom (reduced-motion so it commits
    // synchronously): the reader is at the bottom with only the last rows in view,
    // Sweep removes exactly those, and the freeze — taken in commitSweep while they
    // were still on screen and sized for a peak spike — keeps the dynamic-toolbar
    // innerHeight jump from clamping the reader. They hold exactly put with a blank
    // tail where the swept rows were, no jump-then-restore flash.
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
      const seed = await source.getHomeItems({ limit: 100 });
      const fetchPage = vi.fn(() =>
        Promise.resolve({ items: seed.items, nextCursor: null }),
      );
      const { container } = renderWithProviders(
        <ItemList
          viewKey={`sweep-defensive-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="All caught up."
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');

      const body = screen.getByTestId('item-list-body');
      const scroll = installScrollModel(body, container, {
        innerHeight: 400,
        rowHeight: 100,
      });
      const raf = installManualRaf();

      const lis = [...container.querySelectorAll('li[data-item-id]')];
      const rowCount = lis.length;
      expect(rowCount).toBeGreaterThan(8);
      // Only the bottom four rows are in the viewport; the rest scrolled above. So
      // Sweep removes just those four and the survivors above keep the list
      // non-empty (the body stays mounted, so the lock isn't torn down).
      act(() => {
        lis.forEach((li, i) =>
          setVisibilityForTest(li as HTMLElement, i >= rowCount - 4 ? 1 : 0),
        );
      });

      // Reader at the very bottom, recorded while the viewport is honest.
      scroll.setScrollY(scroll.maxScroll());
      act(() => window.dispatchEvent(new Event('scroll')));
      const before = scroll.getScrollY();
      expect(before).toBeGreaterThan(0);

      await user.click(screen.getByTestId('sweep-btn'));
      await waitFor(() =>
        expect(container.querySelectorAll('[data-item-id]').length).toBeLessThan(
          rowCount,
        ),
      );

      // The dynamic toolbar doubles the viewport for a frame. The freeze absorbs it
      // — maxScroll stays at or above where the reader is — so no clamp fires.
      scroll.setViewport(800);
      scroll.setScrollY(scroll.getScrollY());
      act(() => window.dispatchEvent(new Event('scroll')));
      expect(scroll.getScrollY()).toBe(before);

      scroll.setViewport(400);
      raf.flush();
      // Held EXACTLY put — the swept rows were below them, so a blank tail fills the
      // gap rather than snapping to the collapsed bottom.
      expect(scroll.getScrollY()).toBe(before);
      expect(body.style.minHeight).not.toBe('');
      // The tail is transient: scrolling up clears it.
      scroll.setScrollY(0);
      act(() => window.dispatchEvent(new Event('scroll')));
      expect(body.style.minHeight).toBe('');
      expect(scroll.getScrollY()).toBe(0);
      raf.restore();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('holds the reader through a LATE spike that arrives after the settle released', async () => {
    // Regression (scroll-jump capture after #402/#405): the freeze held during the
    // dismiss, but the settle then relaxed to a TIGHT hold — and on this device the
    // dynamic toolbar kept spiking. ~8s later a fresh spike ramped innerHeight and
    // dropped maxScroll below the reader, dragging them −262px toward the top. Because
    // this device spiked during the dismiss, the deferred hold is now sized SPIKE-SAFE
    // (a durable ~1-viewport tail), so a later spike keeps maxScroll ≥ the offset and
    // can't clamp.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`late-spike-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    const lastId = rows[rows.length - 1]
      .closest('li')!
      .getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const rowCount = container.querySelectorAll('[data-item-id]').length;
    expect(rowCount).toBeGreaterThan(8);
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const before = scroll.getScrollY();

    // Dismiss at the bottom while the viewport is spiking (innerHeight 800 vs. true
    // 400) — the device exhibits the bug, so the hold becomes spike-safe.
    act(() => {
      scroll.setViewport(800);
      scroll.setScrollY(scroll.getScrollY());
      source.stateStore.hide(lastId);
      scroll.setViewport(400);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${lastId}"]`)).toBeNull(),
    );
    raf.flush();
    // Held at the offset with a durable (spike-safe) tail.
    expect(scroll.getScrollY()).toBe(before);
    expect(body.style.minHeight).not.toBe('');

    // SECONDS LATER: a fresh dynamic-toolbar spike (no dismiss, no settle running).
    // The tight hold would have let maxScroll = doc − 800 drop below `before` and
    // clamped the reader up; the spike-safe hold keeps doc = before + 800, so
    // maxScroll stays at `before` and they do NOT move.
    act(() => {
      scroll.setViewport(800);
      scroll.setScrollY(scroll.getScrollY());
      window.dispatchEvent(new Event('resize'));
    });
    expect(scroll.getScrollY()).toBe(before);
    raf.restore();
  });

  it('keeps a spike-restored offset spike-safe even when the clamp fit under the natural max', async () => {
    // A big spike can bake a clamp to a LOW offset that fits under the 2× natural
    // max, so runRelease's release must be sized for the HIGH pre-spike offset it
    // restores the reader to (`intended`), not that clamped offset — otherwise the
    // hold sits below where the restore puts them and a later spike clamps again.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`fit-under-max-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    const lastId = rows[rows.length - 1]
      .closest('li')!
      .getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const rowCount = container.querySelectorAll('[data-item-id]').length;
    expect(rowCount).toBeGreaterThan(8);
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const before = scroll.getScrollY();

    // A HUGE spike bakes the clamp all the way to 0 (fits under the 2× natural max)
    // BEFORE the freeze is taken, so the restore — not the freeze — is what recovers.
    act(() => {
      scroll.setViewport(rowCount * 100 + 800);
      scroll.setScrollY(scroll.getScrollY());
      source.stateStore.hide(lastId);
      scroll.setViewport(400);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${lastId}"]`)).toBeNull(),
    );
    raf.flush();
    expect(scroll.getScrollY()).toBe(before);
    expect(body.style.minHeight).not.toBe('');

    // A later ordinary 2× toolbar expansion must not re-clamp the restored offset.
    act(() => {
      scroll.setViewport(800);
      scroll.setScrollY(scroll.getScrollY());
      window.dispatchEvent(new Event('resize'));
    });
    expect(scroll.getScrollY()).toBe(before);
    raf.restore();
  });

  it('holds later dismisses spike-safe once the device has ever spiked (the latch)', async () => {
    // Option #1 (write-once device-spikes latch): after a device shows the toolbar
    // spike even once, its LATER dismisses are held spike-safe too — even a fully
    // honest one — so a subsequent toolbar expansion can't clamp. This is the whole
    // point of the latch: no per-dismiss flag to reset to tight on the honest second
    // dismiss (which is where the earlier flag lifecycle kept springing leaks).
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`latch-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const lastId = () =>
      [...container.querySelectorAll('li[data-item-id]')].pop()!.getAttribute(
        'data-item-id',
      )!;

    // 1) A first dismiss WHILE spiking latches the device.
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const firstId = lastId();
    act(() => {
      scroll.setViewport(800);
      scroll.setScrollY(scroll.getScrollY());
      source.stateStore.hide(firstId);
      scroll.setViewport(400);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${firstId}"]`)).toBeNull(),
    );
    raf.flush();

    // 2) Scroll to the top so the first hold clears.
    scroll.setScrollY(0);
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(body.style.minHeight).toBe('');

    // 3) Back at the bottom, a SECOND, fully HONEST dismiss (no spike at all).
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const before = scroll.getScrollY();
    const secondId = lastId();
    act(() => {
      source.stateStore.hide(secondId);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${secondId}"]`)).toBeNull(),
    );
    raf.flush();
    // Held with a durable (spike-safe) tail even though this dismiss was honest —
    // the latch persists. A per-dismiss flag would have gone tight here.
    expect(scroll.getScrollY()).toBe(before);
    expect(body.style.minHeight).not.toBe('');

    // 4) A later toolbar expansion must not clamp the reader.
    act(() => {
      scroll.setViewport(800);
      scroll.setScrollY(scroll.getScrollY());
      window.dispatchEvent(new Event('resize'));
    });
    expect(scroll.getScrollY()).toBe(before);
    raf.restore();
  });

  it('keeps the hold spike-safe when a Sweep samples a tap-time spike that reverts before commit', async () => {
    // The animated Sweep observes a tap-time toolbar spike in sweepThese (which
    // latches the device), then reverts before the ~200ms commit. The durable hold
    // must still be spike-safe, or the next toolbar expansion re-clamps the reader.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`tap-spike-revert-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const lis = [...container.querySelectorAll('li[data-item-id]')];
    const rowCount = lis.length;
    expect(rowCount).toBeGreaterThan(8);
    // Only the bottom four rows are in view, so Sweep removes just those (the list
    // stays non-empty).
    act(() =>
      lis.forEach((li, i) =>
        setVisibilityForTest(li as HTMLElement, i >= rowCount - 4 ? 1 : 0),
      ),
    );
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const before = scroll.getScrollY();

    // Spike is live at the TAP (sweepThese samples it), then reverts before the
    // animated ~200ms commit runs lockBodyHeight.
    act(() => scroll.setViewport(800));
    await user.click(screen.getByTestId('sweep-btn'));
    act(() => scroll.setViewport(400));
    await waitFor(() =>
      expect(container.querySelectorAll('[data-item-id]').length).toBeLessThan(
        rowCount,
      ),
    );
    raf.flush();
    expect(scroll.getScrollY()).toBe(before);
    expect(body.style.minHeight).not.toBe('');

    // A later toolbar expansion must not clamp — the hold stayed spike-safe even
    // though the tap-time spike had reverted by commit.
    act(() => {
      scroll.setViewport(800);
      scroll.setScrollY(scroll.getScrollY());
      window.dispatchEvent(new Event('resize'));
    });
    expect(scroll.getScrollY()).toBe(before);
    raf.restore();
  });

  it('does NOT treat pinch-zoom as a viewport spike (no snap to a stale offset on zoom-out)', async () => {
    // Codex P2 on #402: while pinch-zoomed the visual viewport is legitimately far
    // shorter than the layout innerHeight (scale > 1) — that is NOT a toolbar
    // spike. Reading it as one would stop the position tracker AND arm a restore
    // at dismiss, snapping the reader back to their pre-zoom offset when they zoom
    // out. The scale guard keeps the viewport "honest" while zoomed, so the reader
    // keeps being tracked and no spurious restore is armed.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`pinch-zoom-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    const firstId = rows[0].closest('li')!.getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    // Reader at the bottom, tracked while unzoomed (honest, scale 1).
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));

    // Pinch-zoom in: the visual viewport shrinks to 200 at scale 2; the layout
    // innerHeight (400) is unchanged, so the height mismatch is pure zoom.
    act(() => scroll.setVisualViewport({ height: 200, scale: 2 }));
    // The reader scrolls to a new spot WHILE zoomed — this is their real, current
    // position and must be tracked (the guard keeps the viewport honest at scale>1).
    scroll.setScrollY(150);
    act(() => window.dispatchEvent(new Event('scroll')));

    // Dismiss a row while still zoomed.
    act(() => {
      source.stateStore.hide(firstId);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${firstId}"]`)).toBeNull(),
    );

    // Zoom back out (scale 1) during the settle window.
    act(() => scroll.setVisualViewport({ height: 400, scale: 1 }));
    raf.flush();

    // The reader stays exactly where they scrolled to while zoomed — NOT snapped
    // back toward the stale pre-zoom bottom.
    expect(scroll.getScrollY()).toBe(150);
    raf.restore();
  });

  it('does NOT treat ordinary browser chrome (URL bar) as a viewport spike', async () => {
    // Codex P2 on #402: on mobile, innerHeight is often the large, toolbar-
    // retracted layout viewport while visualViewport.height reflects the URL-bar-
    // occluded visible area — a legitimate gap (tens of px, well under a doubling)
    // at scale 1. An absolute-px honesty gate would misread that as a spike and
    // seed a restore on an ordinary dismiss; the ratio gate keeps it honest.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`url-bar-chrome-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    const firstId = rows[0].closest('li')!.getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));

    // URL bar visible: the visual viewport is 90px shorter than innerHeight
    // (> the old 80px absolute tolerance) but only ~1.29× — well under a doubling,
    // and under the 1.35× ramp gate — at scale 1.
    act(() => scroll.setVisualViewport({ height: 310, scale: 1 }));
    // The reader scrolls to a new spot with the chrome up — this must be tracked
    // (the viewport is honest: 400 ≤ 310 × 1.35), so no spike is seeded.
    scroll.setScrollY(150);
    act(() => window.dispatchEvent(new Event('scroll')));

    act(() => {
      source.stateStore.hide(firstId);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${firstId}"]`)).toBeNull(),
    );

    raf.flush();
    // No spurious restore — the reader stays where they scrolled; an absolute-px
    // gate would have marked the chrome as a spike and snapped them away.
    expect(scroll.getScrollY()).toBe(150);
    raf.restore();
  });

  it('sizes the spike-proof freeze from innerHeight, not the URL-bar-shrunk visual viewport', async () => {
    // Codex P2 on #405: with the URL bar visible, visualViewport.height (e.g. 310)
    // is legitimately shorter than window.innerHeight (400) yet honest (< 1.35×).
    // The clamp ceiling uses innerHeight and the spike DOUBLES it (→ 800), so the
    // freeze must budget target + 2×innerHeight. Budgeting from the smaller visible
    // height left it ~180px short and the browser still clamped at the bottom.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`urlbar-spike-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    const lastId = rows[rows.length - 1]
      .closest('li')!
      .getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    // URL bar visible: visible height 310 < layout innerHeight 400, honest at scale 1.
    act(() => scroll.setVisualViewport({ height: 310, scale: 1 }));
    const rowCount = container.querySelectorAll('[data-item-id]').length;
    expect(rowCount).toBeGreaterThan(8);
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const before = scroll.getScrollY();

    act(() => {
      source.stateStore.hide(lastId);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${lastId}"]`)).toBeNull(),
    );

    // The toolbar doubles innerHeight to 800 (visualViewport stays 310). Because the
    // freeze was budgeted from innerHeight (400), maxScroll stays at `before` — no
    // clamp. Sizing from the 310 visible height would have left it short and clamped.
    scroll.setViewport(800);
    scroll.setScrollY(scroll.getScrollY());
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(scroll.getScrollY()).toBe(before);

    scroll.setViewport(400);
    raf.flush();
    expect(scroll.getScrollY()).toBe(before);
    expect(body.style.minHeight).not.toBe('');
    raf.restore();
  });

  it('does NOT override a scroll the reader makes during the dismiss settle window', async () => {
    // Codex P2 on #394: the restore must fire only for a genuine viewport clamp,
    // never for a scroll the reader performs during the settle. A reader scroll
    // leaves headroom below the ceiling, so no settle frame samples the
    // pinned-below-settled signature and the restore stays inert — the reader
    // keeps exactly where they scrolled.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`settle-reader-scroll-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    const firstId = rows[0].closest('li')!.getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const rowCount = container.querySelectorAll('[data-item-id]').length;
    // Reader starts at the bottom (the scenario where the clamp bites).
    const start = rowCount * 100 - 400;
    scroll.setScrollY(start);
    act(() => window.dispatchEvent(new Event('scroll')));

    act(() => {
      source.stateStore.hide(firstId);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${firstId}"]`)).toBeNull(),
    );

    // The reader deliberately scrolls UP during the settle window (no viewport
    // clamp — the ceiling is unchanged, so this is a genuine scroll with
    // headroom). The lock is still on, but the restore must not fight it.
    const scrolledTo = 120;
    scroll.setScrollY(scrolledTo);
    act(() => window.dispatchEvent(new Event('scroll')));

    raf.flush();
    // Left exactly where the reader scrolled — NOT snapped back toward the bottom.
    expect(scroll.getScrollY()).toBe(scrolledTo);
    expect(body.style.minHeight).toBe('');
    raf.restore();
  });

  it('does NOT override a reader scroll that follows a clamp within the same settle window', async () => {
    // Codex P2 (follow-up) on #394: a clamp sampled early must not lock in the
    // restore. If the reader scrolls AFTER the clamp — later in a delayed settle —
    // that scroll (a move to a headroom offset) supersedes the clamp, so the
    // release leaves them where they scrolled rather than snapping to the bottom.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`clamp-then-scroll-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    const firstId = rows[0].closest('li')!.getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const rowCount = container.querySelectorAll('[data-item-id]').length;
    expect(rowCount).toBeGreaterThan(8);
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const before = scroll.getScrollY();

    act(() => {
      source.stateStore.hide(firstId);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${firstId}"]`)).toBeNull(),
    );

    // A spike BEYOND the defensive ceiling: the freeze absorbs an ordinary ~2×
    // spike, so to exercise the reactive restore backstop (and the supersede logic
    // this test covers) the viewport jumps far past 2× and the clamp still fires.
    scroll.setViewport(rowCount * 100 + 800);
    scroll.setScrollY(scroll.getScrollY());
    act(() => window.dispatchEvent(new Event('scroll')));
    raf.flushOne();
    expect(scroll.getScrollY()).toBeLessThan(before);

    // The viewport reverts and the reader THEN scrolls up — a later settle frame
    // samples that headroom move, superseding the earlier clamp.
    scroll.setViewport(400);
    const scrolledTo = 120;
    scroll.setScrollY(scrolledTo);
    act(() => window.dispatchEvent(new Event('scroll')));
    raf.flushOne();

    raf.flush();
    // The reader keeps their scroll — the clamp does not snap them back.
    expect(scroll.getScrollY()).toBe(scrolledTo);
    // This device spiked, so the hold is spike-safe (durable); on a short list the
    // reader's new spot can still be within a spike's reach of the bottom, so a
    // small tail persists to protect it. It clears once they scroll up out of reach.
    scroll.setScrollY(0);
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(body.style.minHeight).toBe('');
    expect(scroll.getScrollY()).toBe(0);
    raf.restore();
  });

  it('syncs the tracked offset on release so a second dismiss does not restore against a stale one', async () => {
    // Codex P2 (2nd follow-up) on #394: scroll events are ignored while locked,
    // so after the settle honors a reader scroll the tracked offset would still
    // be the PRE-dismiss value. If the reader dismisses again before any further
    // scroll event, a clamp on that second dismiss would restore against the
    // stale offset and snap them to the old bottom. The release syncs the tracked
    // offset to the reader's actual position, so the second restore uses it.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`stale-offset-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const rowCount = container.querySelectorAll('[data-item-id]').length;
    expect(rowCount).toBeGreaterThan(9);

    // Reader at the bottom; dismiss #1.
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const idOf = () =>
      container.querySelector('[data-item-id]')!.getAttribute('data-item-id')!;
    const firstId = idOf();
    act(() => source.stateStore.hide(firstId));
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${firstId}"]`)).toBeNull(),
    );

    // The reader scrolls UP (headroom, no clamp) during settle #1; it's honored
    // (no restore) and the release must sync the tracked offset to here. No
    // further scroll event is dispatched afterwards — that's the crux.
    const mid = 300;
    scroll.setScrollY(mid);
    act(() => window.dispatchEvent(new Event('scroll')));
    raf.flush();
    expect(scroll.getScrollY()).toBe(mid);

    // Dismiss #2, with the reader still at `mid`. A big viewport jump clamps even
    // from mid (short frozen document once doubled).
    const secondId = idOf();
    act(() => source.stateStore.hide(secondId));
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${secondId}"]`)).toBeNull(),
    );
    // A spike beyond the defensive ceiling (an ordinary 2× spike is now absorbed),
    // so the clamp still fires from `mid` and the stale-offset restore is exercised.
    scroll.setViewport(rowCount * 100 + 800);
    scroll.setScrollY(scroll.getScrollY());
    act(() => window.dispatchEvent(new Event('scroll')));
    raf.flushOne();
    expect(scroll.getScrollY()).toBeLessThan(mid);
    scroll.setViewport(400);
    raf.flush();

    // Restored to where the reader actually was (`mid`) — NOT the stale old
    // bottom the pre-dismiss-#1 offset would have snapped them to.
    expect(scroll.getScrollY()).toBe(mid);
    raf.restore();
  });

  it('carries a settle-window scroll forward when a second dismiss reschedules the settle', async () => {
    // Codex P2 (3rd follow-up) on #394: if a second dismiss lands BEFORE the
    // first settle releases, the effect is torn down and restarted with a fresh
    // closure (readerMovedDuringSettle back to false, no release-time sync ran).
    // The scroll the reader already made during the first (locked) settle must
    // still be reflected in the tracked offset, or the rescheduled settle's clamp
    // restores against the stale pre-dismiss offset. sample() syncs the tracked
    // offset the moment it sees the reader move, so it survives the restart.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`resched-settle-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const rowCount = container.querySelectorAll('[data-item-id]').length;
    expect(rowCount).toBeGreaterThan(9);
    const idOf = () =>
      container.querySelector('[data-item-id]')!.getAttribute('data-item-id')!;

    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));

    // Dismiss #1 — settle #1 is scheduled but NOT drained.
    const firstId = idOf();
    act(() => source.stateStore.hide(firstId));
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${firstId}"]`)).toBeNull(),
    );

    // The reader scrolls up during settle #1; ONE settle frame samples that move
    // (and syncs the tracked offset), then a second dismiss reschedules the
    // settle before it releases — discarding settle #1's per-window state.
    const mid = 300;
    scroll.setScrollY(mid);
    act(() => window.dispatchEvent(new Event('scroll')));
    raf.flushOne();
    const secondId = idOf();
    act(() => source.stateStore.hide(secondId));
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${secondId}"]`)).toBeNull(),
    );

    // Settle #2 hits a viewport clamp beyond the defensive ceiling (an ordinary 2×
    // spike is now absorbed), so it fires from `mid` and the carry-forward restore
    // is exercised. The min-height is still frozen from dismiss #1 (never released).
    scroll.setViewport(rowCount * 100 + 800);
    scroll.setScrollY(scroll.getScrollY());
    act(() => window.dispatchEvent(new Event('scroll')));
    raf.flushOne();
    expect(scroll.getScrollY()).toBeLessThan(mid);
    scroll.setViewport(400);
    raf.flush();

    // Restored to the reader's carried-forward position (`mid`), not the stale
    // pre-dismiss-#1 bottom.
    expect(scroll.getScrollY()).toBe(mid);
    raf.restore();
  });

  it('carries a settle-window scroll forward even when no frame sampled it (delayed rAF)', async () => {
    // Codex P2 (4th follow-up) on #394: if rAF is delayed, the reader can scroll
    // during the first (locked) settle and dismiss again before ANY frame runs,
    // so the in-frame carry-forward never fires. The persistent last-sample lets
    // the rescheduled settle's synchronous start-sample still detect that scroll
    // (vs. the pre-dismiss baseline) and carry it forward, so a later clamp
    // restores to it rather than the stale offset.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`delayed-raf-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const rowCount = container.querySelectorAll('[data-item-id]').length;
    expect(rowCount).toBeGreaterThan(9);
    const idOf = () =>
      container.querySelector('[data-item-id]')!.getAttribute('data-item-id')!;

    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));

    // Dismiss #1 — settle #1's synchronous start-sample records the bottom, then
    // NO frame runs (rAF delayed).
    const firstId = idOf();
    act(() => source.stateStore.hide(firstId));
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${firstId}"]`)).toBeNull(),
    );

    // Reader scrolls up; the event is ignored (locked) and no frame samples it.
    const mid = 300;
    scroll.setScrollY(mid);
    act(() => window.dispatchEvent(new Event('scroll')));

    // Dismiss #2 reschedules the settle — its start-sample compares the current
    // (scrolled) offset against the persisted bottom baseline and carries it.
    const secondId = idOf();
    act(() => source.stateStore.hide(secondId));
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${secondId}"]`)).toBeNull(),
    );

    // Clamp in settle #2 — beyond the defensive ceiling so it fires despite the
    // freeze (an ordinary 2× spike is now absorbed).
    scroll.setViewport(rowCount * 100 + 800);
    scroll.setScrollY(scroll.getScrollY());
    act(() => window.dispatchEvent(new Event('scroll')));
    raf.flushOne();
    expect(scroll.getScrollY()).toBeLessThan(mid);
    scroll.setViewport(400);
    raf.flush();

    // Restored to where the reader actually was, not the stale bottom.
    expect(scroll.getScrollY()).toBe(mid);
    raf.restore();
  });

  it('opts out of scroll anchoring even when a background refresh already holds the height lock', async () => {
    // Regression (Codex review on #226): if a background refresh (pull-to-
    // refresh / focus) is already in flight when the reader sweeps, the general
    // layout-effect path has taken the min-height lock WITHOUT disabling
    // anchoring (correct — it doesn't remove in-viewport rows). lockBodyHeight()
    // used to bail on `heightLockedRef.current` before opting anchoring out, so
    // the swept rows left with anchoring live and the top-snap could recur. The
    // anchor opt-out is now applied even when reusing an existing lock. (A
    // mutation no longer refetches, so the in-flight refresh is driven here by an
    // explicit invalidation — the pull-to-refresh / focus path.)
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ groupByFeed: true, limit: 100 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    let release: (() => void) | null = null;
    let callCount = 0;
    const fetchPage = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ items: seed.items, nextCursor: null });
      }
      // Hold every later refetch open so the background refresh stays in flight
      // (isRefreshing true, lock held) across the sweep.
      return new Promise<{ items: FeedItem[]; nextCursor: string | null }>(
        (resolve) => {
          release = () => resolve({ items: seed.items, nextCursor: null });
        },
      );
    });

    const viewKey = `gp-midrefresh-${viewKeySeq++}`;
    const { container } = renderWithProviders(
      <ItemList
        viewKey={viewKey}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source, queryClient },
    );
    await screen.findAllByTestId('item-row');
    const fullRows = container.querySelectorAll('[data-item-id]').length;

    const body = screen.getByTestId('item-list-body');
    Object.defineProperty(body, 'offsetHeight', { value: 1000, configurable: true });

    // Kick off a genuine background refresh (held open) without touching the
    // first section we're about to sweep. The general path takes the min-height
    // lock — but leaves anchoring ON (the auto-hide guarantee).
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
    });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(body.style.minHeight).toBe('1000px');
    expect(body.style.overflowAnchor).not.toBe('none');

    // Now sweep the first feed's section WHILE that refresh is still held. The
    // height lock is already taken, so this exercises the reuse path — anchoring
    // must still be opted out (transiently) so the section's collapse can't snap
    // to the top, even though lockBodyHeight's height branch is skipped.
    const anchorWrites = recordOverflowAnchorWrites(body);
    await user.click(screen.getAllByTestId('group-sweep')[0]);
    await waitFor(() =>
      expect(container.querySelectorAll('[data-item-id]').length).toBeLessThan(
        fullRows,
      ),
    );
    // The opt-out was applied for the removal frame and then dropped — the
    // height lock (taken by the prior refresh) stays put the whole time.
    expect(anchorWrites).toContain('none');
    expect(body.style.overflowAnchor).toBe('');
    expect(body.style.minHeight).toBe('1000px');

    act(() => release?.());
  });

  it('defends a dismiss at the bottom that lands while a background refresh holds the lock', async () => {
    // Codex P2 on #405: when a background refresh (pull-to-refresh / focus) already
    // holds the height lock, lockBodyHeight opts anchoring out but reused the plain
    // pre-refresh height — and the no-refetch settle bails while isRefreshing — so a
    // dynamic-toolbar spike after a bottom Sweep/Done could still clamp the reader.
    // The reused-lock path now raises the freeze to spike-safe too, so they're held.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    let release: (() => void) | null = null;
    let callCount = 0;
    const fetchPage = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ items: seed.items, nextCursor: null });
      }
      // Hold the refetch open so the background refresh stays in flight across the
      // dismiss (isRefreshing true, lock held).
      return new Promise<{ items: FeedItem[]; nextCursor: string | null }>(
        (resolve) => {
          release = () => resolve({ items: seed.items, nextCursor: null });
        },
      );
    });
    const viewKey = `midrefresh-bottom-${viewKeySeq++}`;
    const { container } = renderWithProviders(
      <ItemList viewKey={viewKey} fetchPage={fetchPage} emptyLabel="All caught up." />,
      { source, queryClient },
    );
    const rows = await screen.findAllByTestId('item-row');
    const lastId = rows[rows.length - 1]
      .closest('li')!
      .getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const rowCount = container.querySelectorAll('[data-item-id]').length;
    expect(rowCount).toBeGreaterThan(8);
    // Reader starts partway down — this is the offset the always-on tracker records.
    scroll.setScrollY(200);
    act(() => window.dispatchEvent(new Event('scroll')));

    // Kick off a held-open background refresh — the lock is taken, and crucially the
    // scroll tracker now freezes (it bails while the lock is held).
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
    });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(body.style.minHeight).not.toBe('');

    // The reader scrolls to the very bottom DURING the refresh. The tracker is stale
    // (still 200), but window.scrollY is their true, un-clamped position.
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const before = scroll.getScrollY();
    expect(before).toBeGreaterThan(200);

    // Dismiss the bottom row WHILE that refresh is still in flight (the reused-lock
    // path), then spike. Sizing must use the live scrollY (the bottom), not the stale
    // tracker (200) — otherwise the raise is too small and the spike clamps.
    act(() => {
      source.stateStore.hide(lastId);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${lastId}"]`)).toBeNull(),
    );
    scroll.setViewport(800);
    scroll.setScrollY(scroll.getScrollY());
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(scroll.getScrollY()).toBe(before);

    // Let the refresh settle; the reader is still held exactly where they were.
    scroll.setViewport(400);
    act(() => release?.());
    raf.flush();
    expect(scroll.getScrollY()).toBe(before);
    raf.restore();
  });

  it('restores a spike-at-commit dismiss that lands mid-refresh after the reader scrolled', async () => {
    // The deepest corner (Codex P2 on #405): a background refresh holds the lock, the
    // reader scrolls to the bottom DURING it (so a frozen tracker would be stale), and
    // the dynamic-toolbar spike is ALREADY live — the browser has clamped them — when
    // they mark Done. The no-refetch settle is suppressed while isRefreshing, so
    // lockBodyHeight raises the freeze AND restores the reader's live pre-spike offset
    // inline (the raise makes it reachable even mid-spike). This works only because
    // the tracker keeps recording through the refresh, so the offset is the bottom
    // (where they actually are), not the stale pre-refresh position.
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    let release: (() => void) | null = null;
    let callCount = 0;
    const fetchPage = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ items: seed.items, nextCursor: null });
      }
      return new Promise<{ items: FeedItem[]; nextCursor: string | null }>(
        (resolve) => {
          release = () => resolve({ items: seed.items, nextCursor: null });
        },
      );
    });
    const viewKey = `midrefresh-spike-${viewKeySeq++}`;
    const { container } = renderWithProviders(
      <ItemList viewKey={viewKey} fetchPage={fetchPage} emptyLabel="All caught up." />,
      { source, queryClient },
    );
    const rows = await screen.findAllByTestId('item-row');
    const lastId = rows[rows.length - 1]
      .closest('li')!
      .getAttribute('data-item-id')!;

    const body = screen.getByTestId('item-list-body');
    const scroll = installScrollModel(body, container, {
      innerHeight: 400,
      rowHeight: 100,
    });
    const raf = installManualRaf();

    const rowCount = container.querySelectorAll('[data-item-id]').length;
    expect(rowCount).toBeGreaterThan(8);
    // Reader starts partway down — the tracker's last honest sample before the lock.
    scroll.setScrollY(200);
    act(() => window.dispatchEvent(new Event('scroll')));

    // Held-open background refresh takes the lock.
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
    });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

    // Reader scrolls to the bottom DURING the refresh — the tracker keeps recording
    // (no clamp while the freeze holds the doc tall), so it follows to the bottom.
    scroll.setScrollY(scroll.maxScroll());
    act(() => window.dispatchEvent(new Event('scroll')));
    const before = scroll.getScrollY();
    expect(before).toBeGreaterThan(200);

    // The dynamic toolbar is ALREADY spiking (innerHeight 800 vs. the true 400) and
    // has clamped the reader down when they mark Done.
    act(() => {
      scroll.setViewport(800);
      scroll.setScrollY(scroll.getScrollY());
    });
    expect(scroll.getScrollY()).toBeLessThan(before);

    act(() => {
      source.stateStore.hide(lastId);
    });
    await waitFor(() =>
      expect(container.querySelector(`[data-item-id="${lastId}"]`)).toBeNull(),
    );

    // Restored inline to the bottom (their live pre-spike offset), mid-spike — not
    // left at the clamp, and not aimed at the stale 200 the frozen tracker held.
    expect(scroll.getScrollY()).toBe(before);

    // Still held after the spike reverts and the refresh settles.
    scroll.setViewport(400);
    act(() => release?.());
    raf.flush();
    expect(scroll.getScrollY()).toBe(before);
    raf.restore();
  });

  it('clears the height lock when the body unmounts (miss-state), so a later refresh re-locks the remounted body', async () => {
    // Regression (Codex review on #184): lockBodyHeight() takes the lock right
    // before a Sweep empties the list. Sweeping the list empty while offline
    // flips it into the miss-state panel, so `.item-list__body` unmounts while
    // the lock is held. The release effect used to `return` on a null body
    // without dropping `heightLockedRef`, so the flag stayed stuck true — and
    // the next refresh on the remounted body skipped the lock entirely,
    // reintroducing the jump. The body is restored here via Undo (synchronous,
    // no fetch) so isRefreshing never cycles false to self-heal the stale flag
    // before the asserting refresh fires on reconnect.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems();

    let heldRelease: (() => void) | null = null;
    let callCount = 0;
    const fetchPage = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ items: seed.items, nextCursor: null });
      }
      // The asserting refresh (paused while offline, resumes on reconnect): held
      // open so isRefreshing stays true while we read the lock off the body.
      return new Promise<{ items: FeedItem[]; nextCursor: string | null }>(
        (resolve) => {
          heldRelease = () => resolve({ items: seed.items, nextCursor: null });
        },
      );
    });

    renderWithProviders(
      <ItemList
        viewKey={`miss-relock-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    // Lock is taken against the live body (1000px tall) when the sweep commits.
    const bodyA = screen.getByTestId('item-list-body');
    Object.defineProperty(bodyA, 'offsetHeight', { value: 1000, configurable: true });

    // Go offline, then sweep the list empty → the offline miss-state panel
    // replaces `.item-list__body`, which unmounts while the lock is held. The
    // cached page survives (the refetch is merely paused), so Undo can restore.
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));
    _resetNetworkStatusForTests();

    await user.click(screen.getByTestId('sweep-btn'));
    await waitFor(() =>
      expect(screen.queryByTestId('item-list-body')).toBeNull(),
    );

    // Undo restores the swept rows synchronously — body remounts, no fetch
    // (offline pauses it), so isRefreshing is still false (the old code's
    // release branch can't fire to paper over the stuck flag).
    await user.click(screen.getByTestId('undo-btn'));
    const bodyB = await screen.findByTestId('item-list-body');
    expect(bodyB).not.toBe(bodyA);
    Object.defineProperty(bodyB, 'offsetHeight', { value: 1000, configurable: true });
    expect(bodyB.style.minHeight).toBe('');

    // Reconnect: the paused refetch resumes (held open) → isRefreshing true.
    // That refresh must re-lock the remounted body; with the stuck flag it
    // would be skipped and minHeight would stay unset.
    act(() => {
      Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(bodyB.style.minHeight).toBe('1000px'));

    act(() => heldRelease?.());
    await waitFor(() => expect(bodyB.style.minHeight).toBe(''));
  });

  it('forces a refetch on Undo so a row already reconciled out of items[] comes back (Codex P2 #375)', async () => {
    // A normal dismiss marks the feed stale WITHOUT refetching (so the reader's
    // scroll isn't reflowed) and relies on the local overlay to drop the row.
    // But Undo must RESTORE a row, and if a focus/PTR refresh already reconciled
    // a dismissed row out of items[], restoring its state alone can't bring it
    // back. Undo therefore forces the refetch that re-includes it.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems();
    const fetchPage = vi.fn(() =>
      Promise.resolve({ items: seed.items, nextCursor: null }),
    );
    renderWithProviders(
      <ItemList
        viewKey={`undo-refetch-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    const id = rows[0].closest('li')!.getAttribute('data-item-id')!;

    // Dismiss one row → the dismiss itself does NOT refetch (the whole point).
    act(() => {
      source.stateStore.hide(id);
    });
    const undo = await screen.findByTestId('undo-btn');
    expect(fetchPage).toHaveBeenCalledTimes(1);

    // Undo forces a refetch.
    await user.click(undo);
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
  });

  it('refetches again when the outbox drains so an Undo restore survives the async write (Codex P2 #376)', async () => {
    // On the live Supabase source the restoring write is delivered through the
    // async outbox, so the immediate post-Undo refetch races ahead of it and
    // reads server truth that still marks the row dismissed — a reconciled-out
    // row would stay gone until the next focus/PTR. The store's subscribeSynced
    // fires on the outbox drain; ItemList refetches then, and holds the
    // pending-scroll request open (rather than giving up after the racing
    // refetch) while `pendingItemIds()` still lists a restored id.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems();
    const rowId = seed.items[0].item.id;
    const withoutRow = seed.items.slice(1);
    const rowInDom = () =>
      document.querySelector(`[data-item-id="${rowId}"]`) != null;

    // The server omits the row until its restoring write drains; then it returns.
    let serverHasRow = false;
    const fetchPage = vi.fn(() =>
      Promise.resolve({
        items: serverHasRow ? seed.items : withoutRow,
        nextCursor: null,
      }),
    );
    // Model the async outbox: the restoring write is pending until we drain it.
    let pending = new Set<string>();
    source.pendingItemIds = () => pending;

    renderWithProviders(
      <ItemList
        viewKey={`undo-drain-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(rowInDom()).toBe(false); // reconciled out of the server's pages

    // The row was dismissed earlier (recorded as the undoable batch); its
    // restoring write will sit in the outbox once we Undo.
    act(() => {
      source.stateStore.hide(rowId);
    });
    pending = new Set([rowId]);
    const undo = await screen.findByTestId('undo-btn');

    // Undo fires the immediate (racing) refetch — server still omits the row.
    await user.click(undo);
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(rowInDom()).toBe(false);
    // The racing refetch settled without the row, but the request is NOT dropped
    // because the write is still pending — no third refetch has fired yet.
    await Promise.resolve();
    expect(fetchPage).toHaveBeenCalledTimes(2);

    // The outbox drains: server truth now reflects the restore. subscribeSynced
    // refetches, and the row comes back on screen.
    serverHasRow = true;
    pending = new Set();
    act(() => {
      source.stateStore.notifySynced();
    });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(rowInDom()).toBe(true));
  });

  it('releases the sweep height lock when no refresh starts (offline partial sweep), so there is no stuck blank tail', async () => {
    // Regression (Codex review on #184): the sweep pre-lock relies on a
    // background refresh to drive its release. Offline, a *partial* sweep
    // (some rows remain) leaves React Query's invalidated refetch paused, so
    // isRefreshing never flips and — because rows remain — showMissState stays
    // false too. The release layout effect then never re-runs, and the body
    // kept its pre-sweep min-height forever: a persistent blank tail. A
    // post-paint backstop now releases a held lock once nothing is refreshing.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const fetchPage = vi.fn((cursor: string | null) =>
      source.getHomeItems({ cursor, groupByFeed: true, limit: 100 }),
    );
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`offline-partial-sweep-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
        groupByFeed
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    const body = screen.getByTestId('item-list-body');
    Object.defineProperty(body, 'offsetHeight', { value: 1000, configurable: true });

    // Go offline so the post-sweep invalidation's refetch is paused (never
    // flips isRefreshing).
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));
    _resetNetworkStatusForTests();

    // Sweep only the first feed's section (header broom) — other sections
    // remain, so the body stays mounted and showMissState stays false.
    const sectionsBefore = container.querySelectorAll('.item-list__group-header').length;
    expect(sectionsBefore).toBeGreaterThan(1);
    await user.click(screen.getAllByTestId('group-sweep')[0]);

    // The section's rows are gone, the body is still mounted with the survivors…
    await waitFor(() =>
      expect(container.querySelectorAll('.item-list__group-header').length).toBe(
        sectionsBefore - 1,
      ),
    );
    expect(screen.getByTestId('item-list-body')).toBe(body);
    // …and the lock did NOT get stuck: the document settles to its natural
    // height (no blank tail) even though no refresh ran to release it.
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

  it('ignores a second sweep tap while the first is still animating', async () => {
    // A sweep defers its hide until the slide+fade finishes. Tapping any sweep
    // button again before that settles must be a no-op: the in-flight batch
    // owns the animation, and a second (different) batch would clobber the
    // pending ids — committing the wrong rows and stranding the first batch
    // mid-animation. Here the second tap targets a *different* feed's broom, so
    // without the guard its rows would be swept and the first feed's rows would
    // stay stuck wearing `--sweeping` forever.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const { container } = renderGrouped(source);
    await screen.findAllByTestId('item-row');

    const totalBefore = container.querySelectorAll('[data-item-id]').length;
    const brooms = screen.getAllByTestId('group-sweep');
    expect(brooms.length).toBeGreaterThanOrEqual(2);

    // Sweep the first feed — its visible rows start the slide+fade.
    await user.click(brooms[0]);
    const sweepingRows = Array.from(
      container.querySelectorAll('.item-list__row--sweeping'),
    );
    expect(sweepingRows.length).toBeGreaterThan(0);
    const firstFeedIds = sweepingRows.map((li) => li.getAttribute('data-item-id'));

    // Second tap, a different feed's broom, before the first sweep settles.
    await user.click(screen.getAllByTestId('group-sweep')[1]);
    // The guard dropped it — no extra rows joined the animation.
    expect(
      container.querySelectorAll('.item-list__row--sweeping'),
    ).toHaveLength(sweepingRows.length);

    // Commit the in-flight sweep via a matching animationend on a swept row.
    act(() => {
      const ev = new Event('animationend', { bubbles: true }) as AnimationEvent;
      Object.defineProperty(ev, 'animationName', {
        value: 'item-list__sweep-out',
      });
      sweepingRows[0].dispatchEvent(ev);
    });

    await waitFor(() => {
      // Nothing is stranded mid-animation, and exactly the first feed's rows
      // left — the second feed's rows were never swept.
      expect(
        container.querySelectorAll('.item-list__row--sweeping'),
      ).toHaveLength(0);
    });
    for (const id of firstFeedIds) {
      expect(container.querySelector(`[data-item-id="${id}"]`)).toBeNull();
    }
    expect(container.querySelectorAll('[data-item-id]').length).toBe(
      totalBefore - firstFeedIds.length,
    );
  });

  it('ignores a toolbar Sweep that lands right after a per-feed sweep commits', async () => {
    // Repro: tap a feed section's broom, then tap the toolbar Sweep a beat
    // later — just after the first sweep's animation commits. In grouped mode
    // the section refills the instant its rows hide, so without a post-commit
    // cooldown that second tap immediately clears the freshly-surfaced rows
    // (and every other feed), reading as "it swept the feed twice". The
    // cooldown drops the rapid follow-up; the other feeds survive.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const { container } = renderGrouped(source);
    await screen.findAllByTestId('item-row');

    const totalBefore = container.querySelectorAll('[data-item-id]').length;
    const brooms = screen.getAllByTestId('group-sweep');
    expect(brooms.length).toBeGreaterThanOrEqual(2);

    // Sweep the first feed and let it fully commit via animationend.
    await user.click(brooms[0]);
    const sweepingRows = Array.from(
      container.querySelectorAll('.item-list__row--sweeping'),
    );
    const firstFeedIds = sweepingRows.map((li) => li.getAttribute('data-item-id'));
    act(() => {
      const ev = new Event('animationend', { bubbles: true }) as AnimationEvent;
      Object.defineProperty(ev, 'animationName', {
        value: 'item-list__sweep-out',
      });
      sweepingRows[0].dispatchEvent(ev);
    });
    await waitFor(() => {
      expect(
        container.querySelectorAll('.item-list__row--sweeping'),
      ).toHaveLength(0);
    });

    // The toolbar Sweep is enabled (other feeds remain) — tapping it within the
    // cooldown must be dropped, so nothing else is swept.
    const toolbarSweep = screen.getByTestId('sweep-btn');
    expect(toolbarSweep).toBeEnabled();
    await user.click(toolbarSweep);

    expect(
      container.querySelectorAll('.item-list__row--sweeping'),
    ).toHaveLength(0);
    // Only the first feed's rows are gone; every other feed's rows survived.
    expect(container.querySelectorAll('[data-item-id]').length).toBe(
      totalBefore - firstFeedIds.length,
    );
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
      // Soft-disabled via aria-disabled (not the native attribute) so the
      // TooltipButton still surfaces its tooltip on hover/long-press.
      expect(screen.getByTestId('sweep-btn')).toHaveAttribute('aria-disabled', 'true');
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

    it('keeps scroll anchoring on when a row auto-hides off the top', async () => {
      // The sweep fix opts the body out of scroll anchoring, but ONLY for the
      // sweep — which dismisses rows inside the viewport. Auto-hide-on-scroll
      // removes rows ABOVE the viewport top and depends on native anchoring to
      // keep the first still-visible row fixed; disabling it there would jolt
      // the content upward by each removed row's height. So an auto-hide must
      // never set the sweep's `overflow-anchor: none` opt-out on the body.
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const source = new MockDataSource(`test-${Math.random()}`);
      renderHome(source);

      const firstRow = (await screen.findAllByTestId('item-row'))[0];
      const titleText = within(firstRow).getByTestId('item-title').textContent;

      act(() => {
        setVisibilityForTest(firstRow.closest('li')!, 0);
      });
      await waitFor(() => {
        const titles = screen
          .queryAllByTestId('item-title')
          .map((n) => n.textContent);
        expect(titles).not.toContain(titleText);
      });

      // The row was removed and the invalidation refresh is in flight — the
      // general height lock may apply, but anchoring must stay ON.
      expect(
        screen.getByTestId('item-list-body').style.overflowAnchor,
      ).not.toBe('none');
    });

    it('defers an auto-hide while a touch is in progress, committing it on release', async () => {
      // Removing a row above the viewport while the reader's finger is still
      // down shifts content up under them (the browser suspends scroll
      // anchoring mid-touch) — at the foot of the list that yanks the next feed
      // group into view. The top-exit must be buffered until the finger lifts.
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const source = new MockDataSource(`test-${Math.random()}`);
      renderHome(source);

      const firstRow = (await screen.findAllByTestId('item-row'))[0];
      const titleText = within(firstRow).getByTestId('item-title').textContent;
      const titles = () =>
        screen.queryAllByTestId('item-title').map((n) => n.textContent);

      // Finger down, then the row scrolls fully off the top.
      act(() => {
        document.dispatchEvent(new Event('touchstart'));
      });
      act(() => {
        setVisibilityForTest(firstRow.closest('li')!, 0);
      });

      // Deferred: the row is still on screen while the touch is held.
      await Promise.resolve();
      expect(titles()).toContain(titleText);

      // The finger lifts (no touches remain) → the buffered hide commits.
      act(() => {
        const ev = new Event('touchend');
        Object.defineProperty(ev, 'touches', { value: [] });
        document.dispatchEvent(ev);
      });
      await waitFor(() => {
        expect(titles()).not.toContain(titleText);
      });
    });

    it.each([
      ['fully', 1],
      ['partially', 0.5],
    ])(
      'does not commit a deferred auto-hide for a row scrolled %s back into view before release',
      async (_label, ratio) => {
        // Reverse-direction race: a held touch scrolls a row off the top (the
        // hide is buffered, not committed), then the reader scrolls back up so
        // the same row is visible again — fully OR only partially — before
        // lifting. Either way the row is under the finger, so the flush must
        // drop it; marking it Done would make a visible row vanish on release.
        window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
        resetReadingPrefsCacheForTest();
        const source = new MockDataSource(`test-${Math.random()}`);
        renderHome(source);

        const firstRow = (await screen.findAllByTestId('item-row'))[0];
        const li = firstRow.closest('li')!;
        const titleText = within(firstRow).getByTestId('item-title').textContent;
        const titles = () =>
          screen.queryAllByTestId('item-title').map((n) => n.textContent);

        act(() => {
          document.dispatchEvent(new Event('touchstart'));
        });
        // Off the top (buffered)…
        act(() => {
          setVisibilityForTest(li, 0);
        });
        // …then reversed back into view (fully or partially) before lift.
        act(() => {
          setVisibilityForTest(li, ratio);
        });
        act(() => {
          const ev = new Event('touchend');
          Object.defineProperty(ev, 'touches', { value: [] });
          document.dispatchEvent(ev);
        });

        await Promise.resolve();
        expect(titles()).toContain(titleText);
      },
    );

    it('does not commit a deferred auto-hide until the last finger lifts', async () => {
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const source = new MockDataSource(`test-${Math.random()}`);
      renderHome(source);

      const firstRow = (await screen.findAllByTestId('item-row'))[0];
      const titleText = within(firstRow).getByTestId('item-title').textContent;
      const titles = () =>
        screen.queryAllByTestId('item-title').map((n) => n.textContent);

      act(() => {
        document.dispatchEvent(new Event('touchstart'));
      });
      act(() => {
        setVisibilityForTest(firstRow.closest('li')!, 0);
      });

      // A touchend that still leaves a finger down must keep the hide deferred.
      act(() => {
        const ev = new Event('touchend');
        Object.defineProperty(ev, 'touches', { value: [{}] });
        document.dispatchEvent(ev);
      });
      await Promise.resolve();
      expect(titles()).toContain(titleText);
    });

    it('holds the reader’s scroll position when a held-touch auto-hide batch is flushed on release', async () => {
      // Regression: with Group by feed + auto-hide-on-scroll, scrolling with a
      // finger down then lifting flushed the buffered top-exits as one bulk
      // removal. The browser's scroll anchoring under-compensates for that (and
      // is suppressed for a beat after a touch), so the first still-visible row
      // jerked upward — at worst snapping the view to the next feed group. The
      // flush now pins a surviving row clear of the top sweep zone and restores
      // it to the same client-top via window.scrollBy as the rows above collapse.
      //
      // jsdom has no layout, so model one: each rendered row is ROW px tall,
      // stacked from document top 0, and getBoundingClientRect().top is
      // (current DOM index)*ROW - scrollY — so hiding rows above collapses the
      // ones below (their indices shift) exactly as a browser would, and a
      // scrollBy that lowers scrollY pushes the surviving rows back down.
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const ROW = 80;
      let scrollY = 240; // reader has scrolled three rows past the top
      const scrollYSpy = vi
        .spyOn(window, 'scrollY', 'get')
        .mockImplementation(() => scrollY);
      const scrollBySpy = vi.fn((_x: number, y: number) => {
        scrollY += y;
      });
      vi.stubGlobal('scrollBy', scrollBySpy);
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          const li = this.matches?.('li[data-item-id]')
            ? this
            : this.closest?.('li[data-item-id]');
          if (li) {
            const all = [...document.querySelectorAll('li[data-item-id]')];
            const top = all.indexOf(li) * ROW - scrollY;
            return {
              top, bottom: top + ROW, height: ROW, left: 0, right: 0,
              width: 0, x: 0, y: top, toJSON: () => ({}),
            } as DOMRect;
          }
          return {
            top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0,
            x: 0, y: 0, toJSON: () => ({}),
          } as DOMRect;
        });

      try {
        const source = new MockDataSource(`test-${Math.random()}`);
        renderWithProviders(
          <ItemList
            viewKey={`hold-scroll-${viewKeySeq++}`}
            fetchPage={(cursor) =>
              source.getHomeItems({ cursor, groupByFeed: true, limit: 100 })
            }
            emptyLabel="All caught up."
            groupByFeed
          />,
          { source },
        );

        const lis = (await screen.findAllByTestId('item-row')).map(
          (r) => r.closest('li')!,
        );
        // The anchor the flush should pin: the first row clear of the top sweep
        // zone (chrome 0 + ANCHOR_SAFE_MARGIN_PX 56 → first row with top ≥ 56,
        // i.e. DOM index 4 at top 4*80 - 240 = 80).
        const anchorLi = lis[4];
        expect(anchorLi.getBoundingClientRect().top).toBe(80);

        // Finger down, then the first three rows scroll off the top (buffered).
        act(() => {
          document.dispatchEvent(new Event('touchstart'));
        });
        act(() => {
          for (const li of lis.slice(0, 3)) setVisibilityForTest(li, 0);
        });
        // Still deferred while held — nothing removed, scroll untouched.
        expect(scrollBySpy).not.toHaveBeenCalled();

        // The finger lifts → the buffered batch commits and the pin restores the
        // anchor: the three rows above it leave, so it would jump from top 80 to
        // top 80 - 3*80 = -160 (delta -240); the pin scrolls back by that delta.
        await act(async () => {
          const ev = new Event('touchend');
          Object.defineProperty(ev, 'touches', { value: [] });
          document.dispatchEvent(ev);
        });

        expect(scrollBySpy).toHaveBeenCalledWith(0, -240);
        // …leaving the anchor row exactly where the reader left it.
        expect(anchorLi.getBoundingClientRect().top).toBe(80);
      } finally {
        rectSpy.mockRestore();
        scrollYSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    });

    it('clears the release-time scroll pin if the setting turns off while it is active', async () => {
      // A held-touch auto-hide flush temporarily disables browser scroll
      // anchoring on the list body while it pins a surviving row in place. If
      // the reader turns the setting off before the next scroll/input releases
      // that pin, the effect cleanup must clear `overflow-anchor: none`;
      // otherwise the mounted list keeps anchoring disabled and later
      // dismissals/sweeps can jump again.
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const ROW = 80;
      let scrollY = 240;
      const scrollYSpy = vi
        .spyOn(window, 'scrollY', 'get')
        .mockImplementation(() => scrollY);
      const scrollBySpy = vi.fn((_x: number, y: number) => {
        scrollY += y;
      });
      vi.stubGlobal('scrollBy', scrollBySpy);
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          const li = this.matches?.('li[data-item-id]')
            ? this
            : this.closest?.('li[data-item-id]');
          if (li) {
            const all = [...document.querySelectorAll('li[data-item-id]')];
            const top = all.indexOf(li) * ROW - scrollY;
            return {
              top, bottom: top + ROW, height: ROW, left: 0, right: 0,
              width: 0, x: 0, y: top, toJSON: () => ({}),
            } as DOMRect;
          }
          return {
            top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0,
            x: 0, y: 0, toJSON: () => ({}),
          } as DOMRect;
        });

      try {
        const source = new MockDataSource(`test-${Math.random()}`);
        renderWithProviders(
          <ItemList
            viewKey={`toggle-pin-${viewKeySeq++}`}
            fetchPage={(cursor) =>
              source.getHomeItems({ cursor, groupByFeed: true, limit: 100 })
            }
            emptyLabel="All caught up."
            groupByFeed
          />,
          { source },
        );

        const lis = (await screen.findAllByTestId('item-row')).map(
          (r) => r.closest('li')!,
        );
        const body = screen.getByTestId('item-list-body');

        act(() => {
          document.dispatchEvent(new Event('touchstart'));
        });
        act(() => {
          for (const li of lis.slice(0, 3)) setVisibilityForTest(li, 0);
        });
        await act(async () => {
          const ev = new Event('touchend');
          Object.defineProperty(ev, 'touches', { value: [] });
          document.dispatchEvent(ev);
        });

        expect(body.style.overflowAnchor).toBe('none');

        act(() => {
          window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '0');
          window.dispatchEvent(new Event('readmo:reading-pref-changed'));
        });

        expect(body.style.overflowAnchor).toBe('');
      } finally {
        rectSpy.mockRestore();
        scrollYSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    });

    it('releases the scroll pin on post-flick momentum scroll, so it does not fight the fling', async () => {
      // Regression (Codex review on #253): after the release flush arms the pin,
      // a flick keeps scrolling as momentum/inertia — which fires no touch,
      // wheel, or keydown, only `scroll`. The pin must let go on a native scroll
      // it didn't cause (offset differs from the one its own correction left),
      // or it would keep snapping the viewport back to the anchor and cancel the
      // fling until the reader taps. Same virtual-layout model as the test above.
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const ROW = 80;
      let scrollY = 240;
      const scrollYSpy = vi
        .spyOn(window, 'scrollY', 'get')
        .mockImplementation(() => scrollY);
      const scrollBySpy = vi.fn((_x: number, y: number) => {
        scrollY += y;
      });
      vi.stubGlobal('scrollBy', scrollBySpy);
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          const li = this.matches?.('li[data-item-id]')
            ? this
            : this.closest?.('li[data-item-id]');
          if (li) {
            const all = [...document.querySelectorAll('li[data-item-id]')];
            const top = all.indexOf(li) * ROW - scrollY;
            return {
              top, bottom: top + ROW, height: ROW, left: 0, right: 0,
              width: 0, x: 0, y: top, toJSON: () => ({}),
            } as DOMRect;
          }
          return {
            top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0,
            x: 0, y: 0, toJSON: () => ({}),
          } as DOMRect;
        });

      try {
        const source = new MockDataSource(`test-${Math.random()}`);
        renderWithProviders(
          <ItemList
            viewKey={`momentum-${viewKeySeq++}`}
            fetchPage={(cursor) =>
              source.getHomeItems({ cursor, groupByFeed: true, limit: 100 })
            }
            emptyLabel="All caught up."
            groupByFeed
          />,
          { source },
        );

        const lis = (await screen.findAllByTestId('item-row')).map(
          (r) => r.closest('li')!,
        );

        // Flick: finger down, three rows scroll off the top, finger lifts → the
        // flush commits and the pin restores (scrollBy(0, -240), scrollY → 0).
        act(() => {
          document.dispatchEvent(new Event('touchstart'));
        });
        act(() => {
          for (const li of lis.slice(0, 3)) setVisibilityForTest(li, 0);
        });
        await act(async () => {
          const ev = new Event('touchend');
          Object.defineProperty(ev, 'touches', { value: [] });
          document.dispatchEvent(ev);
        });
        expect(scrollBySpy).toHaveBeenCalledTimes(1);

        // Momentum glides the viewport on (no touch/wheel/key) and fires scroll.
        act(() => {
          scrollY = 60;
          document.dispatchEvent(new Event('scroll'));
        });

        // A further row now scrolls off during the glide. With the pin released
        // the list just drops it — it must NOT scrollBy to snap back to the old
        // anchor (which is exactly what fought the fling before the fix).
        await act(async () => {
          setVisibilityForTest(lis[3], 0);
        });
        expect(scrollBySpy).toHaveBeenCalledTimes(1);
      } finally {
        rectSpy.mockRestore();
        scrollYSpy.mockRestore();
        vi.unstubAllGlobals();
      }
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

    it('scrolls back up to the topmost restored row when it is above the fold', async () => {
      const user = userEvent.setup();
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const scrollToSpy = vi.fn();
      vi.stubGlobal('scrollTo', scrollToSpy);
      // The reader has scrolled well down the page; the restored rows remount
      // above the fold (negative rect.top), so Undo should pull the viewport
      // back up to them. target = rect.top + scrollY − topChrome = -500 + 1000.
      Object.defineProperty(window, 'scrollY', { value: 1000, configurable: true });
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({
          top: -500,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect);

      try {
        const source = new MockDataSource(`test-${Math.random()}`);
        renderHome(source);
        const titles = () =>
          screen.queryAllByTestId('item-title').map((n) => n.textContent);

        const rows = await screen.findAllByTestId('item-row');
        const first = within(rows[0]).getByTestId('item-title').textContent;
        act(() => setVisibilityForTest(rows[0].closest('li')!, 0));
        await waitFor(() => expect(titles()).not.toContain(first));

        scrollToSpy.mockClear();
        await user.click(screen.getByTestId('undo-btn'));
        await waitFor(() => expect(titles()).toContain(first));
        await waitFor(() =>
          expect(scrollToSpy).toHaveBeenCalledWith({
            top: 500,
            behavior: 'smooth',
          }),
        );
      } finally {
        rectSpy.mockRestore();
      }
    });

    it('does not scroll on Undo when the restored row is already on screen', async () => {
      const user = userEvent.setup();
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const scrollToSpy = vi.fn();
      vi.stubGlobal('scrollTo', scrollToSpy);
      // Restored row sits below the (zero-height in jsdom) sticky chrome, i.e.
      // fully on screen — the "only if off-screen" guard must leave it be.
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({
          top: 120,
          bottom: 200,
          left: 0,
          right: 0,
          width: 0,
          height: 80,
          x: 0,
          y: 120,
          toJSON: () => ({}),
        } as DOMRect);

      try {
        const source = new MockDataSource(`test-${Math.random()}`);
        renderHome(source);
        const titles = () =>
          screen.queryAllByTestId('item-title').map((n) => n.textContent);

        const rows = await screen.findAllByTestId('item-row');
        const first = within(rows[0]).getByTestId('item-title').textContent;
        act(() => setVisibilityForTest(rows[0].closest('li')!, 0));
        await waitFor(() => expect(titles()).not.toContain(first));

        scrollToSpy.mockClear();
        await user.click(screen.getByTestId('undo-btn'));
        await waitFor(() => expect(titles()).toContain(first));
        // The restored row was on screen, so no scroll was triggered.
        expect(scrollToSpy).not.toHaveBeenCalled();
      } finally {
        rectSpy.mockRestore();
      }
    });

    it('scrolls back on a grouped section-header Undo too, not just the toolbar', async () => {
      const user = userEvent.setup();
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const scrollToSpy = vi.fn();
      vi.stubGlobal('scrollTo', scrollToSpy);
      Object.defineProperty(window, 'scrollY', { value: 1000, configurable: true });
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({
          top: -500,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect);

      try {
        const source = new MockDataSource(`test-${Math.random()}`);
        renderWithProviders(
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
        const rows = await screen.findAllByTestId('item-row');
        const firstId = rows[0].closest('li')!.getAttribute('data-item-id');
        act(() => setVisibilityForTest(rows[0].closest('li')!, 0));
        await waitFor(() =>
          expect(
            document.querySelector(`[data-item-id="${firstId}"]`),
          ).toBeNull(),
        );

        scrollToSpy.mockClear();
        // Undo from a section header (the global single-level undo), not the
        // toolbar — it must scroll back the same way.
        await user.click(screen.getAllByTestId('group-undo')[0]);
        await waitFor(() =>
          expect(
            document.querySelector(`[data-item-id="${firstId}"]`),
          ).not.toBeNull(),
        );
        await waitFor(() =>
          expect(scrollToSpy).toHaveBeenCalledWith({
            top: 500,
            behavior: 'smooth',
          }),
        );
      } finally {
        rectSpy.mockRestore();
      }
    });

    it('consumes the undo-scroll request so a later render does not re-scroll', async () => {
      const user = userEvent.setup();
      window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
      resetReadingPrefsCacheForTest();
      const scrollToSpy = vi.fn();
      vi.stubGlobal('scrollTo', scrollToSpy);
      Object.defineProperty(window, 'scrollY', { value: 1000, configurable: true });
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({
          top: -500,
          bottom: 0,
          left: 0,
          right: 0,
          width: 0,
          height: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect);

      try {
        const source = new MockDataSource(`test-${Math.random()}`);
        renderHome(source);
        const titles = () =>
          screen.queryAllByTestId('item-title').map((n) => n.textContent);

        const rows = await screen.findAllByTestId('item-row');
        const first = within(rows[0]).getByTestId('item-title').textContent;
        act(() => setVisibilityForTest(rows[0].closest('li')!, 0));
        await waitFor(() => expect(titles()).not.toContain(first));

        await user.click(screen.getByTestId('undo-btn'));
        await waitFor(() => expect(titles()).toContain(first));
        await waitFor(() => expect(scrollToSpy).toHaveBeenCalled());

        // The request is one-shot: a later auto-hide (which changes the rendered
        // list again) must NOT trigger another undo-scroll.
        scrollToSpy.mockClear();
        const again = await screen.findAllByTestId('item-row');
        const againFirst = within(again[0]).getByTestId('item-title').textContent;
        act(() => setVisibilityForTest(again[0].closest('li')!, 0));
        await waitFor(() => expect(titles()).not.toContain(againFirst));
        expect(scrollToSpy).not.toHaveBeenCalled();
      } finally {
        rectSpy.mockRestore();
      }
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

    // The loading indicator is up; no exhausted-feed message should flash under it.
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
    // The offline miss-state points at the one view that still works: /offline.
    expect(
      screen.getByRole('link', { name: 'View saved articles' }),
    ).toHaveAttribute('href', '/offline');
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

    it('keeps an in-session pin in place within a windowed feed section', async () => {
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const base = [mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2)];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      const fetchFeedPage = vi.fn(() =>
        Promise.resolve({ items: [] as FeedItem[], nextCursor: null }),
      );
      renderWithProviders(
        <ItemList
          viewKey={`psm-pin-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={3}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');
      const order = () =>
        [...document.querySelectorAll('[data-item-id]')].map((el) =>
          el.getAttribute('data-item-id'),
        );
      expect(order()).toEqual(['A-0', 'A-1', 'A-2']);

      // Pin the middle row while viewing it.
      const midRow = document.querySelector('[data-item-id="A-1"]') as HTMLElement;
      await user.click(within(midRow).getByTestId('pin-btn'));
      await waitFor(() => {
        const row = document.querySelector('[data-item-id="A-1"]') as HTMLElement;
        expect(within(row).getByTestId('pin-btn')).toHaveAttribute(
          'aria-pressed',
          'true',
        );
      });
      // It must not lead the section — the in-session pin keeps its slot
      // (without the in-session rule the data layer lifts pins to the section
      // top, which would reorder this to ['A-1', 'A-0', 'A-2']).
      expect(order()).toEqual(['A-0', 'A-1', 'A-2']);
    });

    it('keeps a cross-device pin in place in a windowed feed section', async () => {
      // Codex P2 #2 on #411: a pin arriving from another device (hydrate, never
      // the local mutation channel) for a row on screen must show its badge in
      // place, not jump to the section top. `basePinnedRef` (load-time baseline)
      // is what catches this — the row was in the set unpinned, so it was never
      // baselined; the old stayInBodyIds-only gate let it promote.
      const { source, mk } = await makeRows();
      const base = [mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2)];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      const fetchFeedPage = vi.fn(() =>
        Promise.resolve({ items: [] as FeedItem[], nextCursor: null }),
      );
      renderWithProviders(
        <ItemList
          viewKey={`psm-xpin-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={3}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');
      const order = () =>
        [...document.querySelectorAll('[data-item-id]')].map((el) =>
          el.getAttribute('data-item-id'),
        );
      expect(order()).toEqual(['A-0', 'A-1', 'A-2']);

      // A-1 pinned on another device.
      act(() => {
        source.stateStore.hydrate([
          ['A-1', { ...DEFAULT_ITEM_STATE, pinned: true, pinnedAt: Date.now() }],
        ]);
      });
      await waitFor(() => {
        const row = document.querySelector('[data-item-id="A-1"]') as HTMLElement;
        expect(within(row).getByTestId('pin-btn')).toHaveAttribute(
          'aria-pressed',
          'true',
        );
      });
      // Order unchanged — the badge shows in place (before the fix it promoted to
      // ['A-1', 'A-0', 'A-2']).
      expect(order()).toEqual(['A-0', 'A-1', 'A-2']);
    });

    it('keeps a pinned row visible in a grouped section even when it is also Done (pin wins, no phantom)', async () => {
      // The reported live bug: a pinned article also marked Done locally (pinned,
      // then opened on a mark-done-on-open feed) was dropped by the feed's
      // Done/Hidden display filter, so after PTR the grouped section collapsed to
      // a phantom "More" — even though the server returns the pinned row and it's
      // still in /pinned. The pin must win: the row shows normally, not grayed,
      // not removed.
      const { source, mk } = await makeRows();
      source.stateStore.hydrate([
        [
          'A-0',
          {
            ...DEFAULT_ITEM_STATE,
            pinned: true,
            pinnedAt: Date.now(),
            done: true,
            doneAt: Date.now(),
          },
        ],
      ]);
      const base = [mk('A', 'Feed A', 0)];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      const fetchFeedPage = vi.fn(() =>
        Promise.resolve({ items: [] as FeedItem[], nextCursor: null }),
      );
      renderWithProviders(
        <ItemList
          viewKey={`psm-pin-done-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={3}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');
      const row = document.querySelector('[data-item-id="A-0"]') as HTMLElement | null;
      expect(row).not.toBeNull();
      // Shown normally — not dismissed/grayed, not filtered out.
      expect(row?.classList.contains('item-list__row--dismissed')).toBe(false);
      expect(
        within(row as HTMLElement).getByTestId('pin-btn'),
      ).toHaveAttribute('aria-pressed', 'true');
    });

    it('keeps a pinned row visible when it falls outside the per-feed window (never strands it behind a phantom More)', async () => {
      // Repro of the "pull-to-refresh hides my pinned article" bug: a pin can sit
      // OUTSIDE the per-feed sticky window — a local/older pin the server still
      // orders by date (so it isn't pinned-first), or a window whose only slot is
      // taken by a since-dismissed row. Gating the pinned promotion on the window
      // dropped the pin, collapsing the section to a phantom "More" (placeholder
      // favicon + no unread badge + hidden pin) until a tap or refresh.
      const { source, mk } = await makeRows();
      // A-1 is pinned at load, but the base read orders it at position 1 (as the
      // live server does for a pin it doesn't yet know about). With perFeedLimit
      // 1, the window is A-0 — so A-1 sits outside it.
      source.stateStore.set('A-1', 'pinned', true);
      const base = [mk('A', 'Feed A', 0), mk('A', 'Feed A', 1)];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      const fetchFeedPage = vi.fn(() =>
        Promise.resolve({ items: [] as FeedItem[], nextCursor: null }),
      );
      renderWithProviders(
        <ItemList
          viewKey={`psm-pin-window-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={1}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');

      // The pinned row renders despite sitting outside the window.
      const pinned = () => document.querySelector('[data-item-id="A-1"]');
      await waitFor(() => expect(pinned()).not.toBeNull());
      expect(
        within(pinned() as HTMLElement).getByTestId('pin-btn'),
      ).toHaveAttribute('aria-pressed', 'true');

      // Dismissing the windowed row spends the window, but the pin must stay —
      // not collapse the section to a phantom that hides it (the PTR symptom).
      act(() => {
        source.stateStore.set('A-0', 'done', true);
      });
      await waitFor(() =>
        expect(document.querySelector('[data-item-id="A-0"]')).toBeNull(),
      );
      expect(pinned()).not.toBeNull();
      expect(
        within(pinned() as HTMLElement).getByTestId('pin-btn'),
      ).toHaveAttribute('aria-pressed', 'true');
    });

    it('shows a promoted out-of-window pin IN ADDITION to the window rows, never displacing one', async () => {
      // Codex P2 on #418: a pin promoted from outside the window must not evict a
      // sticky window row — a displaced row would be hidden yet still counted as
      // seen by handleFeedMore's cursor, skipping it until PTR. The pin shows on
      // top of the full window instead.
      const { source, mk } = await makeRows();
      // A-3 is the overfetched (perFeedLimit+1)th row and is pinned; the window is
      // A-0..A-2.
      source.stateStore.set('A-3', 'pinned', true);
      const base = [
        mk('A', 'Feed A', 0),
        mk('A', 'Feed A', 1),
        mk('A', 'Feed A', 2),
        mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      const fetchFeedPage = vi.fn(() =>
        Promise.resolve({ items: [] as FeedItem[], nextCursor: null }),
      );
      renderWithProviders(
        <ItemList
          viewKey={`psm-pin-additive-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={3}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');
      const ids = () =>
        [...document.querySelectorAll('[data-item-id]')].map((el) =>
          el.getAttribute('data-item-id'),
        );
      // All three window rows AND the promoted pin render — none is skipped.
      await waitFor(() => expect(ids()).toContain('A-3'));
      for (const id of ['A-0', 'A-1', 'A-2', 'A-3']) {
        expect(ids()).toContain(id);
      }
    });

    it('re-baselines an in-session pin on pull-to-refresh so it survives a fresh window that excludes it', async () => {
      // Codex P2 on #418 (the reported scenario): a row loaded UNPINNED, pinned
      // this session, then pull-to-refreshed before the backend reorders it
      // pinned-first. PTR clears stayInBodyIds but must also re-baseline the pin
      // capture (basePinnedRef/seenForBaseRef) — otherwise the pin, never
      // baselined and now outside the fresh window, is dropped and the section
      // collapses to a phantom More.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      let pageItems: FeedItem[] = [mk('A', 'Feed A', 1)];
      const fetchPage = vi.fn(() =>
        Promise.resolve({ items: pageItems, nextCursor: null }),
      );
      const fetchFeedPage = vi.fn(() =>
        Promise.resolve({ items: [] as FeedItem[], nextCursor: null }),
      );
      renderWithProviders(
        <ItemList
          viewKey={`psm-pin-ptr-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={1}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');
      const a1 = () =>
        document.querySelector('[data-item-id="A-1"]') as HTMLElement | null;

      // A-1 loads UNPINNED and inside the window; the reader pins it this session.
      await user.click(within(a1() as HTMLElement).getByTestId('pin-btn'));
      await waitFor(() =>
        expect(within(a1() as HTMLElement).getByTestId('pin-btn')).toHaveAttribute(
          'aria-pressed',
          'true',
        ),
      );

      // The refresh brings a newer row into the window and orders the (locally,
      // not-yet-synced) pinned A-1 by date at position 1 — outside the window.
      pageItems = [mk('A', 'Feed A', 9), mk('A', 'Feed A', 1)];
      // jsdom has no PointerEvent, so fireEvent can't carry pointer coords —
      // polyfill it with a MouseEvent subclass (which does) to drive a real pull.
      if (typeof (globalThis as unknown as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
        class PE extends MouseEvent {
          pointerId: number;
          pointerType: string;
          constructor(type: string, params: PointerEventInit = {}) {
            super(type, params);
            this.pointerId = params.pointerId ?? 0;
            this.pointerType = params.pointerType ?? '';
          }
        }
        (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = PE;
      }
      if (!(Element.prototype as unknown as { setPointerCapture?: unknown }).setPointerCapture) {
        (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
          () => {};
      }
      const ptr = document.querySelector(
        '[data-testid="pull-to-refresh"]',
      ) as HTMLElement;
      await act(async () => {
        fireEvent.pointerDown(ptr, {
          pointerId: 1,
          clientX: 100,
          clientY: 0,
          pointerType: 'touch',
          button: 0,
        });
        fireEvent.pointerMove(ptr, { pointerId: 1, clientX: 100, clientY: 24 });
        fireEvent.pointerMove(ptr, { pointerId: 1, clientX: 100, clientY: 170 });
        fireEvent.pointerUp(ptr, { pointerId: 1, clientX: 100, clientY: 170 });
      });

      // The pinned row survives the refresh (re-baselined → promoted to the top),
      // not hidden behind a phantom More.
      await waitFor(() => expect(fetchPage.mock.calls.length).toBeGreaterThan(1));
      await waitFor(() => expect(a1()).not.toBeNull());
      expect(within(a1() as HTMLElement).getByTestId('pin-btn')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('filters (not grays) a cross-device dismiss that lands while its feed is collapsed', async () => {
      // Codex P2 on #413: a collapsed feed's rows are in visibleItems but render
      // as null, so they were never on screen. A dismiss landing then must be
      // filtered when the feed is expanded, not revealed grayed.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const base = [mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2)];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      const fetchFeedPage = vi.fn(() =>
        Promise.resolve({ items: [] as FeedItem[], nextCursor: null }),
      );
      const { container } = renderWithProviders(
        <ItemList
          viewKey={`psm-collapse-gray-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={3}
        />,
        { source },
      );
      await screen.findByText('Feed A 1');

      // Collapse feed A, then a cross-device dismiss lands on A-1 (now off screen).
      await user.click(screen.getByTestId('group-toggle'));
      await waitFor(() =>
        expect(container.querySelector('[data-item-id="A-1"]')).toBeNull(),
      );
      act(() => {
        source.stateStore.hydrate([
          ['A-1', { ...DEFAULT_ITEM_STATE, done: true, doneAt: Date.now() }],
        ]);
      });

      // Expand: A-1 was dismissed off screen → filtered out, not revealed grayed.
      await user.click(screen.getByTestId('group-toggle'));
      await screen.findByText('Feed A 0');
      expect(container.querySelector('[data-item-id="A-1"]')).toBeNull();
      expect(container.querySelector('[data-item-id="A-0"]')).not.toBeNull();
      expect(container.querySelector('[data-item-id="A-2"]')).not.toBeNull();
    });

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

    it('marking one row Done in a windowed section shrinks it without refilling or reordering (group-by-feed)', async () => {
      // Reported regression: in group-by-feed, with a few rows of a section and
      // the following sections on screen, marking ONE row Done made the section
      // "recalculate" — a fresh row sliding up to replace the dismissed one (or
      // the survivors reordering) — instead of the section simply shrinking and
      // handing its freed space to the content below it.
      //
      // The per-feed sticky display window (`displayedByFeed`) is what holds a
      // section to the rows the reader opted into. A Done flip drops the row
      // from `visibleItems`; the next top-N (the dismissed row gone, a fresh row
      // promoted into its slot) must stay GATED — surfaced only by
      // More/pull-to-refresh, never auto-slotted in. A mutation no longer
      // refetches (refetchType:'none'), so `items[]` keeps the pre-Done window
      // and the row leaves purely via the local overlay: the section goes from N
      // to N-1, the survivors keep their order, and the following section is
      // untouched.
      const { source, mk } = await makeRows();
      const K = 3;
      // Feed A opens windowed to A0-A2 with an overfetched probe (A3); feed B
      // follows so we can assert the next section never moves.
      const basePage = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
        mk('B', 'Feed B', 0), mk('B', 'Feed B', 1),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      const fetchFeedPage = vi.fn(() =>
        Promise.resolve({ items: [] as FeedItem[], nextCursor: null }),
      );
      const { container } = renderWithProviders(
        <ItemList
          viewKey={`psm-single-done-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={K}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');
      const idsOf = () =>
        [...container.querySelectorAll('[data-item-id]')].map((el) =>
          el.getAttribute('data-item-id'),
        );
      // Section A opens windowed to A0-A2 (probe A3 not painted); B shows in full.
      expect(idsOf()).toEqual(['A-0', 'A-1', 'A-2', 'B-0', 'B-1']);

      // The reader marks the middle visible row Done — the single-dismiss store
      // path every row-level Done action funnels through (row menu, Done button,
      // the `d` shortcut, swipe-right). It drops from the rendered list at once.
      act(() => {
        source.stateStore.hide('A-1');
      });
      // A shrank by exactly one and did NOT refill — the gated A-3/A-4 stay put,
      // the survivors keep their order, and feed B never moved.
      await waitFor(() => expect(idsOf()).toEqual(['A-0', 'A-2', 'B-0', 'B-1']));

      // It stays shrunk across a microtask flush — no in-flight refetch can slot
      // A-3/A-4 into A's window.
      await act(async () => {
        await Promise.resolve();
      });
      expect(idsOf()).toEqual(['A-0', 'A-2', 'B-0', 'B-1']);
      // …and A-4 is still reachable on demand — A keeps offering More.
      expect(
        screen.getByTestId('group-more').getAttribute('data-feed-more'),
      ).toBe('A');
    });

    it("shrinks a section's next-More cursor when an extra-loaded row is Done on another device", async () => {
      // Regression: the section's next-More cursor counts how many already-seen
      // rows the server still carries (the offset for the next batch). A cached
      // extra that another device marked Done — learned locally via the
      // item_state resync — is no longer in the server's filtered sequence, so
      // counting it pushes the cursor one past the row that now follows and
      // skips it. The cursor must shrink to exclude the dropped extra.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      // Feed A: window A0-A2 + overfetch probe A3 → A offers More. B is short.
      const base = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
        mk('B', 'Feed B', 0), mk('B', 'Feed B', 1),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      const aMore: Record<string, { items: FeedItem[]; nextCursor: string | null }> = {
        // More #1: append the probe A3 + A4; server says the next batch is at 5.
        '3': { items: [mk('A', 'Feed A', 3), mk('A', 'Feed A', 4)], nextCursor: '5' },
        // After A4 is Done server-side, the next unseen row (A5) sits at offset 4.
        '4': { items: [mk('A', 'Feed A', 5)], nextCursor: null },
        // The buggy offset (5) would skip A5 and land on A6.
        '5': { items: [mk('A', 'Feed A', 6)], nextCursor: null },
      };
      const fetchFeedPage = vi.fn((feedId: string, cursor: string | null) =>
        Promise.resolve(
          feedId === 'A' ? aMore[cursor ?? ''] ?? { items: [], nextCursor: null } : { items: [], nextCursor: null },
        ),
      );
      renderWithProviders(
        <ItemList
          viewKey={`psm-doneextra-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={K}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');

      // More #1 loads extras A3, A4.
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 4');
      expect(fetchFeedPage).toHaveBeenCalledWith('A', '3');

      // Another device marks A4 (an extra) Done; the resync surfaces it locally.
      act(() => {
        source.stateStore.set('A-4', 'done', true);
      });

      // More #2 must page from offset 4 (A4 no longer counts), fetching A5 —
      // not offset 5, which would skip A5 and land on A6.
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 5');
      expect(fetchFeedPage).toHaveBeenCalledWith('A', '4');
      expect(fetchFeedPage).not.toHaveBeenCalledWith('A', '5');
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

    it('ignores a rapid double tap on a section More (no duplicate page fetch)', async () => {
      // Two taps fired in the same tick — before React commits the first tap's
      // `loading: true` (and the resulting `disabled`) — must not issue two
      // `fetchFeedPage` requests. The synchronous in-flight ref rejects the
      // second; `fireEvent` (no act flush between clicks) reproduces the race
      // that a `disabled` attribute alone can't catch.
      const { source, mk } = await makeRows();
      const K = 3;
      const base = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      // Hold the section fetch open so both taps land while the first is in
      // flight.
      let releaseFeedPage: ((items: FeedItem[]) => void) | null = null;
      const fetchFeedPage = vi.fn(
        () =>
          new Promise<{ items: FeedItem[]; nextCursor: string | null }>((resolve) => {
            releaseFeedPage = (items) => resolve({ items, nextCursor: null });
          }),
      );
      renderWithProviders(
        <ItemList
          viewKey={`psm-double-tap-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
          groupByFeed
          fetchFeedPage={fetchFeedPage}
          perFeedLimit={K}
        />,
        { source },
      );
      await screen.findAllByTestId('item-row');

      const moreBtn = screen.getByTestId('group-more');
      await act(async () => {
        fireEvent.click(moreBtn);
        fireEvent.click(moreBtn);
        await Promise.resolve();
      });
      expect(fetchFeedPage).toHaveBeenCalledTimes(1);

      // The single in-flight fetch settles and appends exactly one page.
      await act(async () => {
        releaseFeedPage!([mk('A', 'Feed A', 3), mk('A', 'Feed A', 4), mk('A', 'Feed A', 5)]);
        await Promise.resolve();
      });
      await screen.findByText('Feed A 5');
      expect(fetchFeedPage).toHaveBeenCalledTimes(1);
    });

    it('pinning an extra keeps the section expanded (sticky display set covers the pinned id)', async () => {
      // Regression for the bug where pinning an item that was loaded via
      // "More" silently collapsed the section back to its first `perFeedLimit`
      // rows. The pin moved the extra into the base window, which shifted the
      // first-N base ids and (under the old design) tripped a membership-
      // change detector, dropping the rest of the extras.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      const fetchFeedPage = vi.fn(() =>
        Promise.resolve({
          items: [mk('A', 'Feed A', 3), mk('A', 'Feed A', 4), mk('A', 'Feed A', 5)],
          nextCursor: null,
        }),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-pin-extra-${viewKeySeq++}`;
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

      // Expand the section: window (3) + extras (3) = 6 rows displayed.
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 5');
      expect(screen.getAllByTestId('item-row')).toHaveLength(6);

      // Pin A-4 (an extra) and simulate the global feed invalidation that
      // useFeedInvalidation fires on every state-store mutation. The refetch
      // returns A-4 at the top of A's section, pushing A-3 into the base
      // window. The old design dropped A's extras here; the new design
      // recognizes A-4 as already in the sticky display set.
      source.stateStore.set('A-4', 'pinned', true);
      basePage = [
        mk('A', 'Feed A', 4), mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });

      // All previously visible rows still show — pinning an extra did not
      // collapse the section. And because the reader pinned it in-session while
      // looking at it, A-4 keeps its place rather than jumping to the section
      // top (SPEC.md "pinning a body row keeps its position"); the in-session
      // tracking covers extras revealed by More, not just base-window rows.
      await waitFor(() => {
        expect(screen.getAllByTestId('item-row')).toHaveLength(6);
      });
      const ids = [...document.querySelectorAll('[data-item-id]')].map(
        (el) => el.getAttribute('data-item-id'),
      );
      expect(ids).toEqual(['A-0', 'A-1', 'A-2', 'A-3', 'A-4', 'A-5']);
    });

    it('a fresh top item arriving via invalidation stays hidden until the next "More" tap (sticky display window)', async () => {
      // New design: the per-feed displayed window is sticky from the first
      // read. A refetch that brings in newer items (post-Sweep refill, cross-
      // device drift, RSS items polled in) doesn't auto-promote them into the
      // visible list — the reader explicitly taps "More" (or pulls to
      // refresh) to ingest them. This is what stops post-Sweep auto-refill
      // of `perFeedLimit − pinned` rows from happening, and what keeps a
      // pin-an-extra refetch from shrinking the expanded section.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
        mk('B', 'Feed B', 0), mk('B', 'Feed B', 1),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      // After the cursor reset, the first "More" tap fetches from the *fresh*
      // top of the current server view — cursor='0' since the sticky window
      // and the current base window no longer overlap.
      const fetchFeedPage = vi.fn((_feedId: string, cursor: string | null) =>
        Promise.resolve(
          cursor === '0'
            ? { items: [mk('A', 'Feed A', 9), mk('A', 'Feed A', 8), mk('A', 'Feed A', 7)], nextCursor: null }
            : { items: [], nextCursor: null },
        ),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-sticky-${viewKeySeq++}`;
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
      expect(
        [...document.querySelectorAll('[data-item-id]')].map(
          (el) => el.getAttribute('data-item-id'),
        ),
      ).toEqual(['A-0', 'A-1', 'A-2', 'B-0', 'B-1']);

      // Cross-device drift: a brand new item lands at the top of A.
      basePage = [
        mk('A', 'Feed A', 9), mk('A', 'Feed A', 8), mk('A', 'Feed A', 7), mk('A', 'Feed A', 0),
        mk('B', 'Feed B', 0), mk('B', 'Feed B', 1),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      // The new top item stays hidden — the sticky window still holds the
      // originally-displayed ids. A still offers a "More" (the new top is past
      // the displayed window).
      expect(screen.queryByText('Feed A 9')).toBeNull();
      const moreBtns = () => screen.getAllByTestId('group-more').filter(
        (b) => b.getAttribute('data-feed-more') === 'A',
      );
      expect(moreBtns()).toHaveLength(1);

      // Tap More: fetches from cursor='0' (no sticky overlap with the new
      // base window) and brings the fresh top page in.
      await user.click(moreBtns()[0]);
      await screen.findByText('Feed A 9');
      expect(fetchFeedPage).toHaveBeenCalledWith('A', '0');
    });

    it('reveals a single fresh-at-top item via the first-unseen More cursor (not skipping past it)', async () => {
      // Regression for the overlap-count cursor: with most of the displayed
      // window still on top, counting "how many sticky ids overlap items[]"
      // produced a cursor like perFeedLimit-1, which the server interpreted
      // as the offset PAST the new top item. Switching to "position of the
      // first unseen base-window row" puts the cursor at 0, so the next More
      // page actually contains the freshly-promoted top row.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      const fetchFeedPage = vi.fn((_feedId: string, cursor: string | null) =>
        Promise.resolve(
          cursor === '0'
            ? { items: [mk('A', 'Feed A', 9), mk('A', 'Feed A', 0), mk('A', 'Feed A', 1)], nextCursor: null }
            : { items: [], nextCursor: null },
        ),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-first-unseen-${viewKeySeq++}`;
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

      // One brand-new item lands at the top of A; the rest of the window
      // (A-0..A-2) is unchanged. Old design's overlap-count cursor would be
      // K-1=2 and miss A-9 entirely.
      basePage = [
        mk('A', 'Feed A', 9), mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
      // A-9 stays hidden until More is tapped.
      expect(screen.queryByText('Feed A 9')).toBeNull();

      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 9');
      // The first-unseen position is 0 (A-9 sits at the top of items[]).
      expect(fetchFeedPage).toHaveBeenCalledWith('A', '0');
    });

    it('a viewKey reset during an in-flight More discards the response on both feedExtras AND the sticky display set', async () => {
      // Regression: the sticky-window extension used to run unconditionally
      // after `await fetchFeedPage` returned, so a viewKey reset that wiped
      // `feedExtras` mid-flight (e.g. flipping sort, switching home →
      // folder) had its setFeedExtras updater reject the response while
      // setDisplayedByFeed still added the response's ids to the *new*
      // view's sticky set. Any of those ids that overlapped the new base
      // window would render without a fresh More tap. Gating both updates
      // on the same reqId-match decision via flushSync closes that path.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      // The first view's base read.
      const baseV1 = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      // The second view's base read happens to include one of the OLD
      // More page's ids (A-5). If the sticky update leaks, A-5 would
      // surface without a tap.
      const baseV2 = [
        mk('A', 'Feed A', 5), mk('A', 'Feed A', 6), mk('A', 'Feed A', 7), mk('A', 'Feed A', 8),
      ];
      let activeBase: FeedItem[] = baseV1;
      const fetchPage = vi.fn(() =>
        Promise.resolve({ items: activeBase, nextCursor: null }),
      );
      // Hold the More response open.
      let release: (() => void) | null = null;
      const fetchFeedPage = vi.fn(
        () =>
          new Promise<{ items: FeedItem[]; nextCursor: string | null }>((resolve) => {
            release = () =>
              resolve({ items: [mk('A', 'Feed A', 4), mk('A', 'Feed A', 5)], nextCursor: null });
          }),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });

      function Harness() {
        const [v, setV] = useState(0);
        return (
          <>
            <button data-testid="switch-view" onClick={() => setV(1)}>
              switch
            </button>
            <ItemList
              viewKey={`view-${v}`}
              fetchPage={() => fetchPage()}
              emptyLabel="x"
              groupByFeed
              fetchFeedPage={fetchFeedPage}
              perFeedLimit={K}
            />
          </>
        );
      }
      const { container } = renderWithProviders(<Harness />, { source, queryClient });
      await screen.findAllByTestId('item-row');

      // Start a More for view 0.
      await user.click(screen.getByTestId('group-more'));
      await waitFor(() => expect(fetchFeedPage).toHaveBeenCalledTimes(1));

      // Switch to view 1 BEFORE releasing the response: viewKey reset wipes
      // displayedByFeed and feedExtras. Swap the base data while we're at it.
      activeBase = baseV2;
      await act(async () => {
        screen.getByTestId('switch-view').click();
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      // Release the stale response. setFeedExtras rejects (no entry for A
      // because feedExtras was cleared). The sticky extension MUST also be
      // skipped; otherwise A-5 would slip into view 1's sticky and the
      // base loop would render it without a fresh tap.
      await act(async () => {
        release?.();
        await Promise.resolve();
      });

      // View 1 shows its first `perFeedLimit` rows only. A-5 stays hidden
      // until More is tapped explicitly.
      const ids = [...container.querySelectorAll('[data-item-id]')].map((el) =>
        el.getAttribute('data-item-id'),
      );
      expect(ids).toEqual(['A-5', 'A-6', 'A-7']);
      // (A-5 IS in items[] for view 1 — but only because it's the new top
      // item of the fresh window, not because the stale More leaked it
      // into sticky. The sticky set was rebuilt from baseV2's first 3 ids.)
    });

    it('preserves sticky-set order when restoring cached anchors alongside surviving extras', async () => {
      // Regression: after a heavy refetch flushed the original base rows
      // from items[] while older extras remained, mergedRaw used to push
      // extras first and append cached rows at the end — so the section
      // flipped from {A-0..A-2, A-3..A-4} to {A-3..A-4, A-0..A-2}.
      // mergedRaw now inserts each cached id at the position before the
      // next sticky id that's already in the section, so the displayed
      // order matches the original sticky-set iteration order.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      const fetchFeedPage = vi.fn((_feedId: string, cursor: string | null) =>
        Promise.resolve(
          cursor === '3'
            ? { items: [mk('A', 'Feed A', 3), mk('A', 'Feed A', 4)], nextCursor: null }
            : { items: [], nextCursor: null },
        ),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-order-anchor-${viewKeySeq++}`;
      const { container } = renderWithProviders(
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

      // Expand: extras hold A-3, A-4.
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 4');
      expect(
        [...container.querySelectorAll('[data-item-id]')].map((el) => el.getAttribute('data-item-id')),
      ).toEqual(['A-0', 'A-1', 'A-2', 'A-3', 'A-4']);

      // Heavy refetch flushes A-0..A-2 (the base rows) from items[]; A-3
      // and A-4 stay in extras. Without the order fix the section would
      // flip to [A-3, A-4, A-0, A-1, A-2].
      basePage = [
        mk('A', 'Feed A', 90), mk('A', 'Feed A', 91), mk('A', 'Feed A', 92), mk('A', 'Feed A', 93),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
      expect(
        [...container.querySelectorAll('[data-item-id]')].map((el) => el.getAttribute('data-item-id')),
      ).toEqual(['A-0', 'A-1', 'A-2', 'A-3', 'A-4']);
    });

    it('caps the recomputed More cursor to the server\'s last accepted nextCursor (no skip past unseen tail)', async () => {
      // Regression: after a heavy refetch flushed older sticky rows into
      // the cache and the reader then tapped More on the fresh top page,
      // the next tap recomputed cursor from `sticky ∩ (items[] ∪ extras)`
      // — which over-counted because old extras still contributed. The
      // resulting offset jumped past the unseen tail of the just-returned
      // fresh window and skipped rows permanently. The fix caps the
      // recompute to `existing.nextCursor` (the server's own offset for
      // its next page).
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      const fetchFeedPage = vi.fn((_feedId: string, cursor: string | null) => {
        if (cursor === '3') {
          // First section More — fetch rows after the opening window.
          return Promise.resolve({ items: [mk('A', 'Feed A', 3), mk('A', 'Feed A', 4)], nextCursor: '5' });
        }
        if (cursor === '0') {
          // Heavy-refetch follow-up — fresh top page lands.
          return Promise.resolve({ items: [mk('A', 'Feed A', 90), mk('A', 'Feed A', 91)], nextCursor: '2' });
        }
        if (cursor === '2') {
          // Tap-after-fresh-top — must use the server's nextCursor='2', not
          // the over-counted recomputed offset (which would be 7 from
          // {A-0, A-1, A-2, A-3, A-4, A-90, A-91}).
          return Promise.resolve({ items: [mk('A', 'Feed A', 92)], nextCursor: null });
        }
        return Promise.resolve({ items: [], nextCursor: null });
      });
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-cap-${viewKeySeq++}`;
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

      // Expand: A-3, A-4 land via extras; sticky += {A-3, A-4}, nextCursor='5'.
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 4');

      // Heavy refetch shifts items[] to a fresh top window.
      basePage = [
        mk('A', 'Feed A', 90), mk('A', 'Feed A', 91), mk('A', 'Feed A', 92), mk('A', 'Feed A', 93),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      // Tap More: cursor='0' (first-unseen A-90). Response brings in A-90,
      // A-91 with nextCursor='2'.
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 90');
      expect(fetchFeedPage).toHaveBeenLastCalledWith('A', '0');

      // Tap again. Without the cap the recompute would send '7' and skip
      // A-92. With the cap it honors the server's '2' and fetches A-92.
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 92');
      expect(fetchFeedPage).toHaveBeenLastCalledWith('A', '2');
    });

    it('extends sticky window when a split feed\'s second page arrives (row-cap-overflow boundary)', async () => {
      // Regression: when the grouped base read overflows GROUPED_WINDOW_ROW_CAP,
      // a feed at the page boundary can have its opening window split across
      // pages — page 1 returns the first N rows of that feed, page 2 returns
      // the rest. Without extension, sticky would lock to the partial-page N
      // rows and the rest would never paint (and the section More cursor
      // would be off). The init effect now appends the page-2 rows when the
      // existing sticky ids remain the contiguous prefix of items[].
      const { source, mk } = await makeRows();
      const K = 6;
      const basePage: FeedItem[] = [
        // Feed A: only 2 rows on page 1 (boundary section).
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1),
      ];
      const fetchPage = vi.fn((cursor: string | null) =>
        Promise.resolve(
          cursor === null
            ? { items: basePage, nextCursor: '1' }
            : {
                items: [
                  mk('A', 'Feed A', 2), mk('A', 'Feed A', 3), mk('A', 'Feed A', 4),
                  mk('A', 'Feed A', 5), mk('A', 'Feed A', 6),
                ],
                nextCursor: null,
              },
        ),
      );
      const fetchFeedPage = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-split-${viewKeySeq++}`;
      const { container } = renderWithProviders(
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

      // Initial paint: only A-0, A-1 visible (page 1's partial section).
      const initialIds = [...container.querySelectorAll('[data-item-id]')].map((el) =>
        el.getAttribute('data-item-id'),
      );
      expect(initialIds).toEqual(['A-0', 'A-1']);

      // Global More fetches page 2 — appends the rest of feed A to items[].
      await act(async () => {
        screen.getByTestId('more-btn').click();
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      // Sticky window extended: A-2..A-5 now paint alongside A-0, A-1. The
      // 6th row (A-6) sits past perFeedLimit — it's the probe and stays
      // hidden until a section More.
      await waitFor(() => {
        const idsNow = [...container.querySelectorAll('[data-item-id]')].map((el) =>
          el.getAttribute('data-item-id'),
        );
        expect(idsNow).toEqual(['A-0', 'A-1', 'A-2', 'A-3', 'A-4', 'A-5']);
      });
    });

    it('re-enables an exhausted section\'s More when a new top item arrives (polled-in / cross-device promotion)', async () => {
      // Regression: once `ex.done === true`, feedsWithMore used to drop the
      // feed and handleFeedMore returned early — even when a later refetch
      // surfaced a brand new top item, the only path to reveal it was PTR.
      // Re-enabling More based on `hasUnseenInBaseWindow` and routing the
      // tap through the first-unseen cursor makes the new row reachable.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      const fetchFeedPage = vi.fn((_feedId: string, cursor: string | null) => {
        if (cursor === '3') {
          // First tap exhausts the section.
          return Promise.resolve({ items: [mk('A', 'Feed A', 3), mk('A', 'Feed A', 4)], nextCursor: null });
        }
        if (cursor === '0') {
          // After a new top item arrives, the tap fetches at position 0.
          return Promise.resolve({ items: [mk('A', 'Feed A', 9)], nextCursor: null });
        }
        return Promise.resolve({ items: [], nextCursor: null });
      });
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-redone-${viewKeySeq++}`;
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

      // Tap More to exhaust the section. `ex.done` is now true.
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 4');

      // A new top item arrives via background refresh.
      basePage = [
        mk('A', 'Feed A', 9), mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      // A-9 stays hidden but the section's More re-appears (was dropped
      // when ex.done became true).
      expect(screen.queryByText('Feed A 9')).toBeNull();
      const aMore = screen
        .getAllByTestId('group-more')
        .find((b) => b.getAttribute('data-feed-more') === 'A');
      expect(aMore).toBeDefined();

      // Tap More: cursor='0' (first-unseen) brings A-9 in.
      await user.click(aMore!);
      await screen.findByText('Feed A 9');
      expect(fetchFeedPage).toHaveBeenLastCalledWith('A', '0');
    });

    it('rebases an existing More cursor when the server filters out a previously-seen row (no permanent skip)', async () => {
      // Regression: handleFeedMore used to reuse the saved `nextCursor` on
      // every tap. If a refetch dropped a row that the user had already
      // seen (cross-device Done/Hide), the cursor still pointed past where
      // it should have, so the next More fetched one row TOO FAR and the
      // adjacent unseen row was silently skipped. Recomputing cursor as
      // "count of sticky ids still present in items[] ∪ extras" on every
      // tap auto-shrinks by the count of filtered rows.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      // First More tap returns [A-3, A-4]; second tap, after a server-side
      // drop of A-0, should fetch from cursor='4' (not '5') and return A-5.
      const fetchFeedPage = vi.fn((_feedId: string, cursor: string | null) => {
        if (cursor === '3') {
          return Promise.resolve({ items: [mk('A', 'Feed A', 3), mk('A', 'Feed A', 4)], nextCursor: '5' });
        }
        if (cursor === '4') {
          return Promise.resolve({ items: [mk('A', 'Feed A', 5)], nextCursor: null });
        }
        return Promise.resolve({ items: [], nextCursor: null });
      });
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-rebase-${viewKeySeq++}`;
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

      // Expand: first tap loads A-3, A-4. Saved nextCursor = '5'.
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 4');
      expect(fetchFeedPage).toHaveBeenLastCalledWith('A', '3');

      // Cross-device drop on A-0: the refetch returns the same window
      // minus A-0 (server filtered it out).
      basePage = [
        mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3), mk('A', 'Feed A', 4),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      // Tap More again. Saved nextCursor was '5', but the server view has
      // shrunk by one, so the right offset is '4'. The recomputed cursor
      // yields '4' (sticky overlap = {A-1, A-2, A-3, A-4} = 4 ids; A-0 is
      // no longer in items[] or extras), and the response brings A-5 in.
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 5');
      expect(fetchFeedPage).toHaveBeenLastCalledWith('A', '4');
    });

    it('a sticky row the server filtered out stays visible from cache until local state sync drops it', async () => {
      // The cache fallback no longer drops a sticky id just because the
      // server's refetch omitted it — the more common path is that the
      // local state store will learn about the change (realtime sync) and
      // `visibleItems`' done/hidden filter will then drop the row. This
      // test confirms that contract: the row persists across a refetch
      // that filters it out, and disappears as soon as state sync flips
      // the local flag.
      const { source, mk } = await makeRows();
      const K = 3;
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      const fetchFeedPage = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-cache-anchor-${viewKeySeq++}`;
      const { container } = renderWithProviders(
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

      // Cross-device-style refetch: server returns the window minus A-1.
      basePage = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3), mk('A', 'Feed A', 4),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      // A-1 stays visible (sticky anchor + cache). A-3/A-4 stay hidden
      // until More/PTR per the sticky-window contract. The cache appends
      // missing sticky rows after the items[] order, so A-1's exact
      // position can shift — what matters is that all three remain.
      let ids = [...container.querySelectorAll('[data-item-id]')].map((el) =>
        el.getAttribute('data-item-id'),
      );
      expect(ids).toEqual(expect.arrayContaining(['A-0', 'A-1', 'A-2']));
      expect(ids).toHaveLength(3);

      // Local state sync arrives: A-1 is marked done in the local store.
      // visibleItems' filter drops it immediately.
      await act(async () => {
        source.stateStore.hideMany(['A-1'], Date.now());
      });
      ids = [...container.querySelectorAll('[data-item-id]')].map((el) =>
        el.getAttribute('data-item-id'),
      );
      expect(ids).toEqual(['A-0', 'A-2']);
    });

    it('after a heavy refetch + More tap, cached sticky rows stay alongside the appended fresh page', async () => {
      // Regression for Codex r3481572879: a heavy refetch correctly
      // anchored the section on cached A-0..A-9. But once the reader
      // tapped More to opt into the fresh top page, the new ids landed in
      // sticky/extras and the old (stickyHits === 0) guard then SKIPPED
      // the cache fallback because stickyHits was now nonzero — so the
      // cached rows the reader was viewing silently disappeared instead
      // of staying alongside the appended page.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      const fetchFeedPage = vi.fn((_feedId: string, cursor: string | null) =>
        Promise.resolve(
          cursor === '0'
            ? { items: [mk('A', 'Feed A', 90), mk('A', 'Feed A', 91), mk('A', 'Feed A', 92)], nextCursor: null }
            : { items: [], nextCursor: null },
        ),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-anchor-append-${viewKeySeq++}`;
      const { container } = renderWithProviders(
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

      // Heavy refetch: items[] returns a wholly new top window with none
      // of A-0..A-2 (sticky) present.
      basePage = [
        mk('A', 'Feed A', 90), mk('A', 'Feed A', 91), mk('A', 'Feed A', 92), mk('A', 'Feed A', 93),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
      // Cache fallback kicks in: section still shows the original ids.
      expect(
        [...container.querySelectorAll('[data-item-id]')].map((el) => el.getAttribute('data-item-id')),
      ).toEqual(['A-0', 'A-1', 'A-2']);

      // Tap More: cursor='0' (first-unseen A-90). Response brings in
      // A-90..A-92. The cached anchors A-0..A-2 must STAY visible.
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 90');
      const ids = [...container.querySelectorAll('[data-item-id]')].map((el) =>
        el.getAttribute('data-item-id'),
      );
      expect(ids).toEqual(
        expect.arrayContaining(['A-0', 'A-1', 'A-2', 'A-90', 'A-91', 'A-92']),
      );
    });

    it('renders sticky-anchored rows above a freshly appended More page (no jump-down on heavy refetch + More)', async () => {
      // Regression for Codex r3482278147: when an already-expanded section
      // suffered a heavy refetch (items[] swapped to a fresh top window),
      // the next section More added the fresh ids to displayedByFeed. The
      // mergedRaw build walked items[] in server order, so the fresh rows
      // landed FIRST and the still-cached anchored rows appeared below them
      // — visibly shoving the reader's anchor down the page. The fix
      // iterates non-pinned rows in sticky-set order: cached anchors render
      // at the top (where they have been), and the appended page follows.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      const fetchFeedPage = vi.fn((_feedId: string, cursor: string | null) => {
        if (cursor === '3') {
          // First More — expand the section onto A-3, A-4.
          return Promise.resolve({
            items: [mk('A', 'Feed A', 3), mk('A', 'Feed A', 4)],
            nextCursor: '5',
          });
        }
        if (cursor === '0') {
          // Post-heavy-refetch More — fresh top page.
          return Promise.resolve({
            items: [mk('A', 'Feed A', 90), mk('A', 'Feed A', 91), mk('A', 'Feed A', 92)],
            nextCursor: '3',
          });
        }
        return Promise.resolve({ items: [], nextCursor: null });
      });
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-anchor-order-${viewKeySeq++}`;
      const { container } = renderWithProviders(
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

      // Expand the section: A-3, A-4 land via extras; sticky = [A-0..A-4].
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 4');

      // Heavy refetch: items[] swaps to a fresh top window that doesn't
      // include any sticky id. Extras [A-3, A-4] survive; cache holds
      // A-0..A-2 for fallback.
      basePage = [
        mk('A', 'Feed A', 90), mk('A', 'Feed A', 91), mk('A', 'Feed A', 92), mk('A', 'Feed A', 93),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      // Tap More: cursor='0' (first-unseen A-90). Response brings in
      // A-90..A-92; sticky extends to [A-0..A-4, A-90..A-92]. The order on
      // screen must keep the reader's anchor at the top.
      await user.click(screen.getByTestId('group-more'));
      await screen.findByText('Feed A 90');

      const ids = [...container.querySelectorAll('[data-item-id]')].map((el) =>
        el.getAttribute('data-item-id'),
      );
      expect(ids).toEqual(['A-0', 'A-1', 'A-2', 'A-3', 'A-4', 'A-90', 'A-91', 'A-92']);
    });

    it('does not leak the overfetched probe row when every pinned row in the base read exceeds the section window', async () => {
      // Regression for Codex r3482278147 follow-up: the pinned-first pass
      // in mergedRaw walked every pinned row in baseRun unconditionally.
      // A feed with more pinned rows than perFeedLimit would then paint the
      // (perFeedLimit+1)th pinned row — the server's has-more probe — into
      // the displayed section without a More tap. Gating the pinned pass on
      // `allowed` (the sticky set) blocks the probe just like every other
      // not-yet-opted-into row.
      const { source, mk } = await makeRows();
      const K = 3;
      // Four pinned rows (P0..P3) in feed A — one above the section cap.
      // The fourth row (P3) is the overfetched probe; it must not paint.
      source.stateStore.set('A-0', 'pinned', true);
      source.stateStore.set('A-1', 'pinned', true);
      source.stateStore.set('A-2', 'pinned', true);
      source.stateStore.set('A-3', 'pinned', true);
      const basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      const fetchFeedPage = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-pin-probe-${viewKeySeq++}`;
      const { container } = renderWithProviders(
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
      const ids = [...container.querySelectorAll('[data-item-id]')].map((el) =>
        el.getAttribute('data-item-id'),
      );
      // Only the first K pinned rows render; the probe (A-3) stays hidden.
      expect(ids).toEqual(['A-0', 'A-1', 'A-2']);
    });

    it('keeps the section anchored on cached rows when a heavy refetch flushes every sticky id out of `items[]`', async () => {
      // Regression: the sticky window was just a Set of ids and mergedRaw
      // rendered from items[]/feedExtras only. If a refetch returned more
      // than perFeedLimit newer rows at the top of a feed, none of the
      // previously displayed ids appeared in items[] anymore and the
      // section collapsed to an empty phantom — breaking the SPEC's
      // promise that "the section stays anchored on what the reader is
      // already viewing." The per-id FeedItem cache lets mergedRaw fall
      // back to the prior rows even when the live source no longer carries
      // them.
      const { source, mk } = await makeRows();
      const K = 3;
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
      const fetchFeedPage = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-anchor-${viewKeySeq++}`;
      const { container } = renderWithProviders(
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

      // Heavy churn: the next refetch returns a wholly new top window. None
      // of A-0..A-2 (sticky) appear in `items[]` anymore.
      basePage = [
        mk('A', 'Feed A', 90), mk('A', 'Feed A', 91), mk('A', 'Feed A', 92), mk('A', 'Feed A', 93),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      // The section stays anchored on the originally-displayed rows from
      // the cache. The new top items stay hidden until More/PTR.
      const ids = [...container.querySelectorAll('[data-item-id]')].map((el) =>
        el.getAttribute('data-item-id'),
      );
      expect(ids).toEqual(['A-0', 'A-1', 'A-2']);
      expect(screen.queryByText('Feed A 90')).toBeNull();
    });

    it('renders a swept middle feed\'s phantom section in canonical feed order (not at the tail)', async () => {
      // Regression: phantom sections used to render after ItemRows' full
      // items.map(), which placed a swept middle feed below later still-
      // visible feeds (e.g. A, swept-B, C displayed as A, C, B). Sorting
      // phantoms by feedRank and interleaving them at the proper feed
      // transition keeps the grouped view's ordering intact.
      const { source, mk } = await makeRows();
      const K = 3;
      const fetchPage = vi.fn(() =>
        Promise.resolve({
          items: [
            mk('A', 'Feed A', 0), mk('A', 'Feed A', 1),
            mk('B', 'Feed B', 0), mk('B', 'Feed B', 1), mk('B', 'Feed B', 2), mk('B', 'Feed B', 3),
            mk('C', 'Feed C', 0), mk('C', 'Feed C', 1),
          ],
          nextCursor: null,
        }),
      );
      const fetchFeedPage = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-order-${viewKeySeq++}`;
      const { container } = renderWithProviders(
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

      // Sweep all of B's rows so the section collapses to a phantom. A and
      // C keep their visible rows.
      await act(async () => {
        source.stateStore.hideMany(['B-0', 'B-1', 'B-2'], Date.now());
      });
      await waitFor(() => {
        const ids = [...container.querySelectorAll('[data-item-id]')].map((el) =>
          el.getAttribute('data-item-id'),
        );
        // After the refetch settles items[] has only A and C rows; the
        // sticky window for B still has its original ids so it's empty in
        // the merged view.
        expect(ids).toEqual(['A-0', 'A-1', 'C-0', 'C-1']);
      });

      // The phantom header for B (data-header-for="empty-more:B") must sit
      // between the last A row and the first C row in DOM order. Headers and
      // rows now live inside per-section containers, so compare positions across
      // all tagged elements in document order (querySelectorAll is doc-ordered)
      // rather than by direct-child index.
      const tagged: Element[] = [
        ...container.querySelectorAll('[data-header-for], [data-item-id]'),
      ];
      const indexOf = (predicate: (el: Element) => boolean): number => {
        for (let i = 0; i < tagged.length; i++) {
          if (predicate(tagged[i])) return i;
        }
        return -1;
      };
      const lastIndexOf = (predicate: (el: Element) => boolean): number => {
        for (let i = tagged.length - 1; i >= 0; i--) {
          if (predicate(tagged[i])) return i;
        }
        return -1;
      };
      const bHeaderIdx = indexOf(
        (el) => el.getAttribute('data-header-for') === 'empty-more:B',
      );
      const lastARowIdx = lastIndexOf(
        (el) => el.getAttribute('data-item-id') === 'A-1',
      );
      const firstCRowIdx = indexOf(
        (el) => el.getAttribute('data-item-id') === 'C-0',
      );
      expect(bHeaderIdx).toBeGreaterThan(lastARowIdx);
      expect(bHeaderIdx).toBeLessThan(firstCRowIdx);
    });

    it('defers a live (pin-anchored) section More tapped during the post-Sweep refetch instead of flickering it to Loading', async () => {
      // Sister case to the phantom-More test: when Sweep leaves a pinned row
      // behind, the section stays in `visibleItems` so it's NOT in
      // `emptyMoreSections` — but the same stale-`items[]` problem applies. If
      // handleFeedMore ran its cursor calc against the pre-Sweep window it
      // would count the just-Done rows as seen and emit `cursor = perFeedLimit`,
      // skipping the freshest page. Rather than disable the button during the
      // refetch (which flickered every section's More to "Loading…" on any
      // background refresh), it stays a tappable "More" and a tap is deferred
      // until the refetch settles, then fetches against fresh `items[]`.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      source.stateStore.set('A-0', 'pinned', true);
      let releaseFetchPage: ((items: FeedItem[]) => void) | null = null;
      const fetchPage = vi.fn(
        () =>
          new Promise<{ items: FeedItem[]; nextCursor: string | null }>((resolve) => {
            releaseFetchPage = (items) => resolve({ items, nextCursor: null });
          }),
      );
      // Keyed on cursor so we can assert the deferred tap fetched the correct
      // fresh-window offset ('1' here — A-0 pinned at pos 0, then the first
      // unseen row). The stale-`items[]` bug would have sent '3' and skipped.
      const fetchFeedPage = vi.fn((_feedId: string, cursor: string | null) =>
        Promise.resolve(
          cursor === '1'
            ? { items: [mk('A', 'Feed A', 6)], nextCursor: null }
            : { items: [], nextCursor: null },
        ),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-live-loading-${viewKeySeq++}`;
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
      await act(async () => {
        releaseFetchPage!([
          mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
        ]);
        await Promise.resolve();
      });
      await screen.findAllByTestId('item-row');

      // Sweep the unpinned rows (a local overlay change — a mutation no longer
      // refetches). The pinned A-0 stays visible.
      await act(async () => {
        source.stateStore.hideMany(['A-1', 'A-2'], Date.now());
      });
      // A genuine background refresh (pull-to-refresh / focus) starts a held
      // refetch, so isFetching stays true while we probe the section's More.
      await act(async () => {
        void queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      const aMore = () =>
        screen
          .getAllByTestId('group-more')
          .find((b) => b.getAttribute('data-feed-more') === 'A')!;
      // No flicker: the button stays enabled and labeled "More" through the
      // background refetch — it is NOT relabeled to "Loading…".
      expect(aMore()).toBeEnabled();
      expect(aMore()).toHaveTextContent('More');
      expect(aMore()).not.toHaveTextContent('Loading');

      // Tapping during the refetch is deferred, not run against stale items[].
      await user.click(aMore());
      expect(fetchFeedPage).not.toHaveBeenCalled();

      // Release the refetch with the fresh top page. The deferred tap drains and
      // fetches against fresh items[] — cursor '1', not the stale-skip '3'.
      await act(async () => {
        releaseFetchPage!([
          mk('A', 'Feed A', 0), mk('A', 'Feed A', 3), mk('A', 'Feed A', 4), mk('A', 'Feed A', 5),
        ]);
        await Promise.resolve();
      });
      await waitFor(() => expect(fetchFeedPage).toHaveBeenCalledTimes(1));
      expect(fetchFeedPage).toHaveBeenCalledWith('A', '1');
      // The fresh page the deferred tap pulled in renders (no skip).
      expect(await screen.findByText('Feed A 6')).toBeInTheDocument();
    });

    it('drops a deferred More instead of draining it when the triggering refetch FAILS (items[] still stale)', async () => {
      // A tap deferred during a refetch must not drain when that refetch fails:
      // `items[]` is still the stale pre-refetch window, so running the cursor
      // calc now would compute the old offset and skip the fresh page. Drop the
      // queued tap (button reverts to "More") rather than fetch against stale
      // data; the reader retries once a refresh succeeds.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      // First base read resolves immediately; the invalidation-triggered refetch
      // is held, then REJECTED to simulate a failed background refresh. The
      // section's rows are untouched, so it stays rendered (this isolates the
      // drain-on-failure behavior from the miss-state path a Sweep would hit).
      let callCount = 0;
      let rejectRefetch: (() => void) | null = null;
      const fetchPage = vi.fn(() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve({
            items: [
              mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
            ],
            nextCursor: null,
          });
        }
        return new Promise<{ items: FeedItem[]; nextCursor: string | null }>((_resolve, reject) => {
          rejectRefetch = () => reject(new Error('refresh failed'));
        });
      });
      const fetchFeedPage = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-fail-drain-${viewKeySeq++}`;
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

      // A genuine background refresh (pull-to-refresh / focus) → refetch (held
      // open). No rows are removed, so the section (and its More) is untouched.
      await act(async () => {
        void queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      const aMore = () =>
        screen
          .getAllByTestId('group-more')
          .find((b) => b.getAttribute('data-feed-more') === 'A')!;
      // Tap during the in-flight refetch → deferred (no fetch yet).
      await user.click(aMore());
      expect(fetchFeedPage).not.toHaveBeenCalled();

      // The refetch FAILS. The drain effect runs (isFetching went false) but
      // must NOT fetch, because `items[]` is still the stale pre-refetch window
      // — draining now would compute a stale offset and skip the fresh page.
      // The "Couldn't refresh" strip (role=alert) marks the failure settling.
      await act(async () => {
        rejectRefetch!();
        await Promise.resolve();
      });
      await screen.findByText(/Couldn.t refresh/i);
      // Old behavior (drain on any isFetching=false) would have called
      // fetchFeedPage('A', <stale offset>) here; the fix drops the queued tap.
      expect(fetchFeedPage).not.toHaveBeenCalled();
    });

    it('drops a deferred section More when the global pager fetches mid-refetch (fetchNextPage settles with stale page 1, no error)', async () => {
      // Row-cap-overflow grouped views still expose the bottom/global "More"
      // (hasMore), and it's tappable during a background refetch (gated only on
      // isFetchingMore). Tapping it runs fetchNextPage, which can cancel the
      // in-flight refetch and settle with page 1 still stale and `error` clear —
      // so the success-only drain guard wouldn't catch it. handleMore therefore
      // drops any queued section tap, so the drain never runs it against the
      // stale window.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      let call1Done = false;
      let releaseRefetch: (() => void) | null = null;
      const fetchPage = vi.fn((cursor: string | null) => {
        if (cursor === '1') {
          // Next page via the global pager (fetchNextPage).
          return Promise.resolve({ items: [mk('A', 'Feed A', 4)], nextCursor: null });
        }
        if (!call1Done) {
          call1Done = true;
          // First page: window (3) + probe (A-3), and nextCursor so hasMore is
          // true → the global "More" renders alongside feed A's section "More".
          return Promise.resolve({
            items: [
              mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
            ],
            nextCursor: '1',
          });
        }
        // The invalidation-triggered base refetch — held open so isFetching
        // stays true while we tap.
        return new Promise<{ items: FeedItem[]; nextCursor: string | null }>((resolve) => {
          releaseRefetch = () => resolve({
            items: [
              mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
            ],
            nextCursor: '1',
          });
        });
      });
      const fetchFeedPage = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-global-cancel-${viewKeySeq++}`;
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
      // Both pagers are present: feed A's section "More" and the global "More".
      expect(screen.getByTestId('group-more')).toBeInTheDocument();
      expect(screen.getByTestId('more-btn')).toBeInTheDocument();

      // A genuine background refresh (pull-to-refresh / focus) → base refetch
      // (held) → isFetching true.
      await act(async () => {
        void queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      // Queue a section tap during the refetch, then tap the global pager.
      await user.click(screen.getByTestId('group-more'));
      expect(fetchFeedPage).not.toHaveBeenCalled();
      await user.click(screen.getByTestId('more-btn'));
      // The global pager ran fetchNextPage (page 2, cursor '1').
      await waitFor(() => expect(fetchPage).toHaveBeenCalledWith('1'));

      // Let the held base refetch settle so isFetching goes false — this is the
      // edge the drain effect listens on. With page 1 still stale and no error,
      // the success-only guard alone wouldn't stop it; handleMore having dropped
      // the queued tap is what does.
      await act(async () => {
        releaseRefetch?.();
        await Promise.resolve();
      });
      await waitFor(() => {
        const a = screen
          .getAllByTestId('group-more')
          .find((b) => b.getAttribute('data-feed-more') === 'A')!;
        expect(a).toHaveTextContent('More');
      });
      // The deferred tap was dropped, so the drain never ran it against stale
      // page 1. (Without the fix it would have called fetchFeedPage here.)
      expect(fetchFeedPage).not.toHaveBeenCalled();
    });

    it('defers a phantom More tapped during the post-Sweep refetch (no flicker, no stale-cursor skip)', async () => {
      // With the phantom-section path, an empty post-Sweep section renders the
      // header + a "More" button immediately. While the base refetch is still
      // in flight, `items[]` is the pre-Sweep window — so a cursor calc run now
      // would land at `perFeedLimit` (all sticky ids in the stale window count
      // as "seen") and `getFeedItems` would skip past the freshest non-Done
      // page. Instead of disabling the button (which flickered it to
      // "Loading…"), it stays a tappable "More" and a tap is deferred until the
      // refetch settles, then fetches against fresh `items[]`.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      // Hold the base fetch open via a gate we release from the test.
      let releaseFetchPage: ((items: FeedItem[]) => void) | null = null;
      const fetchPage = vi.fn(
        () =>
          new Promise<{ items: FeedItem[]; nextCursor: string | null }>((resolve) => {
            releaseFetchPage = (items) => resolve({ items, nextCursor: null });
          }),
      );
      // Keyed on cursor: the deferred tap must compute against fresh items[]
      // (cursor '0' — the first row is unseen) and surface the fresh page. The
      // stale-`items[]` bug would have sent '3' and returned nothing.
      const fetchFeedPage = vi.fn((_feedId: string, cursor: string | null) =>
        Promise.resolve(
          cursor === '0'
            ? { items: [mk('A', 'Feed A', 3), mk('A', 'Feed A', 4), mk('A', 'Feed A', 5)], nextCursor: null }
            : { items: [], nextCursor: null },
        ),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-phantom-loading-${viewKeySeq++}`;
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
      // Release the FIRST fetch so the initial paint lands.
      await act(async () => {
        releaseFetchPage!([
          mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
        ]);
        await Promise.resolve();
      });
      await screen.findAllByTestId('item-row');

      // Simulate a Sweep: mark all displayed rows Done locally. A mutation no
      // longer refetches, so `items[]` keeps the pre-Sweep window and
      // visibleItems for A is empty → the phantom header renders.
      await act(async () => {
        source.stateStore.hideMany(['A-0', 'A-1', 'A-2'], Date.now());
      });
      // A genuine background refresh (pull-to-refresh / focus) starts a held
      // base refetch, so isFetching stays true while we tap the phantom More.
      await act(async () => {
        void queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      const aMore = () =>
        screen
          .getAllByTestId('group-more')
          .find((b) => b.getAttribute('data-feed-more') === 'A')!;
      // The phantom More renders and stays a tappable "More" through the
      // refetch — no flicker to "Loading…", no disabled state.
      await waitFor(() => expect(aMore()).toBeInTheDocument());
      expect(aMore()).toBeEnabled();
      expect(aMore()).toHaveTextContent('More');
      expect(aMore()).not.toHaveTextContent('Loading');

      // Tapping during the refetch defers rather than reading stale items[].
      await user.click(aMore());
      expect(fetchFeedPage).not.toHaveBeenCalled();

      // Release the refetch with the fresh top non-Done page. The deferred tap
      // drains against fresh items[] (cursor '0', not the stale-skip '3') and
      // the fresh rows surface.
      await act(async () => {
        releaseFetchPage!([
          mk('A', 'Feed A', 3), mk('A', 'Feed A', 4), mk('A', 'Feed A', 5), mk('A', 'Feed A', 6),
        ]);
        await Promise.resolve();
      });
      await waitFor(() => expect(fetchFeedPage).toHaveBeenCalledTimes(1));
      expect(fetchFeedPage).toHaveBeenCalledWith('A', '0');
      expect(await screen.findByText('Feed A 3')).toBeInTheDocument();
    });

    it('keeps the per-section More reachable after Sweeping an all-unpinned section (phantom header)', async () => {
      // Without a phantom header, sweeping every row of a section that has
      // no pins removed the entire section from the rendered list — the
      // section's More button went with it, so the reader had to pull-to-
      // refresh or remount to see the next page. A single-feed home/folder
      // collapsed all the way to the "all caught up" empty state.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      // Only feed A is present, no pins. Sweep marks A-0..A-2 Done; a mutation
      // no longer refetches, so `items[]` keeps the pre-Sweep window (A-0..A-2 +
      // the A-3 probe). Every displayed id is now Done and the probe stays gated,
      // so without the phantom header path the page would collapse to the empty
      // state.
      const base = [mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3)];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      const fetchFeedPage = vi.fn((_feedId: string, cursor: string | null) =>
        Promise.resolve(
          cursor === '0'
            ? { items: [mk('A', 'Feed A', 3), mk('A', 'Feed A', 4), mk('A', 'Feed A', 5)], nextCursor: null }
            : { items: [], nextCursor: null },
        ),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-phantom-${viewKeySeq++}`;
      const { container } = renderWithProviders(
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

      await act(async () => {
        source.stateStore.hideMany(['A-0', 'A-1', 'A-2'], Date.now());
      });

      // No item rows render — but the section header + More button do.
      await waitFor(() =>
        expect(container.querySelectorAll('[data-item-id]')).toHaveLength(0),
      );
      const aMore = screen
        .getAllByTestId('group-more')
        .find((b) => b.getAttribute('data-feed-more') === 'A');
      expect(aMore).toBeDefined();
      expect(screen.getByText('Feed A')).toBeInTheDocument();

      // Tap More — fetches the freshest page and renders it.
      await user.click(aMore!);
      await screen.findByText('Feed A 5');
      expect(fetchFeedPage).toHaveBeenCalledWith('A', '0');
      const ids = [...container.querySelectorAll('[data-item-id]')].map(
        (el) => el.getAttribute('data-item-id'),
      );
      expect(ids).toEqual(['A-3', 'A-4', 'A-5']);
    });

    it('after Sweep, the section does not auto-refill with `perFeedLimit − pinned` server-newer rows; tap More pulls the next page', async () => {
      // Captures the intended Sweep semantics: marking a section's unpinned
      // rows Done clears them from view. A mutation no longer refetches, so
      // `items[]` keeps the pre-Sweep window (the pin at the top, then the next
      // unread + probe); the sticky display window blocks the gated rows from
      // auto-sliding up. Without this, every Sweep silently pulled
      // `perFeedLimit − pinned` fresh rows just to fill the slots back up.
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      // Pin A-0 BEFORE the first read so the displayed window opens with the
      // pin at the top — the section-header anchor that survives a full Sweep
      // (the pinned row stays put; the rest get marked Done).
      source.stateStore.set('A-0', 'pinned', true);
      // A-0 (pinned) at top of A's section + A-1, A-2 (the rest of the window)
      // + A-3 probe. After Sweep of A-1/A-2, the gated A-3/A-4 must NOT slide up.
      const base = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
        mk('B', 'Feed B', 0), mk('B', 'Feed B', 1),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: base, nextCursor: null }));
      // After Sweep + tap More, cursor='1' — only A-0 (pinned) is still a
      // non-Done sticky overlap for A, so the More tap fetches from offset 1.
      const fetchFeedPage = vi.fn((_feedId: string, cursor: string | null) =>
        Promise.resolve(
          cursor === '1'
            ? { items: [mk('A', 'Feed A', 3), mk('A', 'Feed A', 4), mk('A', 'Feed A', 5)], nextCursor: null }
            : { items: [], nextCursor: null },
        ),
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const viewKey = `psm-sweep-${viewKeySeq++}`;
      const { container } = renderWithProviders(
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
      const beforeIds = [...container.querySelectorAll('[data-item-id]')].map(
        (el) => el.getAttribute('data-item-id'),
      );
      expect(beforeIds).toEqual(['A-0', 'A-1', 'A-2', 'B-0', 'B-1']);

      // Sweep A-1 and A-2 by marking them Done — a local overlay change, no
      // refetch. Section retains only the pinned row — no auto-refill of the
      // swept slots from A-3/A-4. B is untouched.
      await act(async () => {
        source.stateStore.hideMany(['A-1', 'A-2'], Date.now());
      });
      await waitFor(() =>
        expect(
          [...container.querySelectorAll('[data-item-id]')].map((el) =>
            el.getAttribute('data-item-id'),
          ),
        ).toEqual(['A-0', 'B-0', 'B-1']),
      );

      // A still offers a section "More" (items[] for A has rows past the
      // sticky overlap, so feedsWithMore picks it up).
      const aMore = screen
        .getAllByTestId('group-more')
        .find((b) => b.getAttribute('data-feed-more') === 'A');
      expect(aMore).toBeDefined();

      // Tap More — fetches from cursor='1' (A-0 is the only sticky overlap
      // with the new base window) and brings the fresh page in below the pin.
      await user.click(aMore!);
      await screen.findByText('Feed A 5');
      expect(fetchFeedPage).toHaveBeenCalledWith('A', '1');
      const afterMoreIds = [...container.querySelectorAll('[data-item-id]')].map(
        (el) => el.getAttribute('data-item-id'),
      );
      expect(afterMoreIds).toEqual(['A-0', 'A-3', 'A-4', 'A-5', 'B-0', 'B-1']);
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

    it('an in-flight More survives a base refetch that brings a new top item (loading entry is protected)', async () => {
      // Regression for the earlier extras-drop behavior: a mid-flight base
      // refetch used to delete the loading entry, which made setFeedExtras
      // reject the response when it landed — and the unconditional
      // setDisplayedByFeed extension then leaked the stale page's ids into
      // the sticky set. The loading-entry guard in extras-drop now keeps
      // the in-flight request whole; the response commits via the normal
      // reqId-match path, and both the extras and sticky updates run on the
      // same accepted decision (gated by flushSync below).
      const user = userEvent.setup();
      const { source, mk } = await makeRows();
      const K = 3;
      let basePage: FeedItem[] = [
        mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2), mk('A', 'Feed A', 3),
      ];
      const fetchPage = vi.fn(() => Promise.resolve({ items: basePage, nextCursor: null }));
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
      const viewKey = `psm-inflight-${viewKeySeq++}`;
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

      // A brand new item arrives in the base window mid-flight.
      basePage = [
        mk('A', 'Feed A', 9), mk('A', 'Feed A', 0), mk('A', 'Feed A', 1), mk('A', 'Feed A', 2),
      ];
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
      });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      // Release the response. The loading entry was preserved, so setFeedExtras
      // commits and the appended ids reach the display via extras.
      await act(async () => {
        release?.();
        await Promise.resolve();
      });
      await screen.findByText('Feed A 3');
      expect(screen.getByText('Feed A 4')).toBeInTheDocument();
      // The brand new A-9 stays hidden (sticky never opted into it).
      expect(screen.queryByText('Feed A 9')).toBeNull();
    });
  });

  describe('prefetch on reader open', () => {
    // Opening an article warms the feed cache while the reader is up, so the
    // Back-remount paints a settled list instead of reflowing under a tap. The
    // prefetch honors the same staleTime TTL: stale feeds refetch early, fresh
    // ones are left alone.
    it('refetches a stale feed when a row opens the reader', async () => {
      const user = userEvent.setup();
      const source = new MockDataSource(`test-${Math.random()}`);
      const fetchPage = vi.fn<FetchPage>((cursor) =>
        source.getHomeItems({ cursor }),
      );
      // staleTime 0 → the query is stale as soon as the first read settles, so
      // the open-time prefetch (stale: true) fires.
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 60_000, staleTime: 0 } },
      });
      renderWithProviders(
        <ItemList
          viewKey={`home-prefetch-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
        />,
        { source, queryClient },
      );

      const rows = await screen.findAllByTestId('item-row');
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));

      // Tap the row body (the in-app reader Link).
      await user.click(within(rows[0]).getByTestId('item-title'));

      // The open warmed the cache: a second read fired while the reader is up,
      // rather than waiting for the Back-remount to trigger it.
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    });

    it('does not refetch a fresh feed when a row opens the reader', async () => {
      const user = userEvent.setup();
      const source = new MockDataSource(`test-${Math.random()}`);
      const fetchPage = vi.fn<FetchPage>((cursor) =>
        source.getHomeItems({ cursor }),
      );
      // A high staleTime keeps the feed fresh, so the TTL-gated prefetch is a
      // no-op — opening (and later Back) costs no read.
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: 60_000, staleTime: 60_000 },
        },
      });
      renderWithProviders(
        <ItemList
          viewKey={`home-prefetch-${viewKeySeq++}`}
          fetchPage={fetchPage}
          emptyLabel="x"
        />,
        { source, queryClient },
      );

      const rows = await screen.findAllByTestId('item-row');
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));

      await user.click(within(rows[0]).getByTestId('item-title'));

      // Give a would-be refetch a chance to fire before asserting it didn't.
      await act(async () => {
        await Promise.resolve();
      });
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ItemList — cross-device dismiss (frozen list)', () => {
  // The gray-in-place rule keys off viewport intersection (a grayed row is held
  // only while on screen), so these cases drive the IntersectionObserver mock:
  // observing a row defaults it to fully visible; `setVisibilityForTest(li, 0)`
  // scrolls it off screen.
  beforeEach(() => installIntersectionObserverMock());
  afterEach(() => uninstallIntersectionObserverMock());

  const renderGray = (source: MockDataSource, fetchPage: FetchPage) =>
    renderWithProviders(
      <ItemList
        viewKey={`home-graytest-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );

  it('grays a visible row in place when a dismiss arrives from another device', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const page = await source.getHomeItems();
    const target = page.items[0].item.id;
    const { container } = renderGray(source, (c) => source.getHomeItems({ cursor: c }));
    await screen.findAllByTestId('item-row');
    const row = () =>
      container.querySelector(`[data-item-id="${target}"]`) as HTMLElement | null;
    expect(row()).not.toBeNull();

    // A cross-device dismiss arrives via hydrate (server resync) — NOT the local
    // mutation channel — for a row that's on screen.
    act(() => {
      source.stateStore.hydrate([
        [target, { ...DEFAULT_ITEM_STATE, done: true, doneAt: Date.now() }],
      ]);
    });

    // The row stays put, grayed, with an Undo button — it does not collapse out.
    await waitFor(() =>
      expect(row()?.classList.contains('item-list__row--dismissed')).toBe(true),
    );
    expect(within(row()!).getByTestId('row-undo-dismiss')).toBeTruthy();
  });

  it('removes (does not gray) a cross-device dismiss that lands on an off-screen row', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const page = await source.getHomeItems();
    const target = page.items[0].item.id;
    const { container } = renderGray(source, (c) => source.getHomeItems({ cursor: c }));
    await screen.findAllByTestId('item-row');
    const row = () =>
      container.querySelector(`[data-item-id="${target}"]`) as HTMLElement | null;
    expect(row()).not.toBeNull();

    // The target scrolls off screen (below the fold, or above the top), then a
    // cross-device dismiss arrives. Removing it is invisible, so it's dropped
    // immediately rather than held grayed.
    act(() => setVisibilityForTest(row()!.closest('li')!, 0));
    act(() => {
      source.stateStore.hydrate([
        [target, { ...DEFAULT_ITEM_STATE, done: true, doneAt: Date.now() }],
      ]);
    });
    await waitFor(() => expect(row()).toBeNull());
  });

  it('commits a grayed row (drops it) once it scrolls off screen', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const page = await source.getHomeItems();
    const target = page.items[0].item.id;
    const { container } = renderGray(source, (c) => source.getHomeItems({ cursor: c }));
    await screen.findAllByTestId('item-row');
    const row = () =>
      container.querySelector(`[data-item-id="${target}"]`) as HTMLElement | null;

    // On-screen dismiss grays it in place.
    act(() => {
      source.stateStore.hydrate([
        [target, { ...DEFAULT_ITEM_STATE, done: true, doneAt: Date.now() }],
      ]);
    });
    await waitFor(() =>
      expect(row()?.classList.contains('item-list__row--dismissed')).toBe(true),
    );

    // The reader scrolls it off the top — now the held dismissal commits and the
    // row leaves the list.
    act(() => setVisibilityForTest(row()!.closest('li')!, 0));
    await waitFor(() => expect(row()).toBeNull());
  });

  it('grays an on-screen row via the DOM-position fallback when a dismiss lands before the observer reports', async () => {
    // Simulate the first-paint gap: no IntersectionObserver delivery yet, so the
    // live on-screen set is empty and the gray-vs-remove decision must fall back
    // to measuring the row's actual DOM position.
    uninstallIntersectionObserverMock();
    const source = new MockDataSource(`test-${Math.random()}`);
    const page = await source.getHomeItems();
    const target = page.items[0].item.id;
    const { container } = renderGray(source, (c) => source.getHomeItems({ cursor: c }));
    await screen.findAllByTestId('item-row');
    const row = () =>
      container.querySelector(`[data-item-id="${target}"]`) as HTMLElement | null;

    // jsdom reports zero-size rects by default; pin an on-screen rect so the
    // measurement fallback sees the row inside the viewport band.
    vi.spyOn(row()!, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 150,
      left: 0,
      right: 0,
      width: 0,
      height: 50,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect);

    act(() => {
      source.stateStore.hydrate([
        [target, { ...DEFAULT_ITEM_STATE, done: true, doneAt: Date.now() }],
      ]);
    });

    // Grayed in place — not removed — even though the observer never reported it.
    await waitFor(() =>
      expect(row()?.classList.contains('item-list__row--dismissed')).toBe(true),
    );
  });

  it('removes a row you dismissed yourself, rather than graying it', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const page = await source.getHomeItems();
    const target = page.items[0].item.id;
    const { container } = renderGray(source, (c) => source.getHomeItems({ cursor: c }));
    await screen.findAllByTestId('item-row');
    const row = () => container.querySelector(`[data-item-id="${target}"]`);
    expect(row()).not.toBeNull();

    // Your own dismiss goes through the mutation channel (set) → the row drops.
    act(() => {
      source.stateStore.set(target, 'done', true);
    });
    await waitFor(() => expect(row()).toBeNull());
  });

  it('restores a grayed row via its Undo button', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const page = await source.getHomeItems();
    const target = page.items[0].item.id;
    const { container } = renderGray(source, (c) => source.getHomeItems({ cursor: c }));
    await screen.findAllByTestId('item-row');
    const row = () =>
      container.querySelector(`[data-item-id="${target}"]`) as HTMLElement | null;
    act(() => {
      source.stateStore.hydrate([
        [target, { ...DEFAULT_ITEM_STATE, done: true, doneAt: Date.now() }],
      ]);
    });
    await waitFor(() =>
      expect(row()?.classList.contains('item-list__row--dismissed')).toBe(true),
    );

    await user.click(within(row()!).getByTestId('row-undo-dismiss'));

    // Back to a normal row, un-dismissed in the store (restore wins LWW).
    await waitFor(() =>
      expect(row()?.classList.contains('item-list__row--dismissed')).toBe(false),
    );
    expect(source.stateStore.get(target).done).toBe(false);
  });

  it('filters a row that entered already-dismissed (never shows or grays it)', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const page = await source.getHomeItems();
    const target = page.items[0].item.id;
    // Dismissed on another device BEFORE the list first renders. The fetched page
    // still carries it (a stale pre-dismiss snapshot), so this exercises the
    // overlay's filter, not the server-side one.
    source.stateStore.hydrate([
      [target, { ...DEFAULT_ITEM_STATE, done: true, doneAt: Date.now() }],
    ]);
    const { container } = renderGray(source, () =>
      Promise.resolve({ items: page.items, nextCursor: null }),
    );
    await screen.findAllByTestId('item-row');
    // It never appears — filtered on entry, not grayed.
    expect(container.querySelector(`[data-item-id="${target}"]`)).toBeNull();
  });
});

describe('ItemList — Sweep clears grayed rows', () => {
  beforeEach(() => installIntersectionObserverMock());
  afterEach(() => uninstallIntersectionObserverMock());

  it('sweeps grayed cross-device dismisses too, not just fresh ones', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const page = await source.getHomeItems();
    const target = page.items[0].item.id;
    const { container } = renderWithProviders(
      <ItemList
        viewKey={`home-sweepgray-${viewKeySeq++}`}
        fetchPage={(c) => source.getHomeItems({ cursor: c })}
        emptyLabel="All caught up."
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    // A cross-device dismiss grays the target in place.
    act(() => {
      source.stateStore.hydrate([
        [target, { ...DEFAULT_ITEM_STATE, done: true, doneAt: Date.now() }],
      ]);
    });
    const row = () => container.querySelector(`[data-item-id="${target}"]`);
    await waitFor(() =>
      expect(
        (row() as HTMLElement | null)?.classList.contains('item-list__row--dismissed'),
      ).toBe(true),
    );

    // Sweep clears the visible set — the grayed row included (its hideMany is a
    // no-op, but Sweep records it as locally dismissed so the overlay drops it).
    await user.click(screen.getByTestId('sweep-btn'));
    await waitFor(() => expect(row()).toBeNull());
  });
});

describe('ItemList — Refreshing state', () => {
  // A fresh-list fetch can reorder the list under the reader, so it's covered by
  // a "Refreshing" state that blocks taps until it settles (SPEC.md *Feed views →
  // Refreshing*). Exceptions: a "More" next-page append (predictable, at the
  // bottom) and an Undo reconcile (instant, must stay silent).
  it('covers the on-screen list with a Refreshing overlay while a fresh-list refetch is in flight', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    let release: (() => void) | null = null;
    let callCount = 0;
    const fetchPage = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ items: seed.items, nextCursor: null });
      }
      // Hold the refetch open so isRefreshing stays true while we probe the DOM.
      return new Promise<{ items: FeedItem[]; nextCursor: string | null }>(
        (resolve) => {
          release = () => resolve({ items: seed.items, nextCursor: null });
        },
      );
    });
    const viewKey = `refreshing-${viewKeySeq++}`;
    renderWithProviders(
      <ItemList viewKey={viewKey} fetchPage={fetchPage} emptyLabel="All caught up." />,
      { source, queryClient },
    );
    await screen.findAllByTestId('item-row');
    // Settled list: no Refreshing state.
    expect(screen.queryByTestId('refreshing-overlay')).toBeNull();

    // A stale mount/focus re-materialization or PTR — modeled by invalidating the
    // feed query (the same path those take) — holds the refetch open.
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['feed', viewKey] });
    });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    const overlay = screen.getByTestId('refreshing-overlay');
    expect(overlay).toHaveTextContent('Refreshing');

    // Once the fetch settles the overlay clears and the list is tappable again.
    await act(async () => {
      release?.();
    });
    await waitFor(() =>
      expect(screen.queryByTestId('refreshing-overlay')).toBeNull(),
    );
  });

  it('labels the empty-cache first load "Refreshing" rather than "Loading…"', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    let release: (() => void) | null = null;
    const fetchPage = vi.fn(
      () =>
        new Promise<{ items: FeedItem[]; nextCursor: string | null }>((resolve) => {
          release = () => resolve({ items: [], nextCursor: null });
        }),
    );
    renderWithProviders(
      <ItemList
        viewKey={`empty-load-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    // No rows yet, so the state renders inline (not the overlay) and reads
    // "Refreshing".
    const loading = await screen.findByTestId('loading-state');
    expect(loading).toHaveTextContent('Refreshing');
    expect(screen.queryByTestId('refreshing-overlay')).toBeNull();
    await act(async () => {
      release?.();
    });
  });

  it('does NOT show the Refreshing state while "More" fetches the next page', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems({ limit: 100 });
    const firstItems = seed.items.slice(0, 5);
    const restItems = seed.items.slice(5, 10);
    let release: (() => void) | null = null;
    let callCount = 0;
    const fetchPage = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ items: firstItems, nextCursor: '5' });
      }
      // Hold the next-page fetch open so isFetchingNextPage stays true.
      return new Promise<{ items: FeedItem[]; nextCursor: string | null }>(
        (resolve) => {
          release = () => resolve({ items: restItems, nextCursor: null });
        },
      );
    });
    renderWithProviders(
      <ItemList
        viewKey={`more-no-refresh-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    await screen.findAllByTestId('item-row');

    await user.click(screen.getByTestId('more-btn'));
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    // A next-page append is predictable (older rows at the bottom) — no overlay.
    expect(screen.queryByTestId('refreshing-overlay')).toBeNull();

    await act(async () => {
      release?.();
    });
  });

  it('keeps Undo silent — no Refreshing state while its reconcile refetch runs', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const seed = await source.getHomeItems();
    let release: (() => void) | null = null;
    let callCount = 0;
    const fetchPage = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ items: seed.items, nextCursor: null });
      }
      // Hold the Undo-forced refetch open so isRefreshing would be true if the
      // overlay didn't exclude Undo.
      return new Promise<{ items: FeedItem[]; nextCursor: string | null }>(
        (resolve) => {
          release = () => resolve({ items: seed.items, nextCursor: null });
        },
      );
    });
    renderWithProviders(
      <ItemList
        viewKey={`undo-silent-${viewKeySeq++}`}
        fetchPage={fetchPage}
        emptyLabel="All caught up."
      />,
      { source },
    );
    const rows = await screen.findAllByTestId('item-row');
    const id = rows[0].closest('li')!.getAttribute('data-item-id')!;

    // Dismiss then Undo. Undo forces a (held-open) reconcile refetch…
    act(() => {
      source.stateStore.hide(id);
    });
    const undo = await screen.findByTestId('undo-btn');
    await user.click(undo);
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    // …but it stays silent — Undo is predictable and instant.
    expect(screen.queryByTestId('refreshing-overlay')).toBeNull();

    await act(async () => {
      release?.();
    });
  });
});
