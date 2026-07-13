import { useCallback } from 'react';
import type { ItemSort } from '../lib/data/DataSource';
import type { ListLayout } from '../lib/types';
import {
  createPersistentStore,
  type PersistentStore,
} from '../lib/persistentStore';
import {
  markSettingDirty,
  READING_PREF_CHANGE_EVENT,
  SYNCED_SETTINGS,
  ITEM_SORT_KEY,
  GROUP_BY_FEED_KEY,
  HIDE_ON_SCROLL_KEY,
  SHOW_ROW_FAVICON_KEY,
  SHOW_GROUP_FAVICON_KEY,
  HIDE_SPORTS_SPOILERS_KEY,
  AUTO_SUMMARIZE_PINNED_KEY,
  type SyncedSettingKey,
} from '../lib/settingsSync';
import { usePersistentStore } from './usePersistentStore';

// Re-exported so existing callers can keep importing `ListLayout` from here; the
// canonical definition now lives in lib/types (it's also a Subscription field —
// the per-feed override).
export type { ListLayout };

// Reading-behavior preferences, persisted in localStorage and shared across
// tabs and every mounted component via createPersistentStore.
//
// Most of these are PER-ACCOUNT and sync across devices (SPEC.md *Settings* →
// scope): localStorage stays what the UI reads synchronously (the prefs shape
// the first paint), and useSettingsSync reconciles it with the `user_settings`
// row server-side. Their storage keys and encodings live in lib/settingsSync —
// one source of truth for the stores here, the sync engine, and the purge list
// (userCache clears them on sign-out/account switch, guardrail #8). The
// device-ergonomic prefs — bottom-bar position, the app-wide list-layout
// default, and the debug toggle — stay per-device and are declared below.
//
//  - hide-on-scroll (default off, synced): mark an unpinned row Done the moment
//    it scrolls off the top of the viewport — an automatic Sweep (see ItemList /
//    useInViewIds).
//  - bottom-bar (default 'list', per-device): where the bottom action bar
//    lives — at the end of the list in normal flow ('list', newshacker's
//    relative footer) or pinned to the viewport foot ('screen'). Kept
//    per-device: it's about where your thumb reaches on THIS screen. See
//    ListToolbar.css.
//  - item-sort (default 'newest', synced): chronological order of the feed
//    body — newest-first or oldest-first (see DataSource.ItemSort).
//  - group-by-feed (default off, synced): section the body by feed instead of
//    one flat river (see ItemList / ItemRows).
//  - show-row-favicon (default off, synced): show each feed's favicon on its
//    rows in the non-grouped views (flat river, library, search, offline). See
//    ItemRows / ItemRow.
//  - show-group-favicon (default ON, synced): show each feed's favicon on its
//    section header in the group-by-feed views. On by default so the grouped
//    layout keeps the icons it has always carried (see ItemRows).
//  - hide-sports-spoilers (default ON, synced): show the server-generated
//    spoiler-free rewrite of a sports-result headline instead of the original
//    (see lib/spoilerHeadline). Only takes effect for allowlisted callers — the
//    display is gated on the allowlist capability too — so it's a no-op for
//    everyone else regardless of this switch.
//  - auto-summarize-pinned (default ON, synced): pre-warm the AI summary for
//    pinned articles so it's ready before the reader opens them (see
//    useSummaryPrewarm). A family-only control (the toggle is offered only to
//    family users in Settings); off-list users never fire the Edge call anyway.
//  - list-layout (default 'thumbnail-small', per-device): how much of each
//    article a feed row shows — the compact title-only row ('title'), the
//    compact row plus a small right thumbnail ('thumbnail-small', the default),
//    a larger title with a large right thumbnail ('thumbnail'), or a larger
//    title with a preview excerpt ('excerpt'). Kept per-device: row density is
//    a screen-size call (the synced per-feed override is on the subscription).
//    See ItemRow / lib/itemPreview.

// Synced-pref keys re-exported under their historical names.
export {
  ITEM_SORT_KEY,
  GROUP_BY_FEED_KEY,
  HIDE_ON_SCROLL_KEY,
  SHOW_ROW_FAVICON_KEY,
  SHOW_GROUP_FAVICON_KEY,
  HIDE_SPORTS_SPOILERS_KEY,
  AUTO_SUMMARIZE_PINNED_KEY,
};
export const BOTTOM_BAR_KEY = 'readmo:bottom-bar';
export const LIST_LAYOUT_KEY = 'readmo:list-layout';
export const DEBUG_SCROLL_JUMPS_KEY = 'readmo:debug-scroll-jumps';

