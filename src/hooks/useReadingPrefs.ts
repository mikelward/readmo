import { useCallback } from 'react';
import type { ItemSort } from '../lib/data/DataSource';
import {
  createPersistentStore,
  type PersistentStore,
} from '../lib/persistentStore';
import { usePersistentStore } from './usePersistentStore';

// Per-device reading-behavior preferences, persisted in localStorage and shared
// across tabs and every mounted component via createPersistentStore.
//
//  - hide-on-scroll (default off): mark an unpinned row Done the moment it
//    scrolls off the top of the viewport — an automatic Sweep (see ItemList /
//    useInViewIds).
//  - bottom-bar (default 'list'): where the bottom action bar lives — at the
//    end of the list in normal flow ('list', newshacker's relative footer) or
//    pinned to the viewport foot ('screen'). See ListToolbar.css.
//  - item-sort (default 'newest'): chronological order of the feed body —
//    newest-first or oldest-first (see DataSource.ItemSort).
//  - group-by-feed (default off): section the body by feed instead of one flat
//    river (see ItemList / ItemRows).
//  - show-row-favicon (default off): show each feed's favicon on its rows in
//    the non-grouped views (flat river, library, search, offline). Group-by-feed
//    carries the icon on the section header regardless (see ItemRows / ItemRow).

export const HIDE_ON_SCROLL_KEY = 'readmo:hide-on-scroll';
export const BOTTOM_BAR_KEY = 'readmo:bottom-bar';
export const ITEM_SORT_KEY = 'readmo:item-sort';
export const GROUP_BY_FEED_KEY = 'readmo:group-by-feed';
export const SHOW_ROW_FAVICON_KEY = 'readmo:show-row-favicon';

/** Where the bottom action bar sits. 'list' = relative footer at the end of the
 * list (the default); 'screen' = pinned to the bottom of the viewport. */
export type BottomBarPosition = 'list' | 'screen';
const DEFAULT_BOTTOM_BAR: BottomBarPosition = 'list';

const DEFAULT_ITEM_SORT: ItemSort = 'newest';

const CHANGE_EVENT = 'readmo:reading-pref-changed';

// All four prefs share CHANGE_EVENT; each store re-reads its own key on the
// signal, so a change to one leaves the others' snapshots Object.is-stable.
function boolStore(storageKey: string): PersistentStore<boolean> {
  return createPersistentStore<boolean>({
    storageKey,
    changeEvent: CHANGE_EVENT,
    defaultValue: false,
    parse: (raw) => raw === '1',
    serialize: (value) => (value ? '1' : '0'),
  });
}

const hideOnScrollStore = boolStore(HIDE_ON_SCROLL_KEY);
const groupByFeedStore = boolStore(GROUP_BY_FEED_KEY);
const showRowFaviconStore = boolStore(SHOW_ROW_FAVICON_KEY);

const bottomBarStore = createPersistentStore<BottomBarPosition>({
  storageKey: BOTTOM_BAR_KEY,
  changeEvent: CHANGE_EVENT,
  defaultValue: DEFAULT_BOTTOM_BAR,
  parse: (raw) => (raw === 'screen' ? 'screen' : DEFAULT_BOTTOM_BAR),
});

const itemSortStore = createPersistentStore<ItemSort>({
  storageKey: ITEM_SORT_KEY,
  changeEvent: CHANGE_EVENT,
  defaultValue: DEFAULT_ITEM_SORT,
  parse: (raw) => (raw === 'oldest' ? 'oldest' : DEFAULT_ITEM_SORT),
});

/** Whether unpinned articles are auto-marked Done as they scroll off the top. */
export function useHideOnScroll(): {
  hideOnScroll: boolean;
  setHideOnScroll: (next: boolean) => void;
} {
  const hideOnScroll = usePersistentStore(hideOnScrollStore);
  const setHideOnScroll = useCallback(
    (next: boolean) => hideOnScrollStore.set(next),
    [],
  );
  return { hideOnScroll, setHideOnScroll };
}

/** Where the bottom action bar sits — end of the list ('list', default) or
 * pinned to the viewport foot ('screen'). */
export function useBottomBarPosition(): {
  bottomBarPosition: BottomBarPosition;
  setBottomBarPosition: (next: BottomBarPosition) => void;
} {
  const bottomBarPosition = usePersistentStore(bottomBarStore);
  const setBottomBarPosition = useCallback(
    (next: BottomBarPosition) => bottomBarStore.set(next),
    [],
  );
  return { bottomBarPosition, setBottomBarPosition };
}

/** Chronological order of the feed body — newest- or oldest-first. Pinned items
 * are unaffected (always oldest-pin first at the top). Per-device. */
export function useItemSort(): {
  itemSort: ItemSort;
  setItemSort: (next: ItemSort) => void;
} {
  const itemSort = usePersistentStore(itemSortStore);
  const setItemSort = useCallback(
    (next: ItemSort) => itemSortStore.set(next),
    [],
  );
  return { itemSort, setItemSort };
}

/** Whether the feed body is sectioned by feed (A→Z) instead of one flat
 * chronological river. Per-device. */
export function useGroupByFeed(): {
  groupByFeed: boolean;
  setGroupByFeed: (next: boolean) => void;
} {
  const groupByFeed = usePersistentStore(groupByFeedStore);
  const setGroupByFeed = useCallback(
    (next: boolean) => groupByFeedStore.set(next),
    [],
  );
  return { groupByFeed, setGroupByFeed };
}

/** Whether non-grouped views (flat river, library, search, offline) show each
 * feed's favicon on its rows. Off by default; group-by-feed carries the icon on
 * the section header regardless. Per-device. */
export function useShowRowFavicon(): {
  showRowFavicon: boolean;
  setShowRowFavicon: (next: boolean) => void;
} {
  const showRowFavicon = usePersistentStore(showRowFaviconStore);
  const setShowRowFavicon = useCallback(
    (next: boolean) => showRowFaviconStore.set(next),
    [],
  );
  return { showRowFavicon, setShowRowFavicon };
}

/** Test-only: drop the stores' parse memos so `localStorage.clear()` alone
 * resets state between cases. */
export function resetReadingPrefsCacheForTest(): void {
  hideOnScrollStore.resetForTest();
  groupByFeedStore.resetForTest();
  showRowFaviconStore.resetForTest();
  bottomBarStore.resetForTest();
  itemSortStore.resetForTest();
}
