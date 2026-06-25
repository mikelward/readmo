import { useCallback, useSyncExternalStore } from 'react';

// Per-device reading-behavior preferences, persisted in localStorage and shared
// across tabs and every mounted component via an external store (same shape as
// usePromoDismissed).
//
//  - hide-on-scroll (default off): mark an unpinned row Done the moment it
//    scrolls off the top of the viewport — an automatic Sweep (see ItemList /
//    useInViewIds).
//  - bottom-bar (default 'list'): where the bottom action bar lives — at the
//    end of the list in normal flow ('list', newshacker's relative footer) or
//    pinned to the viewport foot ('screen'). See ListToolbar.css.

export const HIDE_ON_SCROLL_KEY = 'readmo:hide-on-scroll';
export const BOTTOM_BAR_KEY = 'readmo:bottom-bar';

/** Where the bottom action bar sits. 'list' = relative footer at the end of the
 * list (the default); 'screen' = pinned to the bottom of the viewport. */
export type BottomBarPosition = 'list' | 'screen';
const DEFAULT_BOTTOM_BAR: BottomBarPosition = 'list';

const CHANGE_EVENT = 'readmo:reading-pref-changed';

function readBool(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // ignore storage failures — the toggle just reverts next load
  }
}

function readBottomBar(): BottomBarPosition {
  if (typeof window === 'undefined') return DEFAULT_BOTTOM_BAR;
  try {
    return window.localStorage.getItem(BOTTOM_BAR_KEY) === 'screen'
      ? 'screen'
      : DEFAULT_BOTTOM_BAR;
  } catch {
    return DEFAULT_BOTTOM_BAR;
  }
}

function writeBottomBar(value: BottomBarPosition): void {
  try {
    window.localStorage.setItem(BOTTOM_BAR_KEY, value);
  } catch {
    // ignore storage failures
  }
}

/** Builds a hook backed by an external store over localStorage. `read`/`write`
 * are stable module-level closures. getSnapshot reads localStorage directly on
 * every call (the stored values are primitives, so the snapshot stays
 * Object.is-stable when nothing changed) — this is deliberately cache-free so a
 * cross-tab write that lands while every consumer is unmounted is still seen on
 * the next mount, instead of being masked by a stale module-level cache. */
function makePrefHook<T>(
  read: () => T,
  write: (value: T) => void,
): () => [T, (next: T) => void] {
  return function usePref(): [T, (next: T) => void] {
    const subscribe = useCallback((cb: () => void) => {
      window.addEventListener(CHANGE_EVENT, cb);
      window.addEventListener('storage', cb);
      return () => {
        window.removeEventListener(CHANGE_EVENT, cb);
        window.removeEventListener('storage', cb);
      };
    }, []);

    const value = useSyncExternalStore(subscribe, read, read);

    const setValue = useCallback((next: T) => {
      write(next);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    }, []);

    return [value, setValue];
  };
}

const useHideOnScrollPref = makePrefHook(
  () => readBool(HIDE_ON_SCROLL_KEY),
  (value) => writeBool(HIDE_ON_SCROLL_KEY, value),
);

const useBottomBarPref = makePrefHook(readBottomBar, writeBottomBar);

/** Whether unpinned articles are auto-marked Done as they scroll off the top. */
export function useHideOnScroll(): {
  hideOnScroll: boolean;
  setHideOnScroll: (next: boolean) => void;
} {
  const [hideOnScroll, setHideOnScroll] = useHideOnScrollPref();
  return { hideOnScroll, setHideOnScroll };
}

/** Where the bottom action bar sits — end of the list ('list', default) or
 * pinned to the viewport foot ('screen'). */
export function useBottomBarPosition(): {
  bottomBarPosition: BottomBarPosition;
  setBottomBarPosition: (next: BottomBarPosition) => void;
} {
  const [bottomBarPosition, setBottomBarPosition] = useBottomBarPref();
  return { bottomBarPosition, setBottomBarPosition };
}

/** Test-only no-op kept for call-site compatibility. The hook reads localStorage
 * directly (no module cache), so `localStorage.clear()` alone resets state. */
export function resetReadingPrefsCacheForTest(): void {
  // intentionally empty — there is no cache to clear
}
