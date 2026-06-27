import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type AnimationEvent as ReactAnimationEvent,
  type CSSProperties,
} from 'react';
import { flushSync } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useConnectivityStatus } from '../hooks/useOnlineStatus';
import { useFeedItems, type FetchPage } from '../hooks/useFeedItems';
import type { ItemSort, Page } from '../lib/data/DataSource';
import { useInViewIds } from '../hooks/useInViewIds';
import { useHideOnScroll, useBottomBarPosition } from '../hooks/useReadingPrefs';
import { useCollapsedFeeds } from '../hooks/useCollapsedFeeds';
import { useTopChromeHeight } from '../hooks/useTopChromeHeight';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import type { FeedId, FeedItem, ItemId } from '../lib/types';
import { placeStayInBodyPins } from '../lib/feedOrder';
import { measureStickyBottomInset, measureTopChromeHeight } from '../lib/stickyInset';
import { adjustUnreadCounts } from '../lib/unreadAdjust';
import { loadFailureCopy, presentableDetail } from '../lib/loadErrorCopy';
import { LoadError } from './LoadError';
import { checkForServiceWorkerUpdate } from '../lib/swUpdate';
import { ItemRows } from './ItemRows';
import { ListToolbar } from './ListToolbar';
import { PromoBar } from './PromoBar';
import { PullToRefresh } from './PullToRefresh';
import { useFeedBar } from './FeedBarContext';
import './ItemList.css';

// Auto-hide-on-scroll dismissals within this window of each other share one
// undo batch, so a single toolbar Undo restores the whole burst the reader just
// scrolled past. Mirrors newshacker's DISMISS_BATCH_WINDOW_MS — long enough to
// cover a fast scroll burst, short enough that Undo only reaches what was just
// on screen.
const SCROLL_HIDE_BATCH_WINDOW_MS = 2000;

// Module-level monotonic source of auto-hide burst keys. The store's undo batch
// key is global (one shared DataSource across every feed view), so a per-mount
// counter that always starts at 0 would let two ItemList mounts collide — a
// burst on one view would extend another view's stale undo batch. A global
// sequence makes every burst's key unique across all lists.
let scrollBurstSeq = 0;

// Sweep animation duration — keep in sync with `.item-list__row--sweeping` in
// ItemList.css and `EXIT_DURATION_MS` in `useSwipeToDismiss`. Tapping the broom
// should feel like every row swiped itself away at the same moment. JS holds
// the actual hide until the matching `animationend` fires (or a 2× fallback
// timer, in case the event is throttled / suppressed by the browser).
const SWEEP_ANIMATION_MS = 200;

// After a sweep commits, ignore further sweep taps for a short beat. In grouped
// mode a section refills with the feed's next items the instant the swept rows
// hide, so a quick second tap (e.g. a feed's broom followed by the toolbar
// Sweep) would immediately clear the just-surfaced rows — reading as "it swept
// the feed twice". The cooldown extends the in-flight guard past the commit so
// a rapid follow-up tap is dropped until the list has settled; a deliberate
// later sweep (well over half a second on) still goes through.
const SWEEP_COOLDOWN_MS = 400;

// Cap on how many pages a single "More" tap will auto-fetch past collapsed-only
// content before stopping (and leaving "More" available again). A collapsed feed
// with many pages of unread rows would otherwise let one tap pull the whole feed;
// this bounds it while still skipping past hidden runs to the next visible rows.
const MAX_AUTO_SKIP_PAGES = 10;

/** How many list elements a page set renders: in the group-by-feed view, one
 * header per feed section plus each non-collapsed row (a collapsed feed shows
 * only its header); otherwise just the row count. The list is contiguous by
 * feed, so a section boundary is a feed-id change. */
function renderedCountIn(
  list: FeedItem[],
  groupByFeed: boolean,
  collapsed: Set<FeedId>,
): number {
  if (!groupByFeed) return list.length;
  let count = 0;
  let lastFeedId: FeedId | null = null;
  for (const fi of list) {
    if (fi.item.feedId !== lastFeedId) {
      count += 1; // section header
      lastFeedId = fi.item.feedId;
    }
    if (!collapsed.has(fi.item.feedId)) count += 1; // visible row
  }
  return count;
}

/** Fetch a single feed's next page, for the group-by-feed per-section "More".
 * Mirrors {@link FetchPage} but scoped to one feed (the page wires it to
 * `getFeedItems(feedId, …)`), so a section can page deeper into its own feed
 * without disturbing the other sections. */
export type FetchFeedPage = (
  feedId: FeedId,
  cursor: string | null,
) => Promise<Page<FeedItem>>;

/** A feed section's on-demand pages (group-by-feed per-section "More"): the rows
 * fetched past its opening window, the server cursor for the next page, whether a
 * fetch is in flight, and whether the feed is exhausted (`nextCursor === null`).*/
interface FeedExtra {
  items: FeedItem[];
  nextCursor: string | null;
  loading: boolean;
  done: boolean;
  /** Monotonic id of the in-flight fetch that produced/owns this entry. A
   * settling response only applies if it still matches the entry's id, so a
   * window-reset (which deletes the entry) or a superseding tap can't be undone
   * by a stale older response writing its old-offset page back. */
  reqId: number;
}

interface Props {
  viewKey: string;
  fetchPage: FetchPage;
  /** Shown in the empty state, e.g. "No unread items". */
  emptyLabel?: string;
  /** Render feed-section headers above the body (group-by-feed view). The page
   * passes the resolved preference; off for single-feed views, where one section
   * header would be redundant. The DataSource must already return the body
   * sectioned by feed for the headers to land in the right places. */
  groupByFeed?: boolean;
  /** Group-by-feed only: page deeper into a single feed's section. When this and
   * {@link Props.perFeedLimit} are both set, each section opens windowed to
   * `perFeedLimit` rows and grows a per-section "More" button at its foot that
   * appends that feed's next page inline — independent of the other sections and
   * of the (now single-page) base read. Omitted ⇒ no per-section More. */
  fetchFeedPage?: FetchFeedPage;
  /** The per-feed window size the grouped base read was capped to — how many
   * rows each section opens with, and the offset the first per-section "More"
   * fetches from. Only meaningful alongside {@link Props.fetchFeedPage}. */
  perFeedLimit?: number;
  /** Multi-feed views (Home, folders) pass this to surface a group-by-feed
   * toggle in the top toolbar. Omitted on single-feed views, where grouping is
   * a no-op. Flipping it re-keys the view (the page folds the pref into
   * `viewKey`), so the list refetches with the new layout. */
  onToggleGroupByFeed?: () => void;
  /** The current `readmo:item-sort` value, shown by the toolbar's sort toggle.
   * Only meaningful alongside {@link Props.onToggleSort}. */
  itemSort?: ItemSort;
  /** Feed views pass this to surface a newest/oldest-first toggle in the top
   * toolbar. Like grouping, flipping it re-keys the view so the list refetches
   * in the new order. */
  onToggleSort?: () => void;
}

/** A feed view (home / folder / single feed): sticky toolbar, item rows with
 * swipe, an explicit "More" button, and the background-refresh status strip. */
