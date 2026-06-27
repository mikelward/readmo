import { useCallback } from 'react';
import { createPersistentStore } from '../lib/persistentStore';
import { usePersistentStore } from './usePersistentStore';

// Per-device preference for what `/` renders: the aggregate Unread river
// across all subscriptions ('all'), or a chosen folder. Mirrors newshacker's
// useHomeFeed (the drawer Home picker swaps `/` without changing the URL).

const STORAGE_KEY = 'readmo:home-feed';
const CHANGE_EVENT = 'readmo:home-feed-changed';

export type HomeFeed = { kind: 'all' } | { kind: 'folder'; name: string };

const DEFAULT_HOME_FEED: HomeFeed = { kind: 'all' };

const homeFeedStore = createPersistentStore<HomeFeed>({
  storageKey: STORAGE_KEY,
  changeEvent: CHANGE_EVENT,
  defaultValue: DEFAULT_HOME_FEED,
  parse: (raw) => {
    try {
      const parsed = JSON.parse(raw) as HomeFeed;
      if (parsed?.kind === 'folder' && typeof parsed.name === 'string') {
        return parsed;
      }
      if (parsed?.kind === 'all') return DEFAULT_HOME_FEED;
      return undefined;
    } catch {
      return undefined;
    }
  },
  serialize: (value) => JSON.stringify(value),
});

export function useHomeFeed(): {
  homeFeed: HomeFeed;
  setHomeFeed: (next: HomeFeed) => void;
} {
  const homeFeed = usePersistentStore(homeFeedStore);
  const setHomeFeed = useCallback(
    (next: HomeFeed) => homeFeedStore.set(next),
    [],
  );
  return { homeFeed, setHomeFeed };
}
