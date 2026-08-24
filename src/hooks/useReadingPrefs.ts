import { useCallback, useSyncExternalStore } from 'react';
import type { ItemSort } from '../lib/data/DataSource';
import {
  ARTICLES_PER_PAGE_OPTIONS,
  ARTICLES_PER_SECTION_OPTIONS,
  DEFAULT_ARTICLES_PER_PAGE,
  DEFAULT_ARTICLES_PER_SECTION,
  type ArticleLoadCount,
  type ListLayout,
} from '../lib/types';
import { isReadLaterService, type ReadLaterService } from '../lib/readLater';
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
  HIDE_ON_SCROLL_REMOVE_KEY,
  SHOW_ROW_FAVICON_KEY,
  SHOW_GROUP_FAVICON_KEY,
  HIDE_SPORTS_SPOILERS_KEY,
  AUTO_SUMMARIZE_PINNED_KEY,
  TITLE_FILTERS_KEY,
  type SyncedSettingKey,
} from '../lib/settingsSync';
import { normalizeFilter } from '../lib/titleFilter';
import { usePersistentStore } from './usePersistentStore';

// Re-exported so existing callers can keep importing `ListLayout` from here; the
// canonical definition now lives in lib/types (it's also a Subscription field —
// the per-feed override).
export type { ListLayout, ArticleLoadCount };

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
// default, articles-per-page, and the debug toggle — stay per-device and are
// declared below.
//
//  - hide-on-scroll (default off, synced): mark an unpinned row Done the moment
//    it scrolls off the top of the viewport — an automatic Sweep (see ItemList /
//    useInViewIds).
//  - hide-on-scroll-remove (default ON, synced): what auto-hide does with a
//    row it marked — remove it (collapsing the list up) or leave it in place
//    struck through until the list re-materializes. Only read while
//    hide-on-scroll is on.
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
//  - articles-per-page (default 30, per-device): the FLAT river's page size —
//    the `limit` on each read, so what a fresh load lands and what each "More"
//    appends. Every step of it is a request.
//  - articles-per-section (default 10, per-device): the group-by-feed DISPLAY
//    window — how many body rows each feed's section opens with and each
//    section "More" reveals, out of rows the one deep read already fetched, so
//    it costs no request at any size. A separate number from the page size
//    above for that reason (see lib/types): a section is a slice of the
//    screen, not the whole of it.
//    Both kept per-device for the same reason as row density: how much list
//    you want to land at once is a call about this screen and this connection.

// Synced-pref keys re-exported under their historical names.
export {
  ITEM_SORT_KEY,
  GROUP_BY_FEED_KEY,
  HIDE_ON_SCROLL_KEY,
  HIDE_ON_SCROLL_REMOVE_KEY,
  SHOW_ROW_FAVICON_KEY,
  SHOW_GROUP_FAVICON_KEY,
  HIDE_SPORTS_SPOILERS_KEY,
  AUTO_SUMMARIZE_PINNED_KEY,
  TITLE_FILTERS_KEY,
};
export const BOTTOM_BAR_KEY = 'readmo:bottom-bar';
export const LIST_LAYOUT_KEY = 'readmo:list-layout';
export const DEBUG_SCROLL_JUMPS_KEY = 'readmo:debug-scroll-jumps';
export const ARTICLES_PER_PAGE_KEY = 'readmo:articles-per-page';
export const ARTICLES_PER_SECTION_KEY = 'readmo:articles-per-section';
export const SAVE_SERVICE_KEY = 'readmo:save-service';
export const AUTO_SAVE_ON_FAVORITE_KEY = 'readmo:auto-save-on-favorite';

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
// Default ON: removing the row is what auto-hide did before this sub-setting
// existed, so an upgrading reader sees no change until they opt out.
//
// TODO: flip this default to OFF (strike in place) once we've read with it off
// for a while. Off is the calmer behavior — nothing moves under you mid-scroll,
// and you can see (and individually rescue) what you scrolled past — and it
// sidesteps the scroll-pin machinery in ItemList entirely. Kept ON here only
// because it's the behavior that shipped; changing it is a visible change for
// everyone already using auto-hide, so it wants a deliberate flip, not a
// default chosen at implementation time.
const hideOnScrollRemoveStore = syncedBoolStore('hideOnScrollRemove', true);
const groupByFeedStore = syncedBoolStore('groupByFeed', false);
const showRowFaviconStore = syncedBoolStore('showRowFavicon', false);
const hideSportsSpoilersStore = syncedBoolStore('hideSportsSpoilers', true);
const showGroupFaviconStore = syncedBoolStore('showGroupFavicon', true);
const autoSummarizePinnedStore = syncedBoolStore('autoSummarizePinned', true);