export function ItemList({
  viewKey,
  fetchPage,
  emptyLabel,
  groupByFeed = false,
  fetchFeedPage,
  perFeedLimit,
  onToggleGroupByFeed,
  itemSort = 'newest',
  onToggleSort,
}: Props) {
  const ds = useDataSource();
  // Per-section "More" is live only when the page wired a single-feed pager AND
  // told us the window size the base read was capped to. Both come together (the
  // grouped home/folder reads), so one flag gates the whole feature.
  const perGroupMore =
    groupByFeed && !!fetchFeedPage && perFeedLimit != null && perFeedLimit > 0;
  const status = useConnectivityStatus();
  // Offset for the sticky group-by-feed section headers: the combined height of
  // the app header + top toolbar, so a pinned header sits flush under them.
  // Only meaningful (and only applied below) when grouping, where headers exist.
  const topChromeHeight = useTopChromeHeight();
  const {
    items,
    isLoading,
    isError,
    isFetching,
    hasMore,
    isFetchingMore,
    fetchMore,
    refetch,
    isRefreshing,
    refreshFailed,
    error,
  } = useFeedItems(viewKey, fetchPage);

  // Surface the FULL read failure in the browser console (desktop debugging) —
  // the on-screen panel shows a friendly headline + a curated one-line detail,
  // but the complete error object (PostgREST message, schema mismatch, RLS
  // denial, stack) lands here. Previously this was swallowed behind generic
  // "server isn't responding" copy.
  useEffect(() => {
    if (error) console.error('[readmo] fetching the feed list failed:', error);
  }, [error]);
  const listRef = useListKeyboardNav();
  const { registerSweep } = useFeedBar();
  const { hideOnScroll } = useHideOnScroll();

  // Auto-hide-on-scroll: when enabled, mark unpinned rows Done the moment they
  // scroll off the top of the viewport (the user scrolled past them without
  // pinning). Reuses Sweep's `hideMany` so the feed refetch filters the row out.
  // Pinned rows are shielded, exactly like Sweep. Off by default (SPEC.md
  // *Reading settings*).
  //
  // Undo restores the whole scroll burst, not just the last row: dismissals
  // within SCROLL_HIDE_BATCH_WINDOW_MS of each other share one undo batch
  // (mirrors newshacker's dismiss-batch window). Each burst gets a fresh
  // `batchKey`; the store only extends a batch with a matching key, so an
  // intervening swipe/Sweep (a keyless hide) can't be bundled into a later
  // scroll hide — that manual dismissal replaces the batch and the next scroll
  // hide starts its own. A gap longer than the window also starts a new burst,
  // so Undo only ever reaches back to what the reader was just looking at.
  const lastScrollHideAt = useRef(0);
  const scrollBatchKey = useRef(0);
  // Forward-declared so handleExitTop can read the latest pending-sweep ids
  // without re-subscribing the observer. Populated by handleSweep below.
  const sweepPendingIdsRef = useRef<ItemId[] | null>(null);
  const handleExitTop = useCallback(
    (ids: ItemId[]) => {
      // Skip rows that are pinned (shielded) or already Done/Hidden — a
      // re-delivered id (e.g. observer recreation on a sticky-inset change
      // before the refetch drops the row) must not re-enter hideMany and
      // clobber the undo baseline with the already-Done state.
      //
      // Also skip rows that are mid-sweep: tapping Sweep registers a pending
      // batch (animation in flight, hideMany deferred). If a swept row also
      // scrolls off the top before the animation commits, the keyed auto-hide
      // fires first → marks done with baseline "not done" → then the keyless
      // sweep commit fires for the same id with baseline "already done",
      // replacing the auto-hide undo batch with one that's a no-op on undo.
      // Pressing Undo after such a race would leave the swept-and-scrolled
      // row hidden. The user tapped Sweep first, so Sweep owns the dismissal
      // for those ids; the auto-hide IO ignores them.
      const sweeping = sweepPendingIdsRef.current;
      const toHide = ids.filter((id) => {
        if (sweeping && sweeping.includes(id)) return false;
        const st = ds.stateStore.get(id);
        return !st.pinned && !st.done && !st.hidden;
      });
      if (toHide.length === 0) return;
      const now = Date.now();
      if (now - lastScrollHideAt.current >= SCROLL_HIDE_BATCH_WINDOW_MS) {
        // A gap ends the burst; mint a globally-unique key for the new one so it
        // can't extend another view's (or this view's prior) undo batch.
        scrollBatchKey.current = ++scrollBurstSeq;
      }
      lastScrollHideAt.current = now;
      ds.stateStore.hideMany(toHide, now, { batchKey: scrollBatchKey.current });
    },
    [ds],
  );
  const { inViewIds, getRowRef } = useInViewIds({
    onExitTop: hideOnScroll ? handleExitTop : undefined,
  });

  // When the bottom toolbar is pinned to the viewport foot it's always on
  // screen, so `hasMore` alone (another *page* is fetchable) can't drive "More"
  // — it would flash "No more items" while loaded rows still sit below the fold.
  // There it acts as a pager: while the bottom of the loaded list is off-screen
  // it scrolls a page down to reveal more rows; once the list end is in view and
  // another page exists it fetches that page; only at the true end does it settle
  // into a disabled "No more items". In the default *relative* mode the bar lives
  // at the end of the list, so the reader only reaches "More" once already at the
  // foot — the pager's page-down branch would force a needless second tap, so
  // there "More" just fetches (canAdvance = hasMore), matching newshacker.
  const { bottomBarPosition } = useBottomBarPosition();
  const pinnedBar = bottomBarPosition === 'screen';
  const [atListEnd, setAtListEnd] = useState(false);

  // Collapse/expand of feed sections (group-by-feed only). Read here, near the
  // top, because the end-of-list measurement and the "More" fetch loop both
  // depend on how many rows are actually *shown* — collapsing hides rows without
  // changing `items.length`. Per-device and persisted, so a section stays
  // collapsed across reloads and between grouped views.
  const { collapsed, toggle, collapseAll, expand } = useCollapsedFeeds();
  // Mirror into a ref so the async "More" loop (which spans renders) reads the
  // latest set without a stale closure.
  const collapsedRef = useRef<Set<FeedId>>(new Set());
  collapsedRef.current = collapsed;

  // Anchors the fetch-and-scroll path: the id of the last row before a tap that
  // triggers a fetch (ids are stable across a plain page fetch — no state change
  // reorders them), so the effect below can scroll the page's first row up once
  // it renders.
  const pendingAnchorId = useRef<string | null>(null);

  // How many list elements a given page set would render (headers + visible
  // rows), via the live collapsed ref so the async loop below isn't stale. Used
  // to keep fetching past pages that render nothing new — but a newly appearing
  // section header (even a collapsed feed's) counts as progress and stops it.
  const renderedCountOf = useCallback(
    (list: typeof items) => renderedCountIn(list, groupByFeed, collapsedRef.current),
    [groupByFeed],
  );

  const handleMore = useCallback(async () => {
    // Pinned bar only: bottom of the loaded list still below the fold → page
    // down to it. In relative mode the reader is already at the foot, so skip
    // straight to the fetch.
    if (pinnedBar && !atListEnd) {
      const page =
        window.innerHeight - measureTopChromeHeight() - measureStickyBottomInset();
      // Browsers honoring prefers-reduced-motion fall back to an instant scroll.
      window.scrollBy({ top: Math.max(page, 200), behavior: 'smooth' });
      return;
    }
    // At the end with another page available → fetch it; the effect scrolls the
    // first new element below the top chrome once it lands. When grouping with
    // collapsed sections, a fetched page can render nothing new (all hidden rows
    // of a continuing collapsed feed) — keep fetching (bounded) until something
    // new is rendered (a visible row OR a new section header) or the feed is
    // exhausted, so "More" never lands the reader on a page that shows nothing.
    pendingAnchorId.current = items[items.length - 1]?.item.id ?? null;
    const baselineRendered = renderedCountOf(items);
    let totalLoaded = items.length;
    for (let i = 0; i < MAX_AUTO_SKIP_PAGES; i++) {
      const res = await fetchMore();
      const all = res.data?.pages.flatMap((p) => p.items) ?? [];
      // No new page appended (true end, or a fetch error) → stop.
      if (all.length <= totalLoaded) break;
      totalLoaded = all.length;
      // Something new rendered (a row or a new header), or nothing left → done.
      if (renderedCountOf(all) > baselineRendered || !(res.hasNextPage ?? false)) break;
    }
  }, [pinnedBar, atListEnd, items, fetchMore, renderedCountOf]);

  useEffect(() => {
    const anchorId = pendingAnchorId.current;
    if (anchorId === null) return;
    const anchorIndex = items.findIndex((fi) => fi.item.id === anchorId);
    // Wait until the appended page has rendered (a row now follows the anchor).
    if (anchorIndex === -1 || anchorIndex >= items.length - 1) return;
    // Scroll to the first appended element that's actually rendered — a section
    // header (a collapsed feed has one but no visible rows) or a row. Hidden rows
    // aren't in the DOM, so they're skipped; during an auto-skip the early pages
    // may render nothing, in which case we wait for a header/row to land.
    let target: Element | null = null;
    for (let i = anchorIndex + 1; i < items.length; i++) {
      const id = items[i].item.id;
      const el =
        document.querySelector(`[data-header-for="${id}"]`) ??
        document.querySelector(`[data-item-id="${id}"]`);
      if (el instanceof HTMLElement) {
        target = el;
        break;
      }
    }
    if (!(target instanceof HTMLElement)) return; // appended elements still all hidden
    pendingAnchorId.current = null;
    const top = target.getBoundingClientRect().top + window.scrollY - measureTopChromeHeight();
    // Browsers honoring prefers-reduced-motion fall back to an instant scroll.
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [items]);

  // Visible items = the cached page minus anything the user has *locally*
  // marked Done/Hidden after the page landed. The DataSource already filters
  // those out at fetch time, but a single-row swipe-right or a Sweep flips
  // the store synchronously while React Query's invalidation triggers a
  // background refetch; until that refetch lands (or if it fails — offline,
  // network error) the cached page still carries the dismissed row, and
  // without this filter the parent `<li>` stays in flow while only its
  // `<article>` is translated off-screen, leaving a blank gap.
  //
  // Force a re-render on every store mutation so the visibleItems filter
  // below picks up local Done/Hidden flips. A useSyncExternalStore snapshot
  // tied to `entries().length` would miss the case where `hide()` mutates an
  // *existing* item-state row (e.g. an item that was already opened): the
  // map length stays the same, the snapshot value matches by Object.is, and
  // the subscriber never re-renders. A reducer-counter that bumps on every
  // emit() is simpler and correct — the filter reads stateStore.get
  // directly so we don't need a stable snapshot value, just a render trigger.
  const [storeVersion, bumpStoreVersion] = useReducer((x: number) => x + 1, 0);
  useEffect(
    () => ds.stateStore.subscribe(bumpStoreVersion),
    [ds],
  );

  // In-session pins keep their place. The data source orders every pin to the
  // top of its section, which is the right resting state on a fresh load — but
  // pinning a row the reader is *looking at* shouldn't yank it up under their
  // eye (SPEC.md *Feed views*: "pinning a body row keeps its position"). We
  // track the ids the reader pins this session while the row is in the loaded
  // window and keep those at their natural feed position; `mergedRaw` below
  // applies the override. The set lives only in component state, so a reload
  // starts clean (every pin groups at the top); pull-to-refresh and Sweep clear
  // it explicitly to consolidate (SPEC.md "Sweep consolidates").
  const [stayInBodyIds, setStayInBodyIds] = useState<ReadonlySet<ItemId>>(
    () => new Set(),
  );

  // Per-section "More" (group-by-feed): each feed's extra pages, fetched on
  // demand from that feed alone and appended after its base run. The base read
  // is a single page capped to `perFeedLimit` rows per feed; tapping a section's
  // More fetches its next page (offset = how many of that feed are already
  // shown) and merges it inline, leaving every other section untouched. Keyed by
  // feed id; reset when the view changes so one view's depth never leaks into
  // another.
  //
  // Item *state* on extras stays live: they flow through the same store overlay
  // as base rows — `visibleItems` drops locally Done/Hidden extras and each
  // ItemRow reads pin/opened from the store — so any state the store knows is
  // reflected without a refetch. The known gap is server-side changes to rows
  // *past* a feed's opening window that the local store hasn't learned (e.g. a
  // cross-device Done): base rows self-heal via the server's feed_items filter
  // on the next refetch, but these cached extras don't, so a stale past-window
  // row can linger until that feed's window membership changes or the view
  // remounts. Re-validating extras on every refetch was rejected: ['feed']
  // invalidates on each open/pin/sweep, so it would either churn an extra read
  // per mutation or collapse expanded sections on a routine open.
  const [feedExtras, setFeedExtras] = useState<Map<FeedId, FeedExtra>>(
    () => new Map(),
  );
  // Per-feed sticky display window: the set of item ids the user has committed
  // to viewing in this section. Initialized from the first base read for each
  // feed (first `perFeedLimit` ids), extended only when the user taps a section
  // "More" (the appended extras' ids are added below in handleFeedMore), and
  // wiped on viewKey change or pull-to-refresh. The base read can still pull in
  // newer rows server-side — Sweep marks rows Done and the global feed
  // invalidation triggers a refetch — but those new ids are filtered out of
  // mergedRaw below until the reader explicitly asks for them. This pins the
  // section's displayed window to the user's view rather than to whatever the
  // server's "top N non-Done" currently is, which (a) keeps Sweep from auto-
  // refilling the section with `perFeedLimit − pinned` fresh items and (b)
  // prevents a pin-an-extra promotion (the pinned id enters the base window)
  // from collapsing the section back to the base window — the pinned id is in
  // the sticky set so it stays visible, and so does every other expanded row.
  const [displayedByFeed, setDisplayedByFeed] = useState<Map<FeedId, Set<ItemId>>>(
    () => new Map(),
  );

  // The set of ids currently in front of the reader, used by the in-session pin
  // tracking below. Not just `items`: in the windowed grouped view, rows
  // revealed by a section's "More" live in `feedExtras` / the sticky display
  // window (`displayedByFeed`), not the base read — so a pin on one of those
  // rows would otherwise go undetected and the next refetch (which promotes the
  // pin into the base window) would lift it to the section top. Union all three
  // so pinning any visible row is observed.
  const itemIds = useMemo(() => {
    const s = new Set<ItemId>(items.map((fi) => fi.item.id));
    for (const ex of feedExtras.values()) {
      for (const fi of ex.items) s.add(fi.item.id);
    }
    for (const set of displayedByFeed.values()) {
      for (const id of set) s.add(id);
    }
    return s;
  }, [items, feedExtras, displayedByFeed]);
  const itemIdsRef = useRef(itemIds);
  itemIdsRef.current = itemIds;
  // A pin counts as in-session only when the reader does it themselves. We
  // listen on the store's *mutation* channel (set / hide / sweep / undo) rather
  // than the general subscribe, so a background hydrate or cross-device sync —
  // which flips pre-existing server pins to pinned via hydrate(), emitting no
  // diff — is never mistaken for the reader pinning a row. A fresh pin on a row
  // in the loaded window is held at its place.
  //
  // Unpinning does NOT drop the id here: the feed cache stays pinned-first until
  // the unpin's refetch lands, so the row must keep being anchored to its body
  // slot through that round-trip (placeStayInBodyPins re-sorts a held row by
  // date whether or not it's still pinned). The id is cleared when it leaves the
  // window (the GC effect below) or on the next consolidation (PTR / Sweep /
  // view change) — by which point the cache no longer lifts it anyway.
  useEffect(() => {
    return ds.stateStore.subscribeMutations((id, changed) => {
      if (!changed.pinned) return;
      if (!itemIdsRef.current.has(id)) return;
      setStayInBodyIds((cur) => (cur.has(id) ? cur : new Set(cur).add(id)));
    });
  }, [ds]);
  // As the loaded window changes (pagination, refetch), drop stay ids that left
  // it — a held pin that's no longer displayed has nothing to anchor.
  useEffect(() => {
    setStayInBodyIds((cur) => {
      if (cur.size === 0) return cur;
      let next: Set<ItemId> | null = null;
      for (const id of cur) {
        if (!itemIds.has(id)) (next ??= new Set(cur)).delete(id);
      }
      return next ?? cur;
    });
  }, [itemIds]);

  // Monotonic id stamped on each per-section More fetch, so a response that
  // settles after its entry was reset or superseded can be discarded.
  const moreSeqRef = useRef(0);
  // Drop a view's expanded sections only when the view actually changes (not on
  // mount), so switching home → folder → a single feed never carries one view's
  // depth into the next, while a same-view re-render keeps what's expanded.
  const prevViewKey = useRef(viewKey);
  useEffect(() => {
    if (prevViewKey.current !== viewKey) {
      prevViewKey.current = viewKey;
      setFeedExtras(new Map());
      setDisplayedByFeed(new Map());
      setStayInBodyIds(new Set());
    }
  }, [viewKey]);

  // Initialize the sticky display window for any feed seen in `items` that
  // doesn't have one yet. Takes the first `perFeedLimit` ids of that feed's
  // run — exactly the rows mergedRaw would have shown on first load — so the
  // user's initial view matches the server's top window.
  //
  // Also EXTENDS an existing sticky window when its ids are still the
  // contiguous prefix of items[]'s run for that feed AND items[] now carries
  // more rows than the sticky set. This handles the row-cap-overflow case
  // (`GROUPED_WINDOW_ROW_CAP` splits a feed's opening window across pages —
  // first page returns the partial section, second page returned by the
  // global "More" appends the rest; without extension the partial-window
  // sticky set would block the rest from rendering and skew the section's
  // own More cursor). The "still the prefix" check is what keeps this safe
  // for the cases the sticky window is supposed to gate: a refetch that
  // brings in fresh-top rows (post-Sweep refill, cross-device drift, polled-
  // in items) shifts the prefix away from the sticky ids, so the extension
  // is skipped and those new rows stay hidden until "More" or PTR.
  useEffect(() => {
    if (!perGroupMore || perFeedLimit == null) return;
    setDisplayedByFeed((cur) => {
      let next: Map<FeedId, Set<ItemId>> | null = null;
      let i = 0;
      while (i < items.length) {
        const feedId = items[i].item.feedId;
        const existing = cur.get(feedId);
        const firstIds: ItemId[] = [];
        let j = i;
        while (
          j < items.length &&
          items[j].item.feedId === feedId &&
          firstIds.length < perFeedLimit
        ) {
          firstIds.push(items[j].item.id);
          j++;
        }
        if (!existing) {
          if (firstIds.length > 0) {
            if (!next) next = new Map(cur);
            next.set(feedId, new Set(firstIds));
          }
        } else if (firstIds.length > existing.size) {
          // Only extend if existing sticky ids are the contiguous prefix of
          // the current items[] run for this feed — new rows ARRIVING AT THE
          // TOP would shift the prefix away from sticky and we'd correctly
          // leave the section anchored.
          let prefixStillSticky = true;
          for (let k = 0; k < existing.size && k < firstIds.length; k++) {
            if (!existing.has(firstIds[k])) {
              prefixStillSticky = false;
              break;
            }
          }
          if (prefixStillSticky) {
            const merged = new Set(existing);
            for (let k = existing.size; k < firstIds.length; k++) {
              merged.add(firstIds[k]);
            }
            if (!next) next = new Map(cur);
            next.set(feedId, merged);
          }
        }
        // Skip past the rest of this feed's run.
        while (i < items.length && items[i].item.feedId === feedId) i++;
      }
      return next ?? cur;
    });
  }, [perGroupMore, perFeedLimit, items]);

  // No extras-drop effect: with the first-unseen cursor in handleFeedMore
  // and the row-cache fallback in mergedRaw, the original "drop misaligned
  // extras when the server view drifts" job is no longer needed. The first
  // More tap on an empty feed recomputes the cursor against fresh items[]
  // (so cross-device drift is handled at fetch time, not by deleting state);
  // later taps follow the server's next cursor and dedup against the cache,
  // so any minor misalignment after drift causes at most a partial overlap
  // page, not a skipped or duplicated section. The previous effect also had
  // a race where it would delete a just-committed extras entry whenever the
  // base window's top item hadn't been "opted into" by the sticky set — a
  // common case right after a successful More that brought new ids in via
  // extras instead of via items[].

  const handleFeedMore = useCallback(
    async (feedId: FeedId) => {
      if (!fetchFeedPage || perFeedLimit == null) return;
      const existing = feedExtras.get(feedId);
      if (existing?.loading) return;
      // An exhausted entry (`done: true`) normally blocks further taps, but
      // a new top item arriving after exhaustion (cross-device pin, polled
      // RSS item) shows up as "unseen in base window" — handleFeedMore's
      // first-unseen cursor logic will fetch starting at that row's
      // position, so it's reachable via tap. Without this, an exhausted
      // section's More would no-op and the new row would only be revealed
      // by pull-to-refresh.
      const allowed = displayedByFeed.get(feedId);
      const hasUnseenTop =
        !!allowed &&
        (() => {
          let pos = 0;
          for (const fi of items) {
            if (fi.item.feedId !== feedId) continue;
            if (pos >= perFeedLimit) break;
            if (!allowed.has(fi.item.id)) return true;
            pos += 1;
          }
          return false;
        })();
      if (existing?.done && !hasUnseenTop) return;
      // Cursor selection — recomputed against the current server view on
      // EVERY tap (not just the first), so a cross-device Done/Hide that
      // shrank the feed-items universe doesn't leave the saved nextCursor
      // pointing past the freshly-filtered row.
      //
      // - If the base window contains an id the sticky set hasn't seen
      //   (a new top item arrived between fetches), cursor = the position
      //   of that first unseen row. The next page starts at it, so a
      //   cross-device pin or a polled-in item doesn't get skipped past.
      // - Otherwise cursor = count of sticky ids the server still carries
      //   in items[] ∪ extras. That's "how many of the rows I've already
      //   seen are still in the current view" — exactly the offset for
      //   the next batch. On a stable view this equals the old nextCursor;
      //   when the server filtered a row out it shrinks by one (so the
      //   row that used to follow doesn't get skipped).
      let cursor: string | null;
      if (!allowed) {
        cursor = existing ? existing.nextCursor : String(perFeedLimit);
      } else {
        let pos = 0;
        let firstUnseen = -1;
        for (const fi of items) {
          if (fi.item.feedId !== feedId) continue;
          if (pos >= perFeedLimit) break;
          if (!allowed.has(fi.item.id)) {
            firstUnseen = pos;
            break;
          }
          pos += 1;
        }
        if (firstUnseen >= 0) {
          cursor = String(firstUnseen);
        } else {
          const inView = new Set<ItemId>();
          for (const fi of items) {
            if (fi.item.feedId === feedId && allowed.has(fi.item.id)) {
              inView.add(fi.item.id);
            }
          }
          if (existing) {
            for (const fi of existing.items) {
              if (!allowed.has(fi.item.id)) continue;
              // Skip a cached extra the server has since dropped from this
              // feed's sequence — Done/Hidden on another device, learned via
              // the item_state resync. It's no longer at any server offset, so
              // counting it would push the cursor past the row that now follows
              // and skip it. (`items[]` rows are already server-filtered, so the
              // gap is only in the client-cached extras.) Absence from `items[]`
              // can't tell "filtered" from "beyond the opening window", so local
              // Done/Hidden is the usable signal; excluding can only SHRINK the
              // offset, making the worst case a harmless deduped re-fetch overlap
              // rather than a skip.
              const st = ds.stateStore.get(fi.item.id);
              if (st.done || st.hidden) continue;
              inView.add(fi.item.id);
            }
          }
          let recomputed = inView.size;
          // Cap to the server's last accepted nextCursor. After a fresh-top
          // page lands (More #1 fetched cursor='0' for the heavy-refetch
          // case), older extras can still inflate the sticky-overlap count
          // past where the just-returned page ended; sending that larger
          // offset would skip the unseen tail of the fresh window. Only
          // undercut when the recomputed offset is smaller (server view
          // genuinely shrank via cross-device Done).
          if (existing && existing.nextCursor !== null) {
            const accepted = Number.parseInt(existing.nextCursor, 10);
            if (!Number.isNaN(accepted)) {
              recomputed = Math.min(recomputed, accepted);
            }
          }
          cursor = String(recomputed);
        }
      }
      if (cursor === null) return;
      // Tag this fetch so a response that settles after the entry was reset
      // (window changed) or superseded (a later tap) is discarded instead of
      // writing its stale-offset page back over the fresh state.
      const reqId = (moreSeqRef.current += 1);
      setFeedExtras((prev) => {
        const cur = prev.get(feedId);
        const next = new Map(prev);
        next.set(feedId, {
          items: cur?.items ?? [],
          // Remember the cursor we're attempting (not the last *successful* one),
          // so if this fetch fails the catch path leaves a retryable cursor. With
          // the old `cur?.nextCursor ?? null`, a failed *first* More left a null
          // cursor and the next tap would no-op forever (button stuck visible but
          // inert) until remount.
          nextCursor: cursor,
          loading: true,
          done: cur?.done ?? false,
          reqId,
        });
        return next;
      });
      try {
        const page = await fetchFeedPage(feedId, cursor);
        // Track whether the extras updater actually committed this response.
        // We need to gate the sticky-display update on the same condition: a
        // stale response that's about to be discarded from feedExtras must
        // NOT extend the sticky set either, or its old-page ids would re-
        // enter the displayed window the next time the base refetch pulled
        // them back in (auto-refill without a fresh tap). `extrasCommitted`
        // is set inside the updater (a state-derivable closure capture, not
        // an external side effect) and read after setFeedExtras returns — by
        // which time React has run the updater (and queued any update for
        // commit) so the flag reflects the decision the updater made.
        // Gate BOTH state updates on the same reqId-match decision so a stale
        // response (e.g. `viewKey` changed mid-flight, which clears
        // feedExtras outright) can't leak its old page ids into the new
        // view's sticky display set. flushSync forces React to run the
        // updater synchronously, so the `committed` flag set inside the
        // updater reflects the actual commit decision by the time the
        // sticky update is scheduled.
        let committed = false;
        flushSync(() => {
          setFeedExtras((prev) => {
            const cur = prev.get(feedId);
            // Reset (entry deleted) or superseded (newer reqId) while in
            // flight → drop this response. The extras-drop effect protects
            // in-flight loading entries (see its `entry.loading` guard) so a
            // mid-await Sweep doesn't trip this; the remaining trigger is a
            // deliberate viewKey reset that wiped feedExtras whole.
            if (cur?.reqId !== reqId) return prev;
            committed = true;
            const prevItems = cur.items;
            const ids = new Set(prevItems.map((fi) => fi.item.id));
            const appended = [...prevItems];
            for (const fi of page.items) {
              if (!ids.has(fi.item.id)) appended.push(fi);
            }
            const next = new Map(prev);
            next.set(feedId, {
              items: appended,
              nextCursor: page.nextCursor,
              loading: false,
              done: page.nextCursor === null,
              reqId,
            });
            return next;
          });
        });
        if (!committed) return;
        // Extend the sticky display window with the appended ids so they
        // survive a refetch — and so that pinning one of them (which moves
        // the row into the base window in the next fetch) doesn't shrink
        // the section: the now-base id is already in the sticky set.
        setDisplayedByFeed((prev) => {
          const cur = prev.get(feedId);
          if (!cur) return prev;
          const next = new Set(cur);
          let added = false;
          for (const fi of page.items) {
            if (!next.has(fi.item.id)) {
              next.add(fi.item.id);
              added = true;
            }
          }
          if (!added) return prev;
          const map = new Map(prev);
          map.set(feedId, next);
          return map;
        });
      } catch {
        // Leave the button tappable again on failure (nothing appended), the
        // same way the global More stays available after a failed page fetch —
        // but only if this is still the owning request (else a reset/newer tap
        // already moved on).
        setFeedExtras((prev) => {
          const cur = prev.get(feedId);
          if (cur?.reqId !== reqId) return prev;
          const next = new Map(prev);
          next.set(feedId, { ...cur, loading: false });
          return next;
        });
      }
    },
    [fetchFeedPage, perFeedLimit, feedExtras, items, displayedByFeed, ds],
  );

  // Per-id cache of FeedItem objects so a sticky row stays renderable even
  // when a refetch flushes it out of `items[]` and `feedExtras` (e.g. more
  // than perFeedLimit newer rows arrived at the top between fetches, so the
  // returned base page no longer contains any of the previously displayed
  // ids). Populated below from items[] and feedExtras on every render —
  // mergedRaw falls back to it for sticky ids that didn't make the cut.
  // This is what backs the SPEC's promise that the section "stays anchored
  // on what the reader is already viewing" even under heavy refetches.
  const rowCacheRef = useRef<Map<ItemId, FeedItem>>(new Map());
  if (perGroupMore) {
    for (const fi of items) rowCacheRef.current.set(fi.item.id, fi);
    for (const ex of feedExtras.values()) {
      for (const fi of ex.items) rowCacheRef.current.set(fi.item.id, fi);
    }
  }

  // The on-demand pages merged into the base river: each feed's base rows that
  // sit in its sticky display window, then its extras, deduped by id. The
  // sticky window (`displayedByFeed`) is initialized to the first `perFeedLimit`
  // base ids per feed on first load and extended by tap-More; everything else
  // — the (perFeedLimit + 1)th overfetched has-more probe, fresh items the
  // server slotted in after a Sweep, cross-device drift at the top — stays in
  // `items` but doesn't render here until the reader explicitly asks for it
  // (a tap on More or a pull-to-refresh). Sticky ids that are no longer in
  // items[]/feedExtras (cleared by a heavy refetch) fall back to the row cache,
  // so the displayed window survives even when no live source carries those
  // rows anymore. Other code paths read from this merged list so Sweep,
  // headers, counts and the end-of-list measurement all see exactly the
  // displayed rows. Identity-stable (=== items) outside the windowed grouped
  // view, so the flat river and single-feed views are untouched — except while
  // an in-session pin is held in body position, where it returns a reordered
  // copy (see placeStayInBodyPins).
  const mergedRaw = useMemo(() => {
    if (!perGroupMore || perFeedLimit == null) {
      // Flat river, single-feed, and grouped-without-windowing all read the
      // data source's order directly — apply the in-session pin override so a
      // just-pinned visible row keeps its place instead of jumping to the top.
      // No-op (returns `items` unchanged) when no in-session pin is present, so
      // identity is preserved for the views that rely on `mergedRaw === items`.
      void storeVersion;
      return placeStayInBodyPins(items, {
        groupByFeed,
        sortAsc: itemSort === 'oldest',
        stay: stayInBodyIds,
        isPinned: (id) => ds.stateStore.get(id).pinned,
      });
    }
    void storeVersion; // re-run on store changes so pinned-at-top stays current.
    const result: FeedItem[] = [];
    let i = 0;
    while (i < items.length) {
      const feedId = items[i].item.feedId;
      const allowed = displayedByFeed.get(feedId);
      // Walk this feed's items[] run once into an ordered slice + id-keyed
      // map so the order build below can look up FeedItems without rescanning.
      const baseRun: FeedItem[] = [];
      const baseById = new Map<ItemId, FeedItem>();
      while (i < items.length && items[i].item.feedId === feedId) {
        const fi = items[i];
        if (!baseById.has(fi.item.id)) {
          baseById.set(fi.item.id, fi);
          baseRun.push(fi);
        }
        i++;
      }
      const ex = feedExtras.get(feedId);
      const extrasById = new Map<ItemId, FeedItem>();
      if (ex) {
        for (const fi of ex.items) {
          if (!extrasById.has(fi.item.id)) extrasById.set(fi.item.id, fi);
        }
      }

      const feedSection: FeedItem[] = [];
      const feedSeen = new Set<ItemId>();
      const push = (fi: FeedItem) => {
        if (feedSeen.has(fi.item.id)) return;
        feedSeen.add(fi.item.id);
        feedSection.push(fi);
      };

      if (allowed) {
        // Pinned rows lead the section in items[] order — the server sorts
        // pinned-first within each feed run (see MockDataSource), so walking
        // baseRun naturally yields that ordering. Gating on `allowed` here
        // matters: the base read overfetches one row per feed as a has-more
        // probe, and a feed with more than perFeedLimit pinned rows would
        // otherwise leak its probe (the (perFeedLimit+1)th pinned row) into
        // the displayed section before any More tap. New cross-device /
        // polled-in pins still wait for More/PTR to surface, the same as
        // non-pinned new rows do.
        for (const fi of baseRun) {
          if (!allowed.has(fi.item.id)) continue;
          // An in-session pin stays at its natural position (handled by the
          // sticky-order pass below), so it's skipped here rather than lifted.
          if (
            ds.stateStore.get(fi.item.id).pinned &&
            !stayInBodyIds.has(fi.item.id)
          ) {
            push(fi);
          }
        }
        // Non-pinned rows render in sticky iteration order — the order the
        // reader actually opted into. Without this, a heavy refetch that
        // brings fresh top rows into items[] would render them above the
        // reader's existing anchored rows (which fell back to the row
        // cache), visibly shoving the anchor down. Look up each sticky id
        // from items[] → extras → row cache; if all three miss, drop it
        // (the row truly is gone for now).
        //
        // The cost: a row the server filtered out (cross-device Done/Hide,
        // item retracted) stays visible until the local state store learns
        // about the change. That's expected to come through the realtime
        // state-sync path; once `stateStore.get(id).done` flips, the
        // `visibleItems` filter drops the row. The (acceptable) window of
        // staleness here is bounded by sync latency, not "until PTR".
        for (const id of allowed) {
          if (feedSeen.has(id)) continue;
          const fi =
            baseById.get(id) ?? extrasById.get(id) ?? rowCacheRef.current.get(id);
          if (fi) push(fi);
        }
      } else {
        // No sticky entry yet (init effect hasn't run on the first paint) —
        // fall back to the "first perFeedLimit base rows" rule so the
        // section isn't blank. The server already sorts pinned rows to the
        // top of each feed run, so this naturally yields pin-first ordering
        // without a separate pinned pass. The init effect lands shortly
        // after and `allowed` takes over.
        let shown = 0;
        for (const fi of baseRun) {
          if (feedSeen.has(fi.item.id)) continue;
          if (shown >= perFeedLimit) break;
          push(fi);
          shown += 1;
        }
      }

      // Any extras the section hasn't surfaced yet (a More that committed
      // before the sticky-extension update raced through, defensive): append
      // them after the sticky-ordered tail in extras order. With normal flow
      // (handleFeedMore commits extras and the sticky extension under
      // flushSync), the loop is a no-op.
      if (ex) {
        for (const fi of ex.items) {
          if (!feedSeen.has(fi.item.id)) push(fi);
        }
      }

      for (const fi of feedSection) result.push(fi);
    }
    // No trailing fallback for feeds entirely absent from `items[]`. If the
    // server returns zero rows for a feed it could be a heavy-refetch
    // boundary (the feed has rows past the page), OR it could be that
    // cross-device Done/Hide cleared every displayed row from that feed's
    // scope (the local state store hasn't learned the remote flags so
    // visibleItems wouldn't drop the cached rows). We can't tell the two
    // apart from the server response, and resurrecting from cache in the
    // latter case bypasses self-healing — so the safe default is to let
    // the section collapse to the empty/phantom state and require a fresh
    // tap or PTR to reconcile.
    return result;
  }, [
    perGroupMore,
    perFeedLimit,
    items,
    feedExtras,
    displayedByFeed,
    ds,
    storeVersion,
    stayInBodyIds,
    groupByFeed,
    itemSort,
  ]);

  const visibleItems = mergedRaw.filter((fi) => {
    const st = ds.stateStore.get(fi.item.id);
    return !st.done && !st.hidden;
  });

  // Which feed sections should show a "More" at their foot, and which are
  // mid-fetch. A feed has more when it already holds extras that aren't
  // exhausted, or — before any expansion — when the base read returned MORE than
  // the display window (the overfetched probe row survived), proving older rows
  // exist. Using `> perFeedLimit` (not `>=`) is what keeps an exactly-full feed
  // — count === window, nothing older — from showing a dead More that fetches an
  // empty page and vanishes (SPEC: a feed at/under its window shows no More).
  const baseRawCountByFeed = useMemo(() => {
    const m = new Map<FeedId, number>();
    if (!perGroupMore) return m;
    for (const fi of items) m.set(fi.item.feedId, (m.get(fi.item.feedId) ?? 0) + 1);
    return m;
  }, [perGroupMore, items]);
  // Per-feed: does the base window contain at least one id the sticky set
  // hasn't seen yet? This catches the case where Sweep (or cross-device drift)
  // has the server returning the next `≤ perFeedLimit` non-Done rows: with the
  // probe-row signal alone, a feed whose remaining unread is exactly the
  // window would have no More even though every row in `items` is hidden by
  // the sticky gate. Tracking unseen-in-window keeps More reachable.
  const hasUnseenInBaseWindow = useMemo(() => {
    const s = new Set<FeedId>();
    if (!perGroupMore || perFeedLimit == null) return s;
    let i = 0;
    while (i < items.length) {
      const feedId = items[i].item.feedId;
      const allowed = displayedByFeed.get(feedId);
      let pos = 0;
      while (i < items.length && items[i].item.feedId === feedId) {
        if (pos < perFeedLimit && allowed && !allowed.has(items[i].item.id)) {
          s.add(feedId);
        }
        pos += 1;
        i += 1;
      }
    }
    return s;
  }, [perGroupMore, perFeedLimit, items, displayedByFeed]);
  const feedsWithMore = useMemo(() => {
    if (!perGroupMore || perFeedLimit == null) return undefined;
    const s = new Set<FeedId>();
    for (const [feedId, count] of baseRawCountByFeed) {
      const ex = feedExtras.get(feedId);
      // Re-enable More for an exhausted feed (`ex.done`) when the base window
      // has unseen rows — typically a polled-in or cross-device-promoted item
      // arriving after the user paginated all the way through. Without this
      // there's no path to reveal the new content short of pull-to-refresh.
      if (ex) {
        if (!ex.done || hasUnseenInBaseWindow.has(feedId)) s.add(feedId);
      } else if (count > perFeedLimit || hasUnseenInBaseWindow.has(feedId)) {
        s.add(feedId);
      }
    }
    return s;
  }, [perGroupMore, perFeedLimit, baseRawCountByFeed, feedExtras, hasUnseenInBaseWindow]);
  // Canonical feed rank from the full base read — used by ItemRows to
  // interleave phantom sections at their proper ordinal position so a swept
  // middle feed doesn't shift to the end of the rendered list.
  const feedRank = useMemo(() => {
    if (!groupByFeed) return undefined;
    const m = new Map<FeedId, number>();
    let rank = 0;
    for (const fi of items) {
      if (!m.has(fi.item.feedId)) {
        m.set(fi.item.feedId, rank);
        rank += 1;
      }
    }
    return m;
  }, [groupByFeed, items]);

  // Feeds in `feedsWithMore` that ended up with zero visible rows — the
  // section the reader just swept where nothing pinned remained, so the
  // sticky display set is all-Done and the new top rows the refetch brought
  // in are blocked. Without a phantom header + "More" here the whole section
  // (and on a single-feed home/folder, the page) collapses to the empty state
  // and the reader can't pull the next page short of pull-to-refresh.
  // Titles come from `items` (the cached page still carries the feed
  // metadata even when every base row is filtered out of visibleItems).
  const emptyMoreSections = useMemo(() => {
    if (!feedsWithMore || feedsWithMore.size === 0) return undefined;
    const visibleFeedIds = new Set<FeedId>();
    for (const fi of visibleItems) visibleFeedIds.add(fi.item.feedId);
    const out: Array<{ feedId: FeedId; title: string }> = [];
    const titles = new Map<FeedId, string>();
    for (const fi of items) {
      if (!titles.has(fi.item.feedId)) titles.set(fi.item.feedId, fi.feed.title);
    }
    for (const feedId of feedsWithMore) {
      if (visibleFeedIds.has(feedId)) continue;
      const title = titles.get(feedId);
      if (title === undefined) continue; // feed dropped out of items entirely
      out.push({ feedId, title });
    }
    return out.length > 0 ? out : undefined;
  }, [feedsWithMore, visibleItems, items]);

  const loadingFeeds = useMemo(() => {
    if (!perGroupMore) return undefined;
    const s = new Set<FeedId>();
    for (const [feedId, ex] of feedExtras) if (ex.loading) s.add(feedId);
    // While the base query is refetching (typically right after a Sweep that
    // invalidated it), the cached `items[]` is still the pre-Sweep window — so
    // the first-page cursor `handleFeedMore` computes off it would count the
    // just-Done rows as seen and send an offset that skips past the freshest
    // page the refetch is about to expose. Hold EVERY section "More" in a
    // loading/disabled state until the refetch settles and the cursor calc
    // runs against fresh `items[]`. This includes both phantom sections (all-
    // unpinned sweeps) and live sections anchored by a pinned row that
    // survived the sweep. The brief disable on a no-op background refresh is
    // an accepted cost — typically a few hundred ms.
    if (isFetching && feedsWithMore) {
      for (const feedId of feedsWithMore) s.add(feedId);
    }
    return s;
  }, [perGroupMore, feedExtras, isFetching, feedsWithMore]);

  // Number of list elements actually rendered: one header per feed section plus
  // each non-collapsed row (a collapsed feed shows only its header). When not
  // grouping this is just visibleItems.length. Drives the end-of-list re-measure
  // and the auto-skip loop — both treat a newly rendered header (even a
  // collapsed feed's) as visible progress, not just rows. Keyed off visibleItems
  // so a swipe/Sweep that shrinks the DOM without a successful refetch still
  // triggers the re-measure; otherwise the screen-pinned bottom toolbar's
  // atListEnd would stay false and "More" would stay on its page-down branch
  // even though the rendered list has no more content below.
  const renderedCount = useMemo(
    () => renderedCountIn(visibleItems, groupByFeed, collapsed),
    [groupByFeed, visibleItems, collapsed],
  );

  useEffect(() => {
    const check = () => {
      const doc = document.documentElement;
      // Within 2px of the maximum scroll offset = the foot of the list is in
      // view (the sub-pixel slack avoids a sticky "More" at exact bottom).
      setAtListEnd(window.scrollY + window.innerHeight >= doc.scrollHeight - 2);
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
    // Re-measure when the *rendered* row count changes — a new page grows the
    // document, collapsing/expanding sections changes it without changing
    // items.length, and a local Done/Hidden flip shrinks it without a refetch.
  }, [renderedCount]);

  // Sweepable rows = unpinned rows the reader can *currently see* (Done/Hidden
  // are already filtered out by the DataSource). Sweep hides only the
  // fully-visible rows as one undoable batch — not the whole loaded list — so
  // scrolling past content and tapping the broom can't dismiss rows off-screen
  // (SPEC.md *List toolbar → Sweep*). Matches newshacker.
  const sweepIds = useMemo(
    () =>
      mergedRaw
        .filter(
          (fi) =>
            inViewIds.has(fi.item.id) && !ds.stateStore.get(fi.item.id).pinned,
        )
        .map((fi) => fi.item.id),
    [mergedRaw, inViewIds, ds],
  );

  // Visual "whoosh" when Sweep fires: every fully-visible, unpinned row plays
  // the slide+fade animation together, then the hide commits once the
  // animation ends. The commit is driven by the first `animationend` that
  // bubbles up from the swept `<li>` (so JS follows whatever duration the CSS
  // defines), with a fallback timer at 2× SWEEP_ANIMATION_MS in case the
  // event never fires — background-tab throttling, jsdom not synthesizing
  // animation events, an offscreen row whose animation the browser optimizes
  // out, etc.
  const [sweepingIds, setSweepingIds] = useState<ReadonlySet<ItemId>>(
    () => new Set(),
  );
  const sweepFallbackTimerRef = useRef<number | null>(null);
  // Set for SWEEP_COOLDOWN_MS after a sweep commits; a non-null timer means a
  // sweep just settled and a rapid follow-up tap should be ignored.
  const sweepCooldownTimerRef = useRef<number | null>(null);
  const beginSweepCooldown = useCallback(() => {
    if (sweepCooldownTimerRef.current != null) {
      window.clearTimeout(sweepCooldownTimerRef.current);
    }
    sweepCooldownTimerRef.current = window.setTimeout(() => {
      sweepCooldownTimerRef.current = null;
    }, SWEEP_COOLDOWN_MS);
  }, []);
  // Mirror hideMany into a ref so the unmount cleanup below can commit a
  // pending hide synchronously without re-subscribing the cleanup every
  // render (hideMany identity is the DataSource's, stable in practice but
  // we don't want to depend on that).
  const hideManyRef = useRef(ds.stateStore.hideMany.bind(ds.stateStore));
  useEffect(() => {
    hideManyRef.current = ds.stateStore.hideMany.bind(ds.stateStore);
  }, [ds]);

  // The list body's height lock (see the useLayoutEffect near the bottom of the
  // component). Declared here, above commitSweep, because Sweep has to grab the
  // height BEFORE it removes any rows — see `lockBodyHeight` below.
  const bodyRef = useRef<HTMLDivElement>(null);
  const heightLockedRef = useRef(false);
  // Freeze the body at its current rendered height. Idempotent: a no-op if the
  // lock is already held (so a sweep landing mid-refresh doesn't re-measure at a
  // momentarily-shrunken height). The matching release lives in the
  // isRefreshing-driven layout effect below.
  //
  // Sweep must call this *before* hideMany hides its rows. Unlike a pin/dismiss
  // — which leaves the row in place and only shrinks the document later, during
  // the sequential page refetch — Sweep drops its rows from `visibleItems`
  // synchronously, in the very same commit that the feed invalidation flips
  // `isRefreshing` true. So the layout effect, which measures only on that flip,
  // would read the already-shrunken height and freeze the document too short,
  // letting the browser clamp scrollY toward the top (the reported jump, worst
  // with a whole grouped section swept at once and short collapsed sections).
  // Measuring here, while the swept rows are still in layout, captures the real
  // pre-sweep height.
  const lockBodyHeight = useCallback(() => {
    const el = bodyRef.current;
    if (!el || heightLockedRef.current) return;
    el.style.minHeight = `${el.offsetHeight}px`;
    heightLockedRef.current = true;
  }, []);

  const commitSweep = useCallback(() => {
    const ids = sweepPendingIdsRef.current;
    if (!ids) return;
    sweepPendingIdsRef.current = null;
    if (sweepFallbackTimerRef.current != null) {
      window.clearTimeout(sweepFallbackTimerRef.current);
      sweepFallbackTimerRef.current = null;
    }
    // Capture the height while the swept rows are still on screen, then hide.
    lockBodyHeight();
    ds.stateStore.hideMany(ids);
    // Sweep consolidates: in-body pins snap into the top block (SPEC.md).
    setStayInBodyIds(new Set());
    setSweepingIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    beginSweepCooldown();
  }, [ds, beginSweepCooldown, lockBodyHeight]);

  // If the list unmounts (route change, etc.) while a sweep is still
  // animating, commit the hide synchronously so the user's tap isn't dropped.
  useEffect(() => {
    return () => {
      const ids = sweepPendingIdsRef.current;
      if (ids) {
        hideManyRef.current(ids);
        sweepPendingIdsRef.current = null;
      }
      if (sweepFallbackTimerRef.current != null) {
        window.clearTimeout(sweepFallbackTimerRef.current);
        sweepFallbackTimerRef.current = null;
      }
      if (sweepCooldownTimerRef.current != null) {
        window.clearTimeout(sweepCooldownTimerRef.current);
        sweepCooldownTimerRef.current = null;
      }
    };
  }, []);

  // Animate + commit a hide for a given id set. Shared by the toolbar's
  // "Sweep all visible" and each group header's per-feed Sweep — both dismiss a
  // batch of fully-visible unpinned rows, differing only in which rows.
  const sweepThese = useCallback(
    (ids: ItemId[]) => {
      if (ids.length === 0) return;
      // Ignore taps while a sweep is already playing out (the second batch
      // would be stale — hiddenIds hasn't updated yet) or while the brief
      // post-commit cooldown is still active, so a rapid follow-up tap can't
      // immediately re-sweep a section that just refilled.
      if (
        sweepPendingIdsRef.current !== null ||
        sweepCooldownTimerRef.current !== null
      )
        return;
      const batch = ids.slice();
      const reducedMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reducedMotion) {
        // No animation to wait on, so the rows leave immediately — grab the
        // height first, same as the animated commitSweep path does.
        lockBodyHeight();
        ds.stateStore.hideMany(batch);
        // Sweep consolidates: in-body pins snap into the top block (SPEC.md).
        setStayInBodyIds(new Set());
        beginSweepCooldown();
        return;
      }
      sweepPendingIdsRef.current = batch;
      setSweepingIds((prev) => {
        const next = new Set(prev);
        for (const id of batch) next.add(id);
        return next;
      });
      sweepFallbackTimerRef.current = window.setTimeout(
        commitSweep,
        SWEEP_ANIMATION_MS * 2,
      );
    },
    [ds, commitSweep, beginSweepCooldown, lockBodyHeight],
  );

  const handleSweep = useCallback(
    () => sweepThese(sweepIds),
    [sweepThese, sweepIds],
  );

  // Per-feed sweepable rows (group-by-feed header Sweep): the fully-visible,
  // unpinned rows of each feed, so a header's broom dismisses just that feed's
  // on-screen items. Same shielding as the global Sweep (pinned rows excluded,
  // off-screen rows untouched), just partitioned by feed — sweeping must never
  // touch an article the reader can't currently see (SPEC.md *Section header
  // controls*). Rows in a collapsed section aren't in the DOM, so they're absent
  // from `inViewIds` and excluded for free.
  const sweepableByFeed = useMemo(() => {
    const m = new Map<FeedId, ItemId[]>();
    for (const fi of mergedRaw) {
      if (!inViewIds.has(fi.item.id)) continue;
      if (ds.stateStore.get(fi.item.id).pinned) continue;
      const arr = m.get(fi.item.feedId);
      if (arr) arr.push(fi.item.id);
      else m.set(fi.item.feedId, [fi.item.id]);
    }
    return m;
  }, [mergedRaw, inViewIds, ds]);

  const handleSweepFeed = useCallback(
    (feedId: FeedId) => sweepThese(sweepableByFeed.get(feedId) ?? []),
    [sweepThese, sweepableByFeed],
  );

  // Drives the header Undo buttons — the same single-level global undo the
  // toolbar uses (restore the last hide/swipe/sweep batch).
  const canUndo = useSyncExternalStore(
    (cb) => ds.stateStore.subscribe(cb),
    () => ds.stateStore.canUndo(),
    () => ds.stateStore.canUndo(),
  );
  const handleUndo = useCallback(() => ds.stateStore.undoLast(), [ds]);

  // The first `animationend` from a swept row drives the commit — every `<li>`
  // animates with the same duration, so one signal is enough. Filter by
  // animationName so an unrelated descendant animation can't trigger it.
  const handleListAnimationEnd = useCallback(
    (e: ReactAnimationEvent<HTMLUListElement>) => {
      if (e.animationName !== 'item-list__sweep-out') return;
      commitSweep();
    },
    [commitSweep],
  );

  useEffect(() => {
    registerSweep(handleSweep, sweepIds.length);
    return () => registerSweep(null, 0);
  }, [registerSweep, handleSweep, sweepIds.length]);

  // Group-by-feed headers: the DataSource returns the list fully sectioned by
  // feed (each feed's pinned items at the top of its own section, sections in the
  // user's custom subscription order), so the rows are contiguous by feed and a
  // header belongs before the first row of each feed run — pinned or not. Keyed
  // by item id so ItemRows can drop the header in without threading positions.
  // Recomputed as pages append; the sectioning holds across pages, so a run can
  // span a page break.
  // Headers and feed-ids must follow the same visibleItems list ItemRows
  // renders — if a locally-Done row was the first of its feed section in
  // the cached `items`, keying the header off `items` would attach it to a
  // row that no longer exists, leaving the surviving rows of that feed
  // without their section header until a successful refetch.
  const groupHeaders = useMemo(() => {
    if (!groupByFeed) return undefined;
    const headers = new Map<ItemId, { feedId: FeedId; title: string }>();
    let lastFeedId: FeedId | null = null;
    for (const fi of visibleItems) {
      if (fi.item.feedId !== lastFeedId) {
        headers.set(fi.item.id, { feedId: fi.item.feedId, title: fi.feed.title });
        lastFeedId = fi.item.feedId;
      }
    }
    return headers;
  }, [groupByFeed, visibleItems]);

  // "Collapse all" / "Expand all" in the top toolbar act on the feeds currently
  // in view — the distinct feed ids across the loaded pages, in order.
  const feedIdsInView = useMemo(() => {
    if (!groupByFeed) return [] as FeedId[];
    const seen = new Set<FeedId>();
    const out: FeedId[] = [];
    for (const fi of visibleItems) {
      if (!seen.has(fi.item.feedId)) {
        seen.add(fi.item.feedId);
        out.push(fi.item.feedId);
      }
    }
    return out;
  }, [groupByFeed, visibleItems]);

  // Per-feed unread/to-do counts for the section-header badges (group-by-feed
  // only). Keyed under ['feed', …] so the app-wide feed invalidation
  // (useFeedInvalidation, fired on every item-state change) refreshes the badges
  // when you sweep / open / mark done, alongside the list itself. The server
  // count lags a just-applied local write by one sync cycle; it self-heals on
  // that refetch. Disabled outside the grouped view (no headers to badge).
  const { data: unreadCounts } = useQuery({
    queryKey: ['feed', 'unread-counts', feedIdsInView.join(',')],
    queryFn: () => ds.getFeedUnreadCounts(feedIdsInView),
    enabled: groupByFeed && feedIdsInView.length > 0,
  });

  // The badge above is a server-only count, so it lags local triage by a sync
  // round-trip — right after a Sweep it would still read its pre-sweep value
  // while the rows are already gone. Discount the rows the user just took out of
  // the unread set whose write is still pending (unsynced); the adjustment
  // self-clears as writes drain. `storeVersion` (bumped on every local mutation
  // and on outbox drain via notifySynced) keys the recompute. No-op on the mock,
  // which has no outbox and whose count is never stale.
  //
  // Known residual: a server *count* can't be reconciled atomically with local
  // triage, so a sub-second blip survives at sync-completion — the pending id
  // drains at write-confirm, one round-trip before the invalidated count refetch
  // returns, so the badge briefly reads the stale count before settling. This
  // removes the multi-second post-sweep lag, not that final blip; the exact fix
  // is the `feed_unread_ids` ID-list RPC (TODO.md §Server RPCs).
  const adjustedUnreadCounts = useMemo(() => {
    if (!groupByFeed || !unreadCounts) return unreadCounts;
    void storeVersion;
    return adjustUnreadCounts(
      unreadCounts,
      mergedRaw,
      (id) => ds.stateStore.get(id),
      ds.pendingItemIds?.(),
    );
  }, [groupByFeed, unreadCounts, mergedRaw, ds, storeVersion]);

  // The group-by-feed toggle rides the top toolbar on multi-feed views (the
  // page wires `onToggleGroupByFeed`); single-feed views leave it undefined so
  // the button doesn't render where grouping would be a no-op.
  const groupControl = onToggleGroupByFeed
    ? { groupByFeed, onToggle: onToggleGroupByFeed }
    : undefined;
  // The sort toggle rides every feed view (sort applies even to a single feed),
  // so it's wired independently of grouping.
  const sortControl = onToggleSort
    ? { itemSort, onToggle: onToggleSort }
    : undefined;

  const collapseControls =
    groupByFeed && feedIdsInView.length > 0
      ? {
          onCollapseAll: () => collapseAll(feedIdsInView),
          onExpandAll: () => expand(feedIdsInView),
          allCollapsed: feedIdsInView.every((id) => collapsed.has(id)),
          anyCollapsed: feedIdsInView.some((id) => collapsed.has(id)),
        }
      : undefined;

  // Force a confirming refetch when we come back online with nothing to show.
  // The miss-state guard below keys off the *current* status, but on the
  // offline→online transition `status` flips to 'online' while React Query can
  // still treat a just-returned empty page (served from a stale cache or a
  // fresh-enough persisted query while offline) as fresh under the 5-min
  // staleTime — so it wouldn't refetch on its own, and the caught-up label would
  // render off that unconfirmed empty result. Refetch (which ignores staleTime)
  // to confirm against the live server. Skip it when a request is already in
  // flight (e.g. the user's Retry, whose recovering response is what flipped
  // status to 'online' before React Query resolved the page) — that one is the
  // confirming fetch, and a second refetch over the cached empty data could
  // cancel/duplicate it. The loading hold while any such fetch is in flight is
  // driven by `isFetching` at the ItemRows call below, so it isn't reconnect-
  // specific — it also covers a boot-time cache-invalidation refetch over an
  // empty persisted page, where there's no offline→online transition.
  const prevStatus = useRef(status);
  useEffect(() => {
    const wasOnline = prevStatus.current === 'online';
    prevStatus.current = status;
    if (status === 'online' && !wasOnline && items.length === 0 && !isFetching) {
      refetch();
    }
  }, [status, isFetching, items.length, refetch]);

  // When to show the miss-state (offline/server message + Retry) instead of the
  // item rows. Two of these are failures we already know about: the initial
  // load errored, or a background refetch over an empty cache failed. The third
  // covers a *successful* empty result we can't trust: an empty feed while the
  // device is offline or the backend is unreachable isn't proof the reader is
  // caught up — we just couldn't confirm with the server (a fresh-enough
  // persisted-empty cache that skips the refetch, or a stale cache answering
  // empty). Claiming "You're all caught up." there is a lie; show the
  // connectivity copy instead. Online + empty is a genuine caught-up state.
  // Key off visibleItems, not raw items: when the local Done/Hidden overlay
  // (the swipe-right / Sweep client-side filter above) empties the rendered
  // list while the device is offline or a background refresh failed, the
  // user can't confirm with the server that they're actually caught up.
  // Claiming "You're all caught up" on visibleItems=[] there is the same
  // lie the existing offline-empty guard catches for items=[]; using
  // visibleItems unifies the two paths. Sweep + offline now surfaces the
  // connectivity copy instead of a false caught-up claim.
  const showMissState =
    isError ||
    (refreshFailed && visibleItems.length === 0) ||
    (!isLoading && visibleItems.length === 0 && status !== 'online');

  // Freeze the list body's height for the duration of a background refresh so
  // the window scroll can't be yanked to the top under the reader.
  //
  // React Query refetches an infinite query's pages *sequentially*, replacing
  // the data as it goes, so the rendered list briefly shrinks while each loaded
  // page is re-requested (a pin/dismiss invalidates ['feed'] via
  // useFeedInvalidation, kicking off exactly this multi-page refetch). On the
  // real backend that takes a second or two; during it the document gets
  // shorter than the current scroll offset and the browser clamps window
  // scrollY toward 0 — so a few seconds after pinning/dismissing, the page jumps
  // to the top. Group-by-feed with collapsed sections makes it worse: collapsed
  // feeds render only a short header, so the document is already short and the
  // clamp lands right at the top. Holding a min-height equal to the pre-refresh
  // height keeps the document tall enough that scrollY is never clamped; the
  // lock is released once the refresh settles, and native scroll anchoring
  // absorbs the small final height delta. `isRefreshing` excludes the
  // next-page fetch (which legitimately grows the list), so paging is unaffected.
  //
  // This effect both takes the lock (on the isRefreshing→true edge) and releases
  // it (on isRefreshing→false). Sweep is the exception that can't wait for the
  // edge: it drops rows synchronously in the same commit the refetch starts, so
  // it grabs the height itself via lockBodyHeight() (declared above, before
  // commitSweep) while the rows are still on screen. When that's already
  // happened, the `!heightLockedRef.current` guard makes the take below a no-op
  // and this effect just handles the release. (bodyRef / heightLockedRef are
  // declared above so the sweep path can share them.)
  //
  // `showMissState` is a dependency because the body can *unmount* while the
  // lock is held: a Sweep that empties the list while offline (or after a failed
  // refetch) flips showMissState, replacing `.item-list__body` with the
  // load-error panel right after lockBodyHeight() took the lock. The lock died
  // with that element, so when the body is absent we drop the flag — otherwise a
  // stale `heightLockedRef === true` would make the next remount's refresh skip
  // the lock entirely and reintroduce the very jump this guards against.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) {
      heightLockedRef.current = false;
      return;
    }
    if (isRefreshing && !heightLockedRef.current) {
      el.style.minHeight = `${el.offsetHeight}px`;
      heightLockedRef.current = true;
    } else if (!isRefreshing && heightLockedRef.current) {
      el.style.minHeight = '';
      heightLockedRef.current = false;
    }
  }, [isRefreshing, showMissState]);

  // Backstop release for the sweep pre-lock. lockBodyHeight() takes the lock
  // synchronously at sweep time and relies on a background refresh to drive the
  // release (the layout effect above, on the isRefreshing→false edge). But that
  // refresh might never start: when the reader is offline and sweeps only PART
  // of the list, React Query's invalidated refetch is paused (isRefreshing never
  // flips) and — because rows remain — `showMissState` stays false, so the
  // layout effect never re-runs. The body would then keep its pre-sweep
  // min-height forever: a persistent blank tail below the surviving rows. This
  // post-paint effect lets a held lock go once nothing is actually refreshing,
  // so the document settles to its natural height. It's a no-op online, where
  // isRefreshing is held true across the bridging refetch (the layout effect
  // still owns that release), and re-runs after a sweep via `visibleItems`.
  useEffect(() => {
    if (!isRefreshing && heightLockedRef.current && bodyRef.current) {
      bodyRef.current.style.minHeight = '';
      heightLockedRef.current = false;
    }
  }, [isRefreshing, visibleItems.length]);

  return (
    <div
      className="item-list"
      // Pin group-by-feed section headers below the measured top chrome. Set
      // only while grouping (the headers exist) and once measured (>0), so other
      // views and first paint fall back to the CSS default in ItemList.css.
      style={
        groupByFeed && topChromeHeight > 0
          ? ({ '--rm-group-sticky-top': `${topChromeHeight}px` } as CSSProperties)
          : undefined
      }
    >
      <ListToolbar
        collapse={collapseControls}
        group={groupControl}
        sort={sortControl}
      />

      <PullToRefresh
        onRefresh={async () => {
          await ds.refresh();
          // React Query's `refetch()` resolves with the new result rather
          // than throwing on error, so a failed refresh would otherwise
          // proceed to clear sticky/extras against the stale cached page —
          // collapsing an expanded section back to its initial window
          // without any fresh data to anchor it. Gate the reset on a
          // successful result so a failed PTR is a no-op (the strip's own
          // error UI surfaces the failure to the user).
          const res = await refetch();
          if (res.isError || res.error) {
            await checkForServiceWorkerUpdate();
            return;
          }
          // Drop the sticky display window AFTER the fresh page lands in the
          // query cache, so the next render sees the new `items[]` and the
          // sticky-init effect repopulates the per-feed sets from the fresh
          // top rows. Clearing it before `refetch()` resolves would let one
          // render commit against the stale page and re-anchor the sticky
          // sets to the rows we're trying to refresh away from — the init
          // effect's `cur.has(feedId)` guard would then keep the section
          // anchored on the stale ids even after the fresh data arrived.
          // Section extras reset too so we don't re-merge an old offset
          // against the new base window.
          setDisplayedByFeed(new Map());
          setFeedExtras(new Map());
          // A pull-to-refresh consolidates: in-session pins re-group at the top.
          setStayInBodyIds(new Set());
          await checkForServiceWorkerUpdate();
        }}
      >
        {showMissState ? (
          // Copy is a function of BOTH the connectivity status and the actual
          // read error — not status alone. A reachable read that errored is a
          // server problem to name (with a curated detail), not the connection
          // to blame; only a truly unreachable backend gets "isn't responding".
          (() => {
            const { headline, detail } = loadFailureCopy(status, error, {
              action: 'fetching the feed list',
              noun: 'items',
            });
            return (
              <LoadError headline={headline} detail={detail} onRetry={() => refetch()} />
            );
          })()
        ) : (
          <div className="item-list__body" data-testid="item-list-body" ref={bodyRef}>
            {/* Onboarding hint sits above the rows, but only once items exist —
                there's nothing to pin under skeletons or an empty feed. */}
            {items.length > 0 ? (
              <PromoBar id="pin-to-download">
                Pin an article to download it
              </PromoBar>
            ) : null}
            <ItemRows
              items={visibleItems}
              sweepingIds={sweepingIds}
              onAnimationEnd={handleListAnimationEnd}
              // Skeletons (not the caught-up label) whenever a fetch is
              // validating an empty feed — the initial load, a reconnect
              // confirm, a boot-time cache-invalidation refetch over an empty
              // persisted page, or a focus/PTR refresh. Also covers the
              // post-overlay case: a swipe/Sweep that empties the rendered
              // list while an invalidating refetch is in flight — keying off
              // visibleItems holds the loading state instead of flashing the
              // empty label off an unconfirmed cache. An empty result isn't
              // trustworthy as "all caught up" until the in-flight read that
              // could populate it (or fail and surface the miss-state) settles.
              isLoading={
                isLoading ||
                (isFetching &&
                  visibleItems.length === 0 &&
                  !(emptyMoreSections && emptyMoreSections.length > 0))
              }
              skeletonCount={6}
              enableSwipe
              listRef={listRef}
              getRowRef={getRowRef}
              groupHeaders={groupHeaders}
              groupCounts={groupByFeed ? adjustedUnreadCounts : undefined}
              onSweepFeed={groupByFeed ? handleSweepFeed : undefined}
              sweepableFeeds={
                groupByFeed ? new Set(sweepableByFeed.keys()) : undefined
              }
              onUndo={groupByFeed ? handleUndo : undefined}
              canUndo={groupByFeed ? canUndo : undefined}
              collapsedFeeds={groupByFeed ? collapsed : undefined}
              onToggleCollapse={groupByFeed ? toggle : undefined}
              feedsWithMore={perGroupMore ? feedsWithMore : undefined}
              loadingFeeds={perGroupMore ? loadingFeeds : undefined}
              onFeedMore={perGroupMore ? handleFeedMore : undefined}
              emptyMoreSections={perGroupMore ? emptyMoreSections : undefined}
              feedRank={perGroupMore ? feedRank : undefined}
              emptyLabel={emptyLabel ?? 'Nothing here yet.'}
            />
          </div>
        )}
      </PullToRefresh>

      {/* Background-refresh status strip — only when rows are already on
          screen (SPEC.md *Feed views → Background refresh status strip*). */}
      {items.length > 0 && isRefreshing ? (
        <div className="item-list__refresh" role="status">
          Checking for new items…
        </div>
      ) : null}
      {items.length > 0 && refreshFailed ? (
        <div className="item-list__refresh item-list__refresh--error" role="alert">
          Couldn’t refresh.{' '}
          <button type="button" onClick={() => refetch()}>
            Retry
          </button>
          {/* Rows are still showing (this is a background-refresh failure), so
              keep it to one line — but tuck the curated cause behind a
              disclosure so it's reachable on mobile too. */}
          {presentableDetail(error) ? (
            <details className="item-list__refresh-details">
              <summary>Details</summary>
              <p>{presentableDetail(error)}</p>
            </details>
          ) : null}
        </div>
      ) : null}

      <ListToolbar
        placement="bottom"
        // Only offer More once the feed is populated. Until the first page
        // lands (loading skeletons, error/retry, or an empty result) hasMore is
        // false, so an unconditional More would flash a disabled "No more items"
        // under the skeletons or retry UI even though the feed isn't actually
        // exhausted. Matches newshacker, whose footer renders only on a
        // populated feed.
        more={
          // In the per-section-windowed grouped view the base read is normally a
          // single page (each section pages itself via its own foot "More"), so
          // the global pager is suppressed and only Back to top remains. The one
          // exception: if the windowed read overflowed the row cap (`hasMore`),
          // the bottom "More" reappears to load the next batch of feed-sections,
          // so the later feeds aren't stranded.
          (!perGroupMore || hasMore) && items.length > 0
            ? {
                // Pinned bar: enabled while there's anything left to reveal —
                // unseen loaded rows below the fold, or another fetchable page.
                // Relative bar: "More" only fetches, so it tracks hasMore alone.
                canAdvance: pinnedBar ? !atListEnd || hasMore : hasMore,
                isFetching: isFetchingMore,
                onMore: handleMore,
              }
            : undefined
        }
      />
    </div>
  );
}
