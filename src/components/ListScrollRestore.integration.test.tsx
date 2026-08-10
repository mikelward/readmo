import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemList } from './ItemList';
import { ListScrollRestore } from './ListScrollRestore';
import { MockDataSource } from '../lib/data/MockDataSource';
import { PER_FEED_WINDOW } from '../lib/types';
import { clearListScrollAnchors } from '../lib/listScrollAnchor';
import {
  HIDE_ON_SCROLL_KEY,
  HIDE_ON_SCROLL_REMOVE_KEY,
  resetReadingPrefsCacheForTest,
} from '../hooks/useReadingPrefs';
import { resetPromoDismissedCacheForTest } from '../hooks/usePromoDismissed';
import { resetCollapsedFeedsCacheForTest } from '../hooks/useCollapsedFeeds';
import {
  installIntersectionObserverMock,
  setVisibilityForTest,
  uninstallIntersectionObserverMock,
} from '../test/intersectionObserver';

// The reported bug, end to end through the real feed list: with auto-hide on and
// its remove sub-setting OFF, the rows the reader scrolled past are held struck
// in place by state that lives INSIDE ItemList. Opening an article unmounts it,
// so Back rebuilds the list without them — and the browser hands back the pixel
// offset it saved, which now points several articles further down. See SPEC
// *Feed views → Your place survives the round trip to an article*.

const ROW_HEIGHT = 60;

// The modeled window scroll. Back is modeled as the browser restoring the offset
// it saved — i.e. leaving `scrollY` exactly where the reader left it — which is
// what makes a shortened list land them in the wrong place.
let scrollY = 0;

/** Lay every rendered row out at its index: row `i` occupies
 * [i * ROW_HEIGHT, (i + 1) * ROW_HEIGHT) in document space. Installed on the
 * prototype rather than per element so rows added or removed by a re-render are
 * laid out too, and read live so a scroll moves them without a render. */