/** Where the bottom action bar sits. 'list' = relative footer at the end of the
 * list (the default); 'screen' = pinned to the bottom of the viewport. */
export type BottomBarPosition = 'list' | 'screen';
const DEFAULT_BOTTOM_BAR: BottomBarPosition = 'list';

const DEFAULT_ITEM_SORT: ItemSort = 'newest';

/** The app-wide default {@link ListLayout} — used for any feed without a per-feed
 * override (Subscription.listLayout === null). */
const DEFAULT_LIST_LAYOUT: ListLayout = 'thumbnail-small';

// All prefs share READING_PREF_CHANGE_EVENT; each store re-reads its own key on
// the signal, so a change to one leaves the others' snapshots Object.is-stable.
// (useSettingsSync also listens on it: a set here schedules a server push, and
// a server value the engine applies re-enters the stores through it.)
const CHANGE_EVENT = READING_PREF_CHANGE_EVENT;

// A synced pref's store carries the user's action to the sync engine: set()
// stamps the pref's DIRTY marker before the underlying write dispatches the
// change event, so the push that event schedules already sees it. The marker
// is what lets a flip that lands back on the last-pushed value still count as
// the newest action (value comparison alone can't see it — lib/settingsSync).
// The engine's own hydration writes bypass set() (they write localStorage
// directly), so applied server values never mark themselves dirty.
function markDirtyOnSet<T>(
  key: SyncedSettingKey,
  store: PersistentStore<T>,
): PersistentStore<T> {
  return {
    ...store,
    set: (value: T) => {
      markSettingDirty(key);
      store.set(value);
    },
  };
}

// A synced boolean pref's store — storage key + encoding come from the shared
// lib/settingsSync spec so the store and the sync engine can never disagree.
// Only the default differs per pref: default-ON is used where a fresh install
// should opt IN (spoiler-hiding; group-header favicons, which the grouped
// layout has always shown; the pinned-summary pre-warm).
function syncedBoolStore(
  key: SyncedSettingKey,
  defaultValue: boolean,
): PersistentStore<boolean> {
  const spec = SYNCED_SETTINGS[key];
  return markDirtyOnSet(
    key,
    createPersistentStore<boolean>({
      storageKey: spec.storageKey,
      changeEvent: CHANGE_EVENT,
      defaultValue,
      parse: spec.parse as (raw: string) => boolean | undefined,
      serialize: spec.serialize as (value: boolean) => string,
    }),
  );
}

const hideOnScrollStore = syncedBoolStore('hideOnScroll', false);
const groupByFeedStore = syncedBoolStore('groupByFeed', false);
const showRowFaviconStore = syncedBoolStore('showRowFavicon', false);
const hideSportsSpoilersStore = syncedBoolStore('hideSportsSpoilers', true);
const showGroupFaviconStore = syncedBoolStore('showGroupFavicon', true);
const autoSummarizePinnedStore = syncedBoolStore('autoSummarizePinned', true);

// Device-local (unsynced) prefs.
const debugScrollJumpsStore = createPersistentStore<boolean>({
  storageKey: DEBUG_SCROLL_JUMPS_KEY,
  changeEvent: CHANGE_EVENT,
  defaultValue: false,
  parse: (raw) => raw === '1',
  serialize: (value) => (value ? '1' : '0'),
});

const bottomBarStore = createPersistentStore<BottomBarPosition>({
  storageKey: BOTTOM_BAR_KEY,
  changeEvent: CHANGE_EVENT,
  defaultValue: DEFAULT_BOTTOM_BAR,
  parse: (raw) => (raw === 'screen' ? 'screen' : DEFAULT_BOTTOM_BAR),
});

const itemSortStore = markDirtyOnSet(
  'itemSort',
  createPersistentStore<ItemSort>({
    storageKey: SYNCED_SETTINGS.itemSort.storageKey,
    changeEvent: CHANGE_EVENT,
    defaultValue: DEFAULT_ITEM_SORT,
    parse: SYNCED_SETTINGS.itemSort.parse,
    serialize: SYNCED_SETTINGS.itemSort.serialize,
  }),
);

const listLayoutStore = createPersistentStore<ListLayout>({
  storageKey: LIST_LAYOUT_KEY,
  changeEvent: CHANGE_EVENT,
  defaultValue: DEFAULT_LIST_LAYOUT,
  parse: (raw) =>
    raw === 'title' ||
    raw === 'thumbnail-small' ||
    raw === 'thumbnail' ||
    raw === 'excerpt'
      ? raw
      : DEFAULT_LIST_LAYOUT,
});

