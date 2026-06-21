import { useCallback, useSyncExternalStore } from 'react';

// Per-device preference for what `/` renders: the aggregate Unread river
// across all subscriptions ('all'), or a chosen folder. Mirrors newshacker's
// useHomeFeed (the drawer Home picker swaps `/` without changing the URL).

const STORAGE_KEY = 'readmo:home-feed';
const CHANGE_EVENT = 'readmo:home-feed-changed';

export type HomeFeed = { kind: 'all' } | { kind: 'folder'; name: string };

function read(): HomeFeed {
  if (typeof window === 'undefined') return { kind: 'all' };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { kind: 'all' };
    const parsed = JSON.parse(raw) as HomeFeed;
    if (parsed?.kind === 'folder' && typeof parsed.name === 'string') {
      return parsed;
    }
    return { kind: 'all' };
  } catch {
    return { kind: 'all' };
  }
}

let cached: HomeFeed = read();

function subscribe(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}

function getSnapshot(): HomeFeed {
  return cached;
}

export function useHomeFeed(): {
  homeFeed: HomeFeed;
  setHomeFeed: (next: HomeFeed) => void;
} {
  const homeFeed = useSyncExternalStore(subscribe, getSnapshot, () => cached);

  const setHomeFeed = useCallback((next: HomeFeed) => {
    cached = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage failures
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { homeFeed, setHomeFeed };
}