function installRowLayout(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this instanceof HTMLElement && this.matches('li[data-item-id]')) {
      const rows = Array.from(document.querySelectorAll('li[data-item-id]'));
      const top = rows.indexOf(this) * ROW_HEIGHT - scrollY;
      return {
        top,
        bottom: top + ROW_HEIGHT,
        height: ROW_HEIGHT,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return original.call(this);
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

let frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
function flushFrames(): void {
  act(() => {
    for (let guard = 0; guard < 50 && frames.size > 0; guard += 1) {
      const wave = frames;
      frames = new Map();
      for (const cb of wave.values()) cb(0);
    }
  });
}

const nav: { go: ReturnType<typeof useNavigate> | null } = { go: null };
function CaptureNavigate() {
  const go = useNavigate();
  useEffect(() => {
    nav.go = go;
  }, [go]);
  return null;
}

describe('<ListScrollRestore> over a real feed list', () => {
  let restoreLayout: () => void;

  beforeEach(() => {
    installIntersectionObserverMock();
    restoreLayout = installRowLayout();
    scrollY = 0;
    frames = new Map();
    nextFrameId = 1;
    clearListScrollAnchors();
    window.localStorage.clear();
    // Auto-hide on, remove off — the reporter's settings.
    window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
    window.localStorage.setItem(HIDE_ON_SCROLL_REMOVE_KEY, '0');
    resetReadingPrefsCacheForTest();
    resetPromoDismissedCacheForTest();
    resetCollapsedFeedsCacheForTest();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, cb);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id);
    });
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      get: () => scrollY,
    });
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      writable: true,
      value: (_x: number, y: number) => {
        scrollY = y;
      },
    });
  });

  afterEach(() => {
    restoreLayout();
    uninstallIntersectionObserverMock();
    vi.unstubAllGlobals();
    clearListScrollAnchors();
  });

  /** Render a feed view at `/` with a stub reader route, flat or grouped by
   * feed — the two shapes the list renders in (grouped nests each feed's rows
   * in a section `<li>`, so this also covers rows that aren't siblings). */
  function renderFeed(source: MockDataSource, grouped: boolean) {
    return renderWithProviders(
      <>
        <ListScrollRestore />
        <CaptureNavigate />
        <Routes>
          <Route
            path="/"
            element={
              <ItemList
                viewKey={grouped ? 'home-grouped' : 'home-all'}
                fetchPage={(cursor) =>
                  source.getHomeItems({ cursor, groupByFeed: grouped, limit: 100 })
                }
                groupByFeed={grouped}
                perFeedLimit={grouped ? PER_FEED_WINDOW : undefined}
                emptyLabel="All caught up."
              />
            }
          />
          <Route path="/item/:id" element={<div>reader</div>} />
        </Routes>
      </>,
      { source },
    );
  }

  it('keeps the reader in front of the same article when the struck rows compact on Back', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderFeed(source, false);

    const rows = await screen.findAllByTestId('item-row');
    expect(rows.length).toBeGreaterThan(4);
    const lis = rows.map((row) => row.closest('li')!);
    const readingId = lis[3].dataset.itemId!;

    // Scroll past the first three articles: each is marked Done and held in
    // place, struck through, so the list itself doesn't move.
    act(() => {
      for (const li of lis.slice(0, 3)) setVisibilityForTest(li, 0);
    });
    await waitFor(() =>
      expect(source.stateStore.get(lis[0].dataset.itemId!).done).toBe(true),
    );
    // …with the fourth article now under the top of the viewport.
    act(() => {
      scrollY = 3 * ROW_HEIGHT;
      fireEvent.scroll(window);
    });
    flushFrames();
    expect(
      document.querySelector(`li[data-item-id="${readingId}"]`)!.getBoundingClientRect()
        .top,
    ).toBe(0);

    // Open it, then come back — which is where the struck rows compact away.
    act(() => {
      nav.go?.('/item/x');
    });
    await screen.findByText('reader');
    act(() => {
      nav.go?.(-1);
    });
    const back = await screen.findAllByTestId('item-row');
    expect(back.length).toBe(rows.length - 3); // the struck run is gone

    // Without the restore this is where the reader lands three articles down:
    // the offset is untouched while the rows above it went away.
    expect(scrollY).toBe(3 * ROW_HEIGHT);
    flushFrames();
    await waitFor(() => {
      const row = document.querySelector(`li[data-item-id="${readingId}"]`);
      expect(row?.getBoundingClientRect().top).toBe(0);
    });
  });

  it('holds the same way in the grouped view, where rows sit inside feed sections', async () => {
    // Grouped views nest each feed's rows in a section <li> with its own header,
    // so the rows aren't siblings and headers sit between them. The anchor walks
    // rows in document order regardless, and a whole section can go without
    // costing the reader their place.
    const source = new MockDataSource(`test-${Math.random()}`);
    renderFeed(source, true);

    const rows = await screen.findAllByTestId('item-row');
    expect(rows.length).toBeGreaterThan(4);
    const lis = rows.map((row) => row.closest('li')!);
    const readingId = lis[3].dataset.itemId!;

    act(() => {
      for (const li of lis.slice(0, 3)) setVisibilityForTest(li, 0);
    });
    await waitFor(() =>
      expect(source.stateStore.get(lis[0].dataset.itemId!).done).toBe(true),
    );
    act(() => {
      scrollY = 3 * ROW_HEIGHT;
      fireEvent.scroll(window);
    });
    flushFrames();

    act(() => {
      nav.go?.('/item/x');
    });
    await screen.findByText('reader');
    act(() => {
      nav.go?.(-1);
    });
    await screen.findAllByTestId('item-row');
    flushFrames();
    await waitFor(() => {
      const row = document.querySelector(`li[data-item-id="${readingId}"]`);
      expect(row?.getBoundingClientRect().top).toBe(0);
    });
  });
});