/** Whether unpinned articles are auto-marked Done as they scroll off the top.
 * Per-account, synced. */
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
 * pinned to the viewport foot ('screen'). Per-device. */
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
 * are unaffected (always oldest-pin first at the top). Per-account, synced. */
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
 * chronological river. Per-account, synced. */
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
 * feed's favicon on its article rows. Off by default. Per-account, synced. */
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

/** Whether the group-by-feed views show each feed's favicon on its section
 * header. On by default — the grouped layout has always carried the icon.
 * Per-account, synced. */
export function useShowGroupFavicon(): {
  showGroupFavicon: boolean;
  setShowGroupFavicon: (next: boolean) => void;
} {
  const showGroupFavicon = usePersistentStore(showGroupFaviconStore);
  const setShowGroupFavicon = useCallback(
    (next: boolean) => showGroupFaviconStore.set(next),
    [],
  );
  return { showGroupFavicon, setShowGroupFavicon };
}

/** Whether sports-result headlines are shown in their spoiler-free rewritten
 * form (default ON). Only takes effect for allowlisted callers — the display is
 * gated on the allowlist capability too (see lib/spoilerHeadline / ItemRow), so
 * flipping this does nothing for an off-list user. Per-account, synced. */
export function useHideSportsSpoilers(): {
  hideSportsSpoilers: boolean;
  setHideSportsSpoilers: (next: boolean) => void;
} {
  const hideSportsSpoilers = usePersistentStore(hideSportsSpoilersStore);
  const setHideSportsSpoilers = useCallback(
    (next: boolean) => hideSportsSpoilersStore.set(next),
    [],
  );
  return { hideSportsSpoilers, setHideSportsSpoilers };
}

/** Whether the AI summary for pinned articles is pre-warmed so it's ready
 * before the reader opens them (default ON). A family-only control — the toggle
 * is offered only to family users in Settings — but off-list callers never fire
 * the Edge call regardless (see useSummaryPrewarm). Per-account, synced. */
export function useAutoSummarizePinned(): {
  autoSummarizePinned: boolean;
  setAutoSummarizePinned: (next: boolean) => void;
} {
  const autoSummarizePinned = usePersistentStore(autoSummarizePinnedStore);
  const setAutoSummarizePinned = useCallback(
    (next: boolean) => autoSummarizePinnedStore.set(next),
    [],
  );
  return { autoSummarizePinned, setAutoSummarizePinned };
}

/** Chronological order aside, how much of each article a feed row shows —
 * title-only ('title'), compact + small right thumbnail ('thumbnail-small', the
 * default), larger title + large right thumbnail ('thumbnail'), or title +
 * preview excerpt ('excerpt'). Per-device. See ItemRow. */
export function useListLayout(): {
  listLayout: ListLayout;
  setListLayout: (next: ListLayout) => void;
} {
  const listLayout = usePersistentStore(listLayoutStore);
  const setListLayout = useCallback(
    (next: ListLayout) => listLayoutStore.set(next),
    [],
  );
  return { listLayout, setListLayout };
}

/** Whether scroll-jump diagnostics are on (default off). When on, useScrollDiag
 * records window scroll positions and Done flips into an in-memory timeline and
 * surfaces a "Done — Report bug" toast on each dismiss, so a jump-to-top can be
 * inspected at /debug/scroll on a device with no console. Per-device. */
export function useDebugScrollJumps(): {
  debugScrollJumps: boolean;
  setDebugScrollJumps: (next: boolean) => void;
} {
  const debugScrollJumps = usePersistentStore(debugScrollJumpsStore);
  const setDebugScrollJumps = useCallback(
    (next: boolean) => debugScrollJumpsStore.set(next),
    [],
  );
  return { debugScrollJumps, setDebugScrollJumps };
}

/** Test-only: drop the stores' parse memos so `localStorage.clear()` alone
 * resets state between cases. */
export function resetReadingPrefsCacheForTest(): void {
  hideOnScrollStore.resetForTest();
  debugScrollJumpsStore.resetForTest();
  groupByFeedStore.resetForTest();
  showRowFaviconStore.resetForTest();
  showGroupFaviconStore.resetForTest();
  hideSportsSpoilersStore.resetForTest();
  autoSummarizePinnedStore.resetForTest();
  bottomBarStore.resetForTest();
  itemSortStore.resetForTest();
  listLayoutStore.resetForTest();
}