/** The reader's filtered words (SPEC.md *Filtered words*), normalized. The one
 * non-scalar synced pref; createPersistentStore memoizes the parsed array by
 * its raw string, so the snapshot stays Object.is-stable for useSyncExternalStore. */
const titleFiltersStore = markDirtyOnSet(
  'titleFilters',
  createPersistentStore<string[]>({
    storageKey: SYNCED_SETTINGS.titleFilters.storageKey,
    changeEvent: CHANGE_EVENT,
    defaultValue: [],
    parse: SYNCED_SETTINGS.titleFilters.parse,
    serialize: SYNCED_SETTINGS.titleFilters.serialize,
  }),
);

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

// The two article-load sizes. Stored as the decimal number; anything that
// isn't one of the offered sizes (a hand-edited value, or a size this build no
// longer offers) reads as unset so the store falls back to its default rather
// than paging by some number the Settings chips can't show.
// Each store validates against ITS OWN option list, not the shared scale: a
// size the other picker offers is still one this one can't show.
function loadCountStore(
  storageKey: string,
  options: readonly ArticleLoadCount[],
  defaultValue: ArticleLoadCount,
) {
  return createPersistentStore<ArticleLoadCount>({
    storageKey,
    changeEvent: CHANGE_EVENT,
    defaultValue,
    parse: (raw) => {
      const n = Number(raw);
      return options.find((size) => size === n);
    },
    serialize: (value) => String(value),
  });
}

const articlesPerPageStore = loadCountStore(
  ARTICLES_PER_PAGE_KEY,
  ARTICLES_PER_PAGE_OPTIONS,
  DEFAULT_ARTICLES_PER_PAGE,
);
const articlesPerSectionStore = loadCountStore(
  ARTICLES_PER_SECTION_KEY,
  ARTICLES_PER_SECTION_OPTIONS,
  DEFAULT_ARTICLES_PER_SECTION,
);

// The single read-later service the reader offers, or null for None (the
// default — save is opt-in, so the ⋮ menu shows no "Save to …" until you pick
// one). At most one service is enabled. A stored id that's no longer a known
// service reads as None. Per-device (like the toolbar position and list layout):
// which save integration you reach for — and whether favoriting pops it open —
// is a per-device ergonomic, not synced account intent.
const saveServiceStore = createPersistentStore<ReadLaterService | null>({
  storageKey: SAVE_SERVICE_KEY,
  changeEvent: CHANGE_EVENT,
  defaultValue: null,
  parse: (raw) => (isReadLaterService(raw) ? raw : undefined),
  serialize: (value) => value ?? '',
});

// Whether favoriting an article also opens the chosen save service's save page
// in a new tab (default off). Only takes effect when a save service is set —
// there's nothing to save to otherwise.
const autoSaveOnFavoriteStore = createPersistentStore<boolean>({
  storageKey: AUTO_SAVE_ON_FAVORITE_KEY,
  changeEvent: CHANGE_EVENT,
  defaultValue: false,
  parse: (raw) => (raw === '1' ? true : raw === '0' ? false : undefined),
  serialize: (value) => (value ? '1' : '0'),
});

