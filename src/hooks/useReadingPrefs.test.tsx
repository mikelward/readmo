import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { DIRTY_SETTINGS_KEY } from '../lib/settingsSync';
import {
  BOTTOM_BAR_KEY,
  DEBUG_SCROLL_JUMPS_KEY,
  GROUP_BY_FEED_KEY,
  HIDE_ON_SCROLL_KEY,
  HIDE_SPORTS_SPOILERS_KEY,
  ITEM_SORT_KEY,
  LIST_LAYOUT_KEY,
  SHOW_ROW_FAVICON_KEY,
  resetReadingPrefsCacheForTest,
  useBottomBarPosition,
  useDebugScrollJumps,
  useGroupByFeed,
  useHideOnScroll,
  useHideSportsSpoilers,
  useItemSort,
  useListLayout,
  useShowRowFavicon,
} from './useReadingPrefs';

function HideOnScrollProbe() {
  const { hideOnScroll, setHideOnScroll } = useHideOnScroll();
  return (
    <button type="button" onClick={() => setHideOnScroll(!hideOnScroll)}>
      {hideOnScroll ? 'on' : 'off'}
    </button>
  );
}

describe('useReadingPrefs', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });

  it('defaults both prefs to off', () => {
    render(<HideOnScrollProbe />);
    expect(screen.getByRole('button')).toHaveTextContent('off');
  });

  it('reads an existing persisted flag on mount', () => {
    window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
    resetReadingPrefsCacheForTest();
    render(<HideOnScrollProbe />);
    expect(screen.getByRole('button')).toHaveTextContent('on');
  });

  it('persists a toggle to localStorage', () => {
    render(<HideOnScrollProbe />);
    act(() => {
      screen.getByRole('button').click();
    });
    expect(screen.getByRole('button')).toHaveTextContent('on');
    expect(window.localStorage.getItem(HIDE_ON_SCROLL_KEY)).toBe('1');
  });

  it('stamps the synced-settings dirty marker on a user toggle', () => {
    // The marker is what tells the sync engine "this is a user action" — a
    // flip that lands back on the last-pushed value must still push and must
    // not be overwritten by a fetched cross-device value (lib/settingsSync).
    render(<HideOnScrollProbe />);
    act(() => {
      screen.getByRole('button').click();
    });
    expect(window.localStorage.getItem(DIRTY_SETTINGS_KEY)).toBe(
      '["hideOnScroll"]',
    );
  });

  it('notifies every mounted consumer of a change (cross-component reactivity)', () => {
    render(
      <>
        <HideOnScrollProbe />
        <HideOnScrollProbe />
      </>,
    );
    const [a, b] = screen.getAllByRole('button');
    act(() => {
      a.click();
    });
    // Toggling one instance updates the other — they share the external store.
    expect(a).toHaveTextContent('on');
    expect(b).toHaveTextContent('on');
  });

  it('keeps the two prefs independent', () => {
    function BothProbe() {
      const { bottomBarPosition, setBottomBarPosition } = useBottomBarPosition();
      const { hideOnScroll } = useHideOnScroll();
      return (
        <button type="button" onClick={() => setBottomBarPosition('screen')}>
          {`hide:${hideOnScroll ? 1 : 0} bar:${bottomBarPosition}`}
        </button>
      );
    }
    render(<BothProbe />);
    act(() => {
      screen.getByRole('button').click();
    });
    expect(screen.getByRole('button')).toHaveTextContent('hide:0 bar:screen');
    expect(window.localStorage.getItem(BOTTOM_BAR_KEY)).toBe('screen');
    expect(window.localStorage.getItem(HIDE_ON_SCROLL_KEY)).toBeNull();
  });

  describe('scroll-jump diagnostics', () => {
    function DebugProbe() {
      const { debugScrollJumps, setDebugScrollJumps } = useDebugScrollJumps();
      return (
        <button
          type="button"
          onClick={() => setDebugScrollJumps(!debugScrollJumps)}
        >
          {debugScrollJumps ? 'on' : 'off'}
        </button>
      );
    }

    it('defaults to off', () => {
      render(<DebugProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('off');
    });

    it('persists a toggle to localStorage', () => {
      render(<DebugProbe />);
      act(() => {
        screen.getByRole('button').click();
      });
      expect(screen.getByRole('button')).toHaveTextContent('on');
      expect(window.localStorage.getItem(DEBUG_SCROLL_JUMPS_KEY)).toBe('1');
    });
  });

  describe('item sort order', () => {
    function SortProbe() {
      const { itemSort, setItemSort } = useItemSort();
      return (
        <button
          type="button"
          onClick={() => setItemSort(itemSort === 'newest' ? 'oldest' : 'newest')}
        >
          {itemSort}
        </button>
      );
    }

    it("defaults to 'newest'", () => {
      render(<SortProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('newest');
    });

    it("reads a persisted 'oldest' choice on mount", () => {
      window.localStorage.setItem(ITEM_SORT_KEY, 'oldest');
      render(<SortProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('oldest');
    });

    it('persists a change and reverts to the default', () => {
      render(<SortProbe />);
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('oldest');
      expect(window.localStorage.getItem(ITEM_SORT_KEY)).toBe('oldest');
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('newest');
      expect(window.localStorage.getItem(ITEM_SORT_KEY)).toBe('newest');
    });
  });

  describe('group by feed', () => {
    function GroupProbe() {
      const { groupByFeed, setGroupByFeed } = useGroupByFeed();
      return (
        <button type="button" onClick={() => setGroupByFeed(!groupByFeed)}>
          {groupByFeed ? 'grouped' : 'flat'}
        </button>
      );
    }

    it('defaults to off (flat)', () => {
      render(<GroupProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('flat');
    });

    it('persists a toggle to localStorage', () => {
      render(<GroupProbe />);
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('grouped');
      expect(window.localStorage.getItem(GROUP_BY_FEED_KEY)).toBe('1');
    });
  });

  describe('show row favicon', () => {
    function FaviconProbe() {
      const { showRowFavicon, setShowRowFavicon } = useShowRowFavicon();
      return (
        <button type="button" onClick={() => setShowRowFavicon(!showRowFavicon)}>
          {showRowFavicon ? 'on' : 'off'}
        </button>
      );
    }

    it('defaults to off', () => {
      render(<FaviconProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('off');
    });

    it('reads a persisted flag on mount', () => {
      window.localStorage.setItem(SHOW_ROW_FAVICON_KEY, '1');
      resetReadingPrefsCacheForTest();
      render(<FaviconProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('on');
    });

    it('persists a toggle to localStorage', () => {
      render(<FaviconProbe />);
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('on');
      expect(window.localStorage.getItem(SHOW_ROW_FAVICON_KEY)).toBe('1');
    });
  });

  describe('hide sports spoilers', () => {
    function SpoilerProbe() {
      const { hideSportsSpoilers, setHideSportsSpoilers } = useHideSportsSpoilers();
      return (
        <button
          type="button"
          onClick={() => setHideSportsSpoilers(!hideSportsSpoilers)}
        >
          {hideSportsSpoilers ? 'on' : 'off'}
        </button>
      );
    }

    it('defaults to ON (opt-out, unlike the other flags)', () => {
      render(<SpoilerProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('on');
    });

    it("reads a persisted '0' (opted out) on mount", () => {
      window.localStorage.setItem(HIDE_SPORTS_SPOILERS_KEY, '0');
      resetReadingPrefsCacheForTest();
      render(<SpoilerProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('off');
    });

    it('persists turning it off and back on', () => {
      render(<SpoilerProbe />);
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('off');
      expect(window.localStorage.getItem(HIDE_SPORTS_SPOILERS_KEY)).toBe('0');
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('on');
      expect(window.localStorage.getItem(HIDE_SPORTS_SPOILERS_KEY)).toBe('1');
    });
  });

  describe('bottom bar position', () => {
    function BottomBarProbe() {
      const { bottomBarPosition, setBottomBarPosition } = useBottomBarPosition();
      return (
        <button
          type="button"
          onClick={() =>
            setBottomBarPosition(
              bottomBarPosition === 'list' ? 'screen' : 'list',
            )
          }
        >
          {bottomBarPosition}
        </button>
      );
    }

    it("defaults to 'list' (relative footer)", () => {
      render(<BottomBarProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('list');
    });

    it("reads a persisted 'screen' choice on mount", () => {
      window.localStorage.setItem(BOTTOM_BAR_KEY, 'screen');
      resetReadingPrefsCacheForTest();
      render(<BottomBarProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('screen');
    });

    it('persists a change and reverts to the default', () => {
      render(<BottomBarProbe />);
      act(() => {
        screen.getByRole('button').click();
      });
      expect(screen.getByRole('button')).toHaveTextContent('screen');
      expect(window.localStorage.getItem(BOTTOM_BAR_KEY)).toBe('screen');
      act(() => {
        screen.getByRole('button').click();
      });
      expect(screen.getByRole('button')).toHaveTextContent('list');
      expect(window.localStorage.getItem(BOTTOM_BAR_KEY)).toBe('list');
    });
  });

  describe('article layout', () => {
    const order: Record<string, string> = {
      title: 'thumbnail-small',
      'thumbnail-small': 'thumbnail',
      thumbnail: 'excerpt',
      excerpt: 'title',
    };
    function LayoutProbe() {
      const { listLayout, setListLayout } = useListLayout();
      return (
        <button
          type="button"
          onClick={() => setListLayout(order[listLayout] as 'title')}
        >
          {listLayout}
        </button>
      );
    }

    it("defaults to 'thumbnail-small' (the compact row + a small thumbnail)", () => {
      render(<LayoutProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('thumbnail-small');
    });

    it("reads a persisted 'thumbnail' choice on mount", () => {
      window.localStorage.setItem(LIST_LAYOUT_KEY, 'thumbnail');
      resetReadingPrefsCacheForTest();
      render(<LayoutProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('thumbnail');
    });

    it("falls back to the default for an unknown persisted value", () => {
      window.localStorage.setItem(LIST_LAYOUT_KEY, 'bogus');
      resetReadingPrefsCacheForTest();
      render(<LayoutProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('thumbnail-small');
    });

    it("reads a persisted 'thumbnail-small' choice on mount", () => {
      window.localStorage.setItem(LIST_LAYOUT_KEY, 'thumbnail-small');
      resetReadingPrefsCacheForTest();
      render(<LayoutProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('thumbnail-small');
    });

    it('persists a change through all four values', () => {
      // Start from 'title' explicitly so the cycle covers every value regardless
      // of which one is the default.
      window.localStorage.setItem(LIST_LAYOUT_KEY, 'title');
      resetReadingPrefsCacheForTest();
      render(<LayoutProbe />);
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('thumbnail-small');
      expect(window.localStorage.getItem(LIST_LAYOUT_KEY)).toBe('thumbnail-small');
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('thumbnail');
      expect(window.localStorage.getItem(LIST_LAYOUT_KEY)).toBe('thumbnail');
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('excerpt');
      expect(window.localStorage.getItem(LIST_LAYOUT_KEY)).toBe('excerpt');
    });
  });
});
