import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useConnectivityStatus } from '../hooks/useOnlineStatus';
import { useFeedItems, type FetchPage } from '../hooks/useFeedItems';
import { useInViewIds } from '../hooks/useInViewIds';
import { useHideOnScroll, useBottomBarPosition } from '../hooks/useReadingPrefs';
import { useCollapsedFeeds } from '../hooks/useCollapsedFeeds';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import type { FeedId, FeedItem, ItemId } from '../lib/types';
import { measureStickyBottomInset, measureTopChromeHeight } from '../lib/stickyInset';
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
}

/** A feed view (home / folder / single feed): sticky toolbar, item rows with
 * swipe, an explicit "More" button, and the background-refresh status strip. */
export function ItemList({ viewKey, fetchPage, emptyLabel, groupByFeed = false }: Props) {
  const ds = useDataSource();
  const status = useConnectivityStatus();
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
  const [, bumpStoreVersion] = useReducer((x: number) => x + 1, 0);
  useEffect(
    () => ds.stateStore.subscribe(bumpStoreVersion),
    [ds],
  );
  const visibleItems = items.filter((fi) => {
    const st = ds.stateStore.get(fi.item.id);
    return !st.done && !st.hidden;
  });

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
      items
        .filter(
          (fi) =>
            inViewIds.has(fi.item.id) && !ds.stateStore.get(fi.item.id).pinned,
        )
        .map((fi) => fi.item.id),
    [items, inViewIds, ds],
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
  // Mirror hideMany into a ref so the unmount cleanup below can commit a
  // pending hide synchronously without re-subscribing the cleanup every
  // render (hideMany identity is the DataSource's, stable in practice but
  // we don't want to depend on that).
  const hideManyRef = useRef(ds.stateStore.hideMany.bind(ds.stateStore));
  useEffect(() => {
    hideManyRef.current = ds.stateStore.hideMany.bind(ds.stateStore);
  }, [ds]);

  const commitSweep = useCallback(() => {
    const ids = sweepPendingIdsRef.current;
    if (!ids) return;
    sweepPendingIdsRef.current = null;
    if (sweepFallbackTimerRef.current != null) {
      window.clearTimeout(sweepFallbackTimerRef.current);
      sweepFallbackTimerRef.current = null;
    }
    ds.stateStore.hideMany(ids);
    setSweepingIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, [ds]);

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
    };
  }, []);

  const handleSweep = useCallback(() => {
    if (sweepIds.length === 0) return;
    // Ignore repeat taps while a sweep is already playing out — the second
    // batch would be identical (hiddenIds hasn't updated yet).
    if (sweepPendingIdsRef.current !== null) return;
    const ids = sweepIds.slice();
    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      ds.stateStore.hideMany(ids);
      return;
    }
    sweepPendingIdsRef.current = ids;
    setSweepingIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    sweepFallbackTimerRef.current = window.setTimeout(
      commitSweep,
      SWEEP_ANIMATION_MS * 2,
    );
  }, [sweepIds, ds, commitSweep]);

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
  const bodyRef = useRef<HTMLDivElement>(null);
  const heightLockedRef = useRef(false);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (isRefreshing && !heightLockedRef.current) {
      el.style.minHeight = `${el.offsetHeight}px`;
      heightLockedRef.current = true;
    } else if (!isRefreshing && heightLockedRef.current) {
      el.style.minHeight = '';
      heightLockedRef.current = false;
    }
  }, [isRefreshing]);

  return (
    <div className="item-list">
      <ListToolbar collapse={collapseControls} />

      <PullToRefresh onRefresh={async () => { await ds.refresh(); await refetch(); await checkForServiceWorkerUpdate(); }}>
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
              isLoading={isLoading || (isFetching && visibleItems.length === 0)}
              skeletonCount={6}
              enableSwipe
              listRef={listRef}
              getRowRef={getRowRef}
              groupHeaders={groupHeaders}
              groupCounts={groupByFeed ? unreadCounts : undefined}
              collapsedFeeds={groupByFeed ? collapsed : undefined}
              onToggleCollapse={groupByFeed ? toggle : undefined}
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
          items.length > 0
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
