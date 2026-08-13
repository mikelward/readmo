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
  SAVE_SERVICE_KEY,
  AUTO_SAVE_ON_FAVORITE_KEY,
  TITLE_FILTERS_KEY,
  useTitleFilters,
  resetReadingPrefsCacheForTest,
  useBottomBarPosition,
  useDebugScrollJumps,
  useGroupByFeed,
  useHideOnScroll,
  useHideSportsSpoilers,
  useEffectiveHideSpoilers,
  useItemSort,
  useListLayout,
  useShowRowFavicon,
  useSaveService,
  useAutoSaveOnFavorite,
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

  describe('effective spoiler-hiding (session override)', () => {
    function EffectiveSpoilerProbe() {
      const { hideSpoilers, toggle } = useEffectiveHideSpoilers();
      return (
        <button type="button" onClick={toggle}>
          {hideSpoilers ? 'hidden' : 'shown'}
        </button>
      );
    }

    it('follows the saved preference until overridden (default ON)', () => {
      render(<EffectiveSpoilerProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('hidden');
    });

    it('follows a persisted opted-out preference', () => {
      window.localStorage.setItem(HIDE_SPORTS_SPOILERS_KEY, '0');
      resetReadingPrefsCacheForTest();
      render(<EffectiveSpoilerProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('shown');
    });

    it('toggles the effective state for the session', () => {
      render(<EffectiveSpoilerProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('hidden');
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('shown');
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('hidden');
    });

    it('never writes the override to localStorage (resets on refresh)', () => {
      render(<EffectiveSpoilerProbe />);
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('shown');
      // The session override is in-memory only — the saved preference is
      // untouched, so a fresh load (simulated by dropping the memo) reverts.
      expect(window.localStorage.getItem(HIDE_SPORTS_SPOILERS_KEY)).toBeNull();
    });

    it('resetReadingPrefsCacheForTest clears the override', () => {
      render(<EffectiveSpoilerProbe />);
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('shown');
      resetReadingPrefsCacheForTest();
      // A remount (fresh session) after the reset follows the saved preference.
      render(<EffectiveSpoilerProbe />);
      expect(screen.getAllByRole('button')[1]).toHaveTextContent('hidden');
    });

    it('shares the override across separate consumers', () => {
      render(
        <>
          <EffectiveSpoilerProbe />
          <EffectiveSpoilerProbe />
        </>,
      );
      const [a, b] = screen.getAllByRole('button');
      expect(a).toHaveTextContent('hidden');
      expect(b).toHaveTextContent('hidden');
      // Toggling one flips both — the eye toggle is app-wide for the session.
      act(() => a.click());
      expect(a).toHaveTextContent('shown');
      expect(b).toHaveTextContent('shown');
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

  describe('save service', () => {
    function SaveServiceProbe() {
      const { saveService, setSaveService } = useSaveService();
      return (
        <button
          type="button"
          onClick={() =>
            setSaveService(saveService === null ? 'raindrop' : null)
          }
        >
          {saveService ?? 'none'}
        </button>
      );
    }

    it('defaults to None (null)', () => {
      render(<SaveServiceProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('none');
    });

    it('persists a chosen service and clears back to None', () => {
      render(<SaveServiceProbe />);
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('raindrop');
      expect(window.localStorage.getItem(SAVE_SERVICE_KEY)).toBe('raindrop');
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('none');
      expect(window.localStorage.getItem(SAVE_SERVICE_KEY)).toBe('');
    });

    it('reads None for an unknown persisted id', () => {
      window.localStorage.setItem(SAVE_SERVICE_KEY, 'pocket');
      resetReadingPrefsCacheForTest();
      render(<SaveServiceProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('none');
    });
  });

  describe('auto-save on favorite', () => {
    function AutoSaveProbe() {
      const { autoSaveOnFavorite, setAutoSaveOnFavorite } =
        useAutoSaveOnFavorite();
      return (
        <button
          type="button"
          onClick={() => setAutoSaveOnFavorite(!autoSaveOnFavorite)}
        >
          {autoSaveOnFavorite ? 'on' : 'off'}
        </button>
      );
    }

    it('defaults to off', () => {
      render(<AutoSaveProbe />);
      expect(screen.getByRole('button')).toHaveTextContent('off');
    });

    it('persists turning it on and back off', () => {
      render(<AutoSaveProbe />);
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('on');
      expect(window.localStorage.getItem(AUTO_SAVE_ON_FAVORITE_KEY)).toBe('1');
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('off');
      expect(window.localStorage.getItem(AUTO_SAVE_ON_FAVORITE_KEY)).toBe('0');
    });
  });
  describe('useTitleFilters', () => {
    // Migration 0073's SQL matcher splits each stored entry on ' ' and uses it
    // as a needle WITHOUT folding it — folding in SQL is precisely what that
    // migration removes. That is only sound because every entry is written
    // canonical, so the invariant is pinned here rather than left as a comment:
    // a non-canonical row would under-filter server-side (the badge over-counts
    // and the row spends a floor slot) while the client hid it correctly.
    function FilterProbe() {
      const { titleFilters, addTitleFilter } = useTitleFilters();
      return (
        <button type="button" onClick={() => addTitleFilter("  Peña's  TARIFFS!! ")}>
          {titleFilters.join('|') || 'none'}
        </button>
      );
    }

    it('stores entries already folded, tokenized and space-joined', () => {
      render(<FilterProbe />);
      act(() => screen.getByRole('button').click());
      expect(screen.getByRole('button')).toHaveTextContent('pena s tariffs');
      // What actually reaches the server — the value the SQL needle is built
      // from — not just what the hook reports back.
      expect(JSON.parse(window.localStorage.getItem(TITLE_FILTERS_KEY) ?? '[]')).toEqual([
        'pena s tariffs',
      ]);
    });
  });
});
