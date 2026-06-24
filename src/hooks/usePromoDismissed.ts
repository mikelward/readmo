import { useCallback, useSyncExternalStore } from 'react';

// Per-device dismissal flags for promotional / onboarding bars. Once a bar is
// dismissed it stays gone on that device (localStorage), surviving reloads.
// Mirrors useHomeFeed's external-store shape so every mounted copy of a bar —
// and other tabs — react to a dismissal immediately.

const KEY_PREFIX = 'readmo:promo-dismissed:';
const CHANGE_EVENT = 'readmo:promo-dismissed-changed';

function storageKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function read(id: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(storageKey(id)) === '1';
  } catch {
    return false;
  }
}

// One cached boolean per promo id so useSyncExternalStore's getSnapshot is
// referentially stable between renders (a primitive read straight from
// localStorage would be re-read fresh each time, but caching keeps the
// snapshot identity steady and lets us refresh it on cross-tab events).
const cache = new Map<string, boolean>();

function getCached(id: string): boolean {
  if (!cache.has(id)) cache.set(id, read(id));
  return cache.get(id) as boolean;
}

/** Tracks whether a one-off promo bar (`id`) has been dismissed on this device.
 * Returns the current flag plus a `dismiss` that hides it for good. */
export function usePromoDismissed(id: string): {
  dismissed: boolean;
  dismiss: () => void;
} {
  const subscribe = useCallback(
    (cb: () => void) => {
      const handler = () => {
        // Re-read on every signal so a same-tab dismiss and a cross-tab
        // `storage` event both refresh the cached snapshot before React reads it.
        cache.set(id, read(id));
        cb();
      };
      window.addEventListener(CHANGE_EVENT, handler);
      window.addEventListener('storage', handler);
      return () => {
        window.removeEventListener(CHANGE_EVENT, handler);
        window.removeEventListener('storage', handler);
      };
    },
    [id],
  );

  const getSnapshot = useCallback(() => getCached(id), [id]);

  const dismissed = useSyncExternalStore(subscribe, getSnapshot, () => false);

  const dismiss = useCallback(() => {
    cache.set(id, true);
    try {
      window.localStorage.setItem(storageKey(id), '1');
    } catch {
      // ignore storage failures — the bar just reappears next load
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, [id]);

  return { dismissed, dismiss };
}

/** Test-only: drop the in-memory dismissal cache so a test can start from a
 * clean slate. The cache is module-level and otherwise persists across a test
 * file's cases, which would let an earlier dismissal mask a later assertion.
 * Pair with `localStorage.clear()` to also reset the persisted flag. */
export function resetPromoDismissedCacheForTest(): void {
  cache.clear();
}