// Session-only spoiler override — the toolbar's eye toggle (see ListToolbar /
// ItemList). The synced `hideSportsSpoilers` preference is the baseline every
// load starts from; the toggle records an EPHEMERAL choice here, in memory
// only, never localStorage — so a refresh drops it and the view returns to the
// user's saved preference (the requested "reset on refresh"). `null` = follow
// the saved preference; a boolean = an explicit this-session choice. Kept as a
// tiny hand-rolled external store (not createPersistentStore, which is
// localStorage-backed by design) so useSyncExternalStore can share it across
// every mounted row and the toolbar button.
let spoilerSessionOverride: boolean | null = null;
const spoilerOverrideListeners = new Set<() => void>();
function getSpoilerSessionOverride(): boolean | null {
  return spoilerSessionOverride;
}
function setSpoilerSessionOverride(next: boolean | null): void {
  spoilerSessionOverride = next;
  for (const cb of spoilerOverrideListeners) cb();
}
function subscribeSpoilerOverride(onChange: () => void): () => void {
  spoilerOverrideListeners.add(onChange);
  return () => {
    spoilerOverrideListeners.delete(onChange);
  };
}

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

/** Whether a row auto-marked Done on scroll is REMOVED from the list (default)
 * or left in place, struck through, until the list next re-materializes.
 * Only meaningful while {@link useHideOnScroll} is on. Per-account, synced. */
