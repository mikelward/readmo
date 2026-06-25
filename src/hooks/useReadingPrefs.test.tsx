import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import {
  BOTTOM_BAR_KEY,
  HIDE_ON_SCROLL_KEY,
  resetReadingPrefsCacheForTest,
  useBottomBarPosition,
  useHideOnScroll,
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
});