export function useHideOnScrollRemove(): {
  hideOnScrollRemove: boolean;
  setHideOnScrollRemove: (next: boolean) => void;
} {
  const hideOnScrollRemove = usePersistentStore(hideOnScrollRemoveStore);
  const setHideOnScrollRemove = useCallback(
    (next: boolean) => hideOnScrollRemoveStore.set(next),
    [],
  );
  return { hideOnScrollRemove, setHideOnScrollRemove };
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

/** The spoiler-hiding state the LIST actually renders with — the saved
 * `hideSportsSpoilers` preference unless the toolbar's eye toggle has overridden
 * it this session. `toggle` flips the effective value into the in-memory
 * session override (see {@link setSpoilerSessionOverride}), so it takes effect
 * everywhere at once but is forgotten on refresh, when the view reverts to the
 * saved preference. The allowlist gate still applies at the display site (see
 * lib/spoilerHeadline / ItemRow), so this is a no-op for off-list users. */
export function useEffectiveHideSpoilers(): {
  hideSpoilers: boolean;
  toggle: () => void;
} {
  const { hideSportsSpoilers } = useHideSportsSpoilers();
  const override = useSyncExternalStore(
    subscribeSpoilerOverride,
    getSpoilerSessionOverride,
    getSpoilerSessionOverride,
  );
  const hideSpoilers = override ?? hideSportsSpoilers;
  const toggle = useCallback(
    () => setSpoilerSessionOverride(!hideSpoilers),
    [hideSpoilers],
  );
  return { hideSpoilers, toggle };
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

/** The FLAT river's page size — the `limit` on each read, so what a fresh load
 * lands and what each "More" tap appends. Not used while grouping by feed (the
 * grouped read sends no fetch cap); that view has its own window below.
 * Per-device. See lib/types `DEFAULT_ARTICLES_PER_PAGE` / FeedPages. */
export function useArticlesPerPage(): {
  articlesPerPage: ArticleLoadCount;
  setArticlesPerPage: (next: ArticleLoadCount) => void;
} {
  const articlesPerPage = usePersistentStore(articlesPerPageStore);
  const setArticlesPerPage = useCallback(
    (next: ArticleLoadCount) => articlesPerPageStore.set(next),
    [],
  );
  return { articlesPerPage, setArticlesPerPage };
}

/** The group-by-feed display window — how many body rows each feed's section
 * opens with, and how many each section "More" reveals from the rows the one
 * deep read already fetched (so it costs no request). Per-device. See
 * lib/types `DEFAULT_ARTICLES_PER_SECTION` / ItemList's `perFeedLimit`. */
export function useArticlesPerSection(): {
  articlesPerSection: ArticleLoadCount;
  setArticlesPerSection: (next: ArticleLoadCount) => void;
} {
  const articlesPerSection = usePersistentStore(articlesPerSectionStore);
  const setArticlesPerSection = useCallback(
    (next: ArticleLoadCount) => articlesPerSectionStore.set(next),
    [],
  );
  return { articlesPerSection, setArticlesPerSection };
}

/** The single read-later service the reader offers, or null for None (the
 * default — save is opt-in). At most one is enabled. Per-device. See
 * lib/readLater / SettingsPage. */
export function useSaveService(): {
  saveService: ReadLaterService | null;
  setSaveService: (next: ReadLaterService | null) => void;
} {
  const saveService = usePersistentStore(saveServiceStore);
  const setSaveService = useCallback(
    (next: ReadLaterService | null) => saveServiceStore.set(next),
    [],
  );
  return { saveService, setSaveService };
}

/** Whether favoriting an article also opens the chosen save service's save page
 * in a new tab (default off) — the same deep link the ⋮ menu uses (no API/
 * credentials). No effect unless a save service is set. Per-device. */
export function useAutoSaveOnFavorite(): {
  autoSaveOnFavorite: boolean;
  setAutoSaveOnFavorite: (next: boolean) => void;
} {
  const autoSaveOnFavorite = usePersistentStore(autoSaveOnFavoriteStore);
  const setAutoSaveOnFavorite = useCallback(
    (next: boolean) => autoSaveOnFavoriteStore.set(next),
    [],
  );
  return { autoSaveOnFavorite, setAutoSaveOnFavorite };
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

/** The reader's filtered words AND categories — one commingled, normalized
 * list (SPEC.md *Filtered words*): an article whose title matches an entry,
 * or whose own `categories[]` contains one (case-insensitively — see
 * `lib/titleFilter.ts`'s `titleIsFiltered`/`categoriesAreFiltered`), vanishes
 * from the feed views. Entries are stored normalized, so callers can match
 * against them directly. Add/remove rather than a whole-list setter — every
 * caller edits one entry at a time, and normalizing here is what keeps the
 * stored list in the form the matcher expects. Per-account, synced. */
export function useTitleFilters(): {
  titleFilters: string[];
  addTitleFilter: (raw: string) => void;
  removeTitleFilter: (entry: string) => void;
} {
  const titleFilters = usePersistentStore(titleFiltersStore);
  const addTitleFilter = useCallback((raw: string) => {
    const entry = normalizeFilter(raw);
    if (!entry) return;
    const current = titleFiltersStore.get();
    if (current.includes(entry)) return;
    titleFiltersStore.set([...current, entry]);
  }, []);
  const removeTitleFilter = useCallback((entry: string) => {
    const target = normalizeFilter(entry);
    if (!target) return;
    const current = titleFiltersStore.get();
    // Compare NORMALIZED on both sides. Stored entries are normalized by every
    // path that writes them, but a hand-edited localStorage value needn't be —
    // and an entry Remove can't delete is a chip the reader is stuck with.
    const next = current.filter((e) => normalizeFilter(e) !== target);
    if (next.length !== current.length) titleFiltersStore.set(next);
  }, []);
  return { titleFilters, addTitleFilter, removeTitleFilter };
}

/** Test-only: drop the stores' parse memos so `localStorage.clear()` alone
 * resets state between cases. */
export function resetReadingPrefsCacheForTest(): void {
  hideOnScrollStore.resetForTest();
  hideOnScrollRemoveStore.resetForTest();
  debugScrollJumpsStore.resetForTest();
  groupByFeedStore.resetForTest();
  showRowFaviconStore.resetForTest();
  showGroupFaviconStore.resetForTest();
  hideSportsSpoilersStore.resetForTest();
  autoSummarizePinnedStore.resetForTest();
  titleFiltersStore.resetForTest();
  bottomBarStore.resetForTest();
  itemSortStore.resetForTest();
  listLayoutStore.resetForTest();
  articlesPerPageStore.resetForTest();
  articlesPerSectionStore.resetForTest();
  saveServiceStore.resetForTest();
  autoSaveOnFavoriteStore.resetForTest();
  spoilerSessionOverride = null;
}
