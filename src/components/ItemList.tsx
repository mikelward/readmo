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
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useConnectivityStatus } from '../hooks/useOnlineStatus';
import { useFeedItems, dedupeFeedPages, type FetchPage } from '../hooks/useFeedItems';
import type { ItemSort, Page } from '../lib/data/DataSource';
import { useInViewIds } from '../hooks/useInViewIds';
import { useHideOnScroll, useBottomBarPosition } from '../hooks/useReadingPrefs';
import { useCollapsedFeeds } from '../hooks/useCollapsedFeeds';
import { useTopChromeHeight } from '../hooks/useTopChromeHeight';
import { useNewshackerLink } from '../hooks/useNewshackerLink';
import { clearAllReverseSyncPending } from '../lib/newshackerReverseSyncPending';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import type { FeedId, FeedItem, ItemId } from '../lib/types';
import { placeStayInBodyPins } from '../lib/feedOrder';
import { measureStickyBottomInset, measureTopChromeHeight } from '../lib/stickyInset';
import { UnreadDecrementLedger } from '../lib/unreadAdjust';
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

// How long the viewport must be still — no finger on the glass, no scroll
// events arriving — before a buffered auto-hide batch commits. Scroll events
// during a drag, a wheel burst, or a post-flick momentum glide arrive at frame
// cadence (~16ms even at the tail), so a 200ms quiet window means the motion
// has genuinely ended rather than paused between frames, while staying short
// enough that the dismissal still feels immediate once the reader stops.
const SCROLL_SETTLE_MS = 200;

// Stand-in pending set for sources without an outbox (`pendingItemIds`
// optional — the mock's store is authoritative, nothing is ever un-synced).
const EMPTY_ID_SET: ReadonlySet<ItemId> = new Set();

// How far below the top sticky chrome a release-time scroll anchor must sit so
// the auto-hide cascade can't sweep the anchor row itself (see
// captureExitTopAnchor). One row's worth — comfortably past the sweep line and
// any pinned group header, while still picking a row near the top of what the
// reader is looking at.
const ANCHOR_SAFE_MARGIN_PX = 56;

// Toggle the browser's scroll anchoring on the list body while a release-time
// scroll pin is active (see captureExitTopAnchor / the restore layout effect).
function setBodyOverflowAnchor(value: '' | 'none'): void {
  if (typeof document === 'undefined') return;
  const body = document.querySelector('.item-list__body');
  if (body instanceof HTMLElement) body.style.overflowAnchor = value;
}

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

// Animation frames the no-refetch height freeze is held past the row-removal
// commit before it's released. A dismiss (a lone Done or a Sweep) triggers a
// momentary, self-inflicted document collapse: the list reflows and briefly
// reports a far shorter height, recovering within ~2 frames. Releasing the
// freeze on the removal commit — before that dip bottoms out — leaves the
// collapse unguarded, so the browser clamps window.scrollY toward the top and
// the clamped offset sticks once the height recovers (the jump-to-top after a
// dismiss). Holding the min-height across these frames keeps the document tall
// the whole time, so the offset is never clamped. Kept generous enough to clear
// the dip on a 60Hz display; releaseBodyHeight still restores the offset if a
// frame lands mid-collapse, so the exact count isn't load-bearing.
const DISMISS_SETTLE_FRAMES = 4;

// How long (ms) after a dismiss to keep watching for a transient-viewport clamp
// and restore the reader's offset. The dynamic-toolbar innerHeight spike that
// clamps the scroll (see the settle effect) fires-and-reverts on the browser's
// own clock, NOT ours: on a real device the spike is often gone before the
// passive-effect rAF settle even starts sampling (its `scroll`/`resize` events
// beat our first frame), and the revert that re-grows the ceiling can lag the
// 4-frame release by 50–100 ms. So the settle ALSO listens to the real
// scroll/resize events for this whole window — that's what actually catches the
// clamp in real time and restores once the viewport recovers. Bounded so a
// genuine later scroll/resize is never second-guessed as a clamp.
const VIEWPORT_CLAMP_RESTORE_MS = 600;

// How many times taller than the real visible height `window.innerHeight` must
// read before we treat it as the bogus dynamic-toolbar SPIKE. The observed glitch
// reports a ~DOUBLED innerHeight (e.g. 816 → 1632, ~2×) while
// `visualViewport.height` — the actually-visible area — stays put. A *ratio* gate
// (not an absolute px one) is essential: on mobile `innerHeight` is often the
// large, toolbar-retracted layout viewport while `visualViewport.height` reflects
// the URL-bar-occluded visible area, a legitimate gap that can be 60–100 px at
// scale 1 — so an absolute px threshold would flag ordinary browser chrome as a
// spike (Codex P2 on #402).
//
// The threshold has to thread two things that sit surprisingly close: ordinary
// browser chrome (~10–20% of the viewport → ≤ ~1.25×) must read as honest, while
// the bogus spike — which RAMPS through intermediate steps before its peak
// (816 → 1125 → 1218 → 1632 = 1.38× → 1.49× → 2×) — must be caught from its FIRST
// step, or the tracker records a progressively-clamped offset and the restore
// target is already wrong by the peak (Codex P2 on #402). 1.35× sits just under
// that first ramp step and clear of ordinary chrome.
const VIEWPORT_SPIKE_RATIO = 1.35;

// How tall the spike can peak, as a multiple of the true visible height — used to
// size the freeze DEFENSIVELY so the spike can never clamp the reader in the first
// place (rather than only restoring them after it does). The observed glitch peaks
// at ~2× (816 → 1632), so freezing the document tall enough to hold the reader's
// offset even under a doubled `innerHeight` (maxScroll = scrollHeight − innerHeight)
// keeps `scrollY` off the clamp. A device that spikes beyond this still falls back
// to the reactive restore, so this is a floor on robustness, not the only guard.
const VIEWPORT_SPIKE_PEAK_RATIO = 2;

// The layout-viewport height the clamp math actually uses
// (`maxScroll = scrollHeight − window.innerHeight`), and the height the dynamic-
// toolbar spike DOUBLES — so it's the base to multiply by the peak ratio when
// sizing a spike-proof freeze. It must be `window.innerHeight`, NOT the
// URL-bar-occluded `visualViewport.height`: when the URL bar is showing,
// `innerHeight` (e.g. 400) legitimately exceeds the visible height (e.g. 310) yet
// stays under the honesty gate, and the spike inflates `innerHeight` from there —
// so sizing from the smaller visible height under-budgets and lets the clamp fire
// at the bottom despite the freeze (Codex P2 on #405). When `innerHeight` is itself
// already spiking, multiplying the inflated value merely over-provisions (a larger
// off-screen tail that relaxes on release), which is safe; under-provisioning is
// not.
function layoutViewportHeight(): number {
  if (typeof window === 'undefined') return 0;
  return typeof window.innerHeight === 'number' ? window.innerHeight : 0;
}

// Is `window.innerHeight` currently telling the truth? The dynamic-toolbar bug
// momentarily reports a viewport far taller than what's on screen, which slashes
// maxScroll (= scrollHeight − innerHeight) and clamps the scroll toward the top.
// `visualViewport.height` is the real visible height and does NOT lie during the
// glitch, so `innerHeight` reading a large MULTIPLE of it means innerHeight is
// spiking. When the visualViewport API is absent (jsdom/SSR/old browsers) we
// can't tell, so treat the viewport as honest — the restore then simply never
// arms, same as before.
//
// Pinch-zoom is the important exception: while the reader is zoomed
// (`scale !== 1`) the visual viewport is LEGITIMATELY much shorter than the layout
// `innerHeight`, and that mismatch is not a toolbar spike. Reading it as one would
// stop the position tracker and could seed a restore that snaps to a stale
// pre-zoom offset when the reader zooms back out (Codex P2 on #402). The bug only
// occurs at scale 1, so only compare heights there; any zoomed state is treated as
// honest (spike detection is simply disabled — inert, like the no-API fallback).
function viewportIsHonest(): boolean {
  if (typeof window === 'undefined') return true;
  const vv = window.visualViewport;
  if (!vv || vv.height <= 0) return true;
  if (Math.abs(vv.scale - 1) > 0.01) return true;
  return window.innerHeight <= vv.height * VIEWPORT_SPIKE_RATIO;
}

/** Is the row with this id currently intersecting the visible band (viewport
 * minus the sticky chrome)? Read straight from the DOM as a fallback for the
 * cross-device "dismiss in place" decision during the brief window after first
 * paint before the IntersectionObserver delivers its initial entries — a resync
 * landing in that gap must still gray a row the reader can already see, not
 * remove it and jump the list (Codex P2 on #416). An absent element (a row that
 * entered already-dismissed and was never rendered live) reads as off screen, so
 * it stays filtered out. Only consulted for a dismissed row the observer's live
 * set doesn't already cover, so the layout read is off the common path. */
function rowIntersectsViewport(id: ItemId): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  const el = document.querySelector(`li[data-item-id="${id}"]`);
  if (!(el instanceof HTMLElement)) return false;
  const rect = el.getBoundingClientRect();
  const top = measureTopChromeHeight();
  const bottom = window.innerHeight - measureStickyBottomInset();
  return rect.bottom > top && rect.top < bottom;
}

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

/** Ordered ids of a grouped feed's fetched-but-unshown body rows: in the
 * feed's `items[]` run, not a load-time pin (pins always render), not locally
 * dismissed unless pinned (the display filter would drop the revealed row and
 * waste its slot in the batch), and not yet in the sticky display window.
 * These are the rows a section "More" reveals instantly — already in hand from
 * the deep base read (which carries everything the server returned for the
 * feed), so no network request and it works offline. Empty until the sticky
 * init has seeded `allowed` (a one-render first-paint gap; the init effect
 * lands immediately after). */
function unshownFetchedBodyIds(
  items: FeedItem[],
  feedId: FeedId,
  allowed: ReadonlySet<ItemId> | undefined,
  basePinned: ReadonlySet<ItemId>,
  showable: (id: ItemId) => boolean,
): ItemId[] {
  if (!allowed) return [];
  const out: ItemId[] = [];
  const seen = new Set<ItemId>();
  for (const fi of items) {
    if (fi.item.feedId !== feedId) continue;
    const id = fi.item.id;
    if (seen.has(id)) continue;
    seen.add(id);
    if (basePinned.has(id)) continue;
    if (allowed.has(id)) continue;
    if (!showable(id)) continue;
    out.push(id);
  }
  return out;
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
  /** The per-feed BODY window size each grouped section OPENS with — how many
   * un-pinned rows show before the section's "More" (pinned rows are exempt and
   * all show). Purely a display window: the base read already carries
   * everything the server returned for each feed, and the section's "More"
   * reveals the next `perFeedLimit` of those fetched rows instantly (no
   * request, works offline) until they're spent — the fetched run IS the feed,
   * so an exhausted section drops its button. Setting this (with groupByFeed)
   * is what enables the per-section More. */
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
  perFeedLimit,
  onToggleGroupByFeed,
  itemSort = 'newest',
  onToggleSort,
}: Props) {
  const ds = useDataSource();
  // Whether this account has linked a newshacker token — gates the reverse
  // pull on pull-to-refresh (below) so we skip the network call when unlinked.
  const { linked: newshackerLinked } = useNewshackerLink();
  // Per-section "More" is live only when the page told us the display window
  // each grouped section opens at (the grouped home/folder reads).
  const perGroupMore = groupByFeed && perFeedLimit != null && perFeedLimit > 0;
  const status = useConnectivityStatus();
  // Offset for the sticky group-by-feed section headers: the combined height of
  // the app header + top toolbar, so a pinned header sits flush under them.
  // Only meaningful (and only applied below) when grouping, where headers exist.
  const topChromeHeight = useTopChromeHeight();
  // Correct the global pager's next-page offset for locally-dismissed rows.
  // Since a mutation no longer refetches, the loaded pages still carry Done/Hidden
  // rows the server has already dropped from its offset-based sequence — so the
  // server's `nextCursor` (an offset) points past the rows that shifted up into
  // it, and a plain "More" would skip them. When any loaded row is dismissed, the
  // correct next offset is the count of *distinct live (non-dismissed) rows* we've
  // loaded: those occupy the first N positions of the server's current sequence,
  // so the next page starts at N. This is an absolute count, not a decrement of
  // the incoming cursor, so it stays stable across successive "More" taps (a
  // decrement re-subtracts the same dismissed rows each time and re-fetches the
  // same page forever — Codex P2 on #376). When nothing is dismissed, defer to the
  // server's cursor so useFeedItems' offset-drift dedup keeps working untouched.
  // Evaluated at fetchNextPage time, so it reads the store fresh when the reader
  // taps "More". (Codex P1 on #375; the per-section "More" path recomputes its own
  // cursor in handleFeedMore.)
  const adjustNextCursor = useCallback(
    (rawCursor: string | null, pages: Array<Page<FeedItem>>): string | null => {
      if (rawCursor == null) return rawCursor;
      const offset = Number.parseInt(rawCursor, 10);
      if (!Number.isFinite(offset)) return rawCursor;
      let dismissed = 0;
      const live = new Set<ItemId>();
      for (const page of pages) {
        for (const fi of page.items) {
          const st = ds.stateStore.get(fi.item.id);
          // A pinned row is live even if it's also Done/Hidden — the server keeps
          // it in its offset sequence (pinned exempt), and the display shows it
          // (see `visibleItems`), so it must count toward the offset, not be
          // subtracted as dismissed.
          if (!st.pinned && (st.done || st.hidden)) dismissed += 1;
          else live.add(fi.item.id);
        }
      }
      return dismissed > 0 ? String(live.size) : rawCursor;
    },
    [ds],
  );
  // Depth of Undo-triggered refetches (declared before the query so the fetch
  // wrapper below can read it at fetch START — see undoRefetch further down).
  const undoRefetchDepth = useRef(0);
  // Latched when a whole-list RE-MATERIALIZING fetch begins: a first-page fetch
  // (cursor null) issued while the list already has data, that isn't an Undo
  // reconcile. That's a stale mount/focus past the 6h TTL, a reconnect confirm,
  // a subscription-change invalidation, or pull-to-refresh — the fetches SPEC
  // says re-materialize the published set. Armed inside the queryFn wrapper (at
  // fetch start) rather than by observing an `isRefreshing` render, which a
  // fast-settling fetch can skip entirely. Consumed by the settle effect below,
  // which re-anchors the sticky display window on the fresh page.
  // Three-state latch: 'inflight' from fetch start, 'landed' once the page
  // promise RESOLVED (so the reset below can't fire against a commit where the
  // fetch status settled but the fresh data hasn't been applied yet — React
  // Query can deliver those in separate batches), back to 'idle' once consumed
  // or on fetch failure.
  const rematerializeRef = useRef<'idle' | 'inflight' | 'landed'>('idle');
  // Monotonic stamp per armed fetch so a superseded fetch that settles LATE
  // (after a newer page-1 fetch armed the latch) can't overwrite the newer
  // fetch's state.
  const rematerializeSeqRef = useRef(0);
  const hasListDataRef = useRef(false);
  const materializingFetchPage = useCallback<FetchPage>(
    (cursor, signal) => {
      if (
        cursor == null &&
        hasListDataRef.current &&
        undoRefetchDepth.current === 0
      ) {
        const token = (rematerializeSeqRef.current += 1);
        rematerializeRef.current = 'inflight';
        return fetchPage(cursor, signal).then(
          (page) => {
            // A CANCELED refetch (superseded — e.g. the global "More" pager
            // cancels an in-flight background refresh by default) can still
            // resolve, but React Query discards its result. Marking that
            // resolution 'landed' would let the settle effect reset the
            // sticky state against data that was never applied (Codex P2 on
            // #432) — only a fetch whose result will be applied lands.
            if (token === rematerializeSeqRef.current) {
              rematerializeRef.current = signal?.aborted ? 'idle' : 'landed';
            }
            return page;
          },
          (err: unknown) => {
            if (token === rematerializeSeqRef.current) {
              rematerializeRef.current = 'idle';
            }
            throw err;
          },
        );
      }
      return fetchPage(cursor, signal);
    },
    [fetchPage],
  );
  const {
    items,
    isLoading,
    isError,
    isFetching,
    hasMore,
    pageCount,
    isFetchingMore,
    fetchMore,
    refetch,
    isRefreshing,
    refreshFailed,
    error,
  } = useFeedItems(viewKey, materializingFetchPage, adjustNextCursor);
  hasListDataRef.current = items.length > 0;

  // A fresh-list fetch (initial load, a stale mount/focus re-materialization, or
  // pull-to-refresh) can reorder the list under the reader, so the render below
  // covers it with a "Refreshing" state that blocks taps (SPEC.md *Feed views →
  // Refreshing*). Undo is the one exception: it restores instantly from the local
  // store overlay and its refetch is only a silent background reconcile (see
  // handleUndoScroll), so it must NOT raise the Refreshing state. The depth of
  // Undo-triggered refetches (declared above the query) lets `showRefreshing`
  // and the re-materialization latch exclude them while PTR / stale-focus
  // refetches still count. The depth is raised BEFORE refetch() (so the fetch
  // wrapper sees it at fetch start) and lowered only after it settles.
  const undoRefetch = useCallback(() => {
    undoRefetchDepth.current += 1;
    const p = refetch();
    void p.finally(() => {
      undoRefetchDepth.current = Math.max(0, undoRefetchDepth.current - 1);
    });
    return p;
  }, [refetch]);

  const queryClient = useQueryClient();
  // Warm this feed's cache when the reader opens on top of it. The feed route
  // unmounts under the reader and remounts on Back, at which point
  // refetchOnMount (true-when-stale) would fire the refetch *then* — landing a
  // reflow a beat later, right as the reader taps a new card. Moving that fetch
  // to article-open runs it while the reader is up (feed not on screen), so the
  // reflow lands off-screen and the Back-remount paints the already-settled
  // list from fresh cache. `stale: true` honors the same staleTime TTL: a feed
  // fetched within the window is left alone (no refetch on open OR Back); only a
  // genuinely stale one refetches, and it does so early. A local mutation no
  // longer marks the feed stale (see useFeedInvalidation), so opening a card
  // right after triaging one doesn't refetch here either. Fire-and-forget: the
  // refetch lands in the cache whether or not this view is still mounted.
  const handleOpenReader = useCallback(() => {
    void queryClient.refetchQueries({ queryKey: ['feed', viewKey], stale: true });
  }, [queryClient, viewKey]);

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
  // The ids of an auto-hide-on-scroll batch for the synchronous window of its
  // hideMany call. The single-dismiss anchor opt-out (the mutation subscription
  // far below) keys off a Done flip but must NOT fire for auto-hide — those
  // rows leave ABOVE the viewport, held steady by the exit-top scroll pin.
  // Flagging the ids here lets that subscription, which runs synchronously
  // inside hideMany, tell an auto-hide Done flip from a reader's in-view
  // mark-done and skip it.
  const autoHideInFlightRef = useRef<Set<ItemId> | null>(null);
  // The reader's scroll anchor across a settle-time top-exit flush: a row under
  // their eyes and where it sits on screen, held there until they next act on
  // the viewport. The browser's own scroll anchoring can't be trusted across
  // this removal — it doesn't exist on iOS/Safari, is suppressed for a beat
  // right after a touch scroll, and even once live it under-compensates for a
  // bulk removal, so the first still-visible row visibly jerks upward, at worst
  // snapping the view to the next feed group — so we pin the row's on-screen
  // position ourselves. Set by commitExitTop; consumed by the restore layout
  // effect; cleared on the next pointer/wheel/key input — or any native scroll
  // we didn't cause (see below).
  const exitTopAnchorRef = useRef<{ id: ItemId; top: number } | null>(null);
  // The scrollY our last correction left behind, so a native `scroll` event can
  // tell our own restoring scrollBy (matches) from the reader's momentum/inertial
  // scroll after a flick (differs) — the latter fires no touch/wheel/key, so it
  // would otherwise keep the pin armed and fight the fling.
  const pinnedScrollYRef = useRef<number | null>(null);
  const captureExitTopAnchor = useCallback((hideIds: Set<ItemId>) => {
    // Clear the top sweep zone by a full row so the chosen anchor can't itself
    // be auto-hidden as the view settles. The release-time collapse pushes more
    // rows under the chrome, and the IntersectionObserver auto-hides them a beat
    // later (the "cascade"); its exit line sits at the *current* sticky-chrome
    // bottom, which in grouped view a pinned section header occludes further.
    // measureTopChromeHeight() is the layout-height sum of the always-present top
    // chrome; adding a row's worth of margin keeps the anchor safely below both
    // the sweep line and any pinned header, so a single fixed anchor survives the
    // whole cascade (no drift-prone re-anchoring needed). Anchor to the topmost
    // such surviving row and hold it at the same client-top — the rows above it
    // collapse and the view stays put.
    const safeTop = measureTopChromeHeight() + ANCHOR_SAFE_MARGIN_PX;
    for (const li of document.querySelectorAll('li[data-item-id]')) {
      const id = (li as HTMLElement).dataset.itemId;
      if (!id || hideIds.has(id)) continue;
      const rect = li.getBoundingClientRect();
      if (rect.top >= safeTop) {
        exitTopAnchorRef.current = { id, top: rect.top };
        // Left null until the first restore records where it parked scrollY, so
        // a scroll that settles between the flush and that correction (e.g. the
        // drag's own tail) can't be mistaken for a reader fling.
        pinnedScrollYRef.current = null;
        // Suppress the browser's own scroll anchoring for the life of the pin,
        // so the only thing moving scrollY is our own correction. That keeps the
        // restore deterministic (we apply the full shift ourselves rather than
        // racing the browser's partial, delayed adjustment) AND lets the scroll
        // listener cleanly tell our corrections from a reader fling.
        setBodyOverflowAnchor('none');
        return;
      }
    }
    exitTopAnchorRef.current = null;
  }, []);
  const commitExitTop = useCallback(
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
      // Capture the anchor only now that a removal is certain — so the restore
      // layout effect, keyed on the visibleItems shrink this hideMany causes,
      // always fires to consume it and never strands a stale anchor for an
      // unrelated later render.
      captureExitTopAnchor(new Set(toHide));
      const now = Date.now();
      if (now - lastScrollHideAt.current >= SCROLL_HIDE_BATCH_WINDOW_MS) {
        // A gap ends the burst; mint a globally-unique key for the new one so it
        // can't extend another view's (or this view's prior) undo batch.
        scrollBatchKey.current = ++scrollBurstSeq;
      }
      lastScrollHideAt.current = now;
      // Flag the batch so the single-dismiss anchor opt-out below treats these
      // top-exit removals as the auto-hide case (anchoring stays on) rather than
      // an in-view mark-done. Cleared right after; the mutation listener runs
      // synchronously inside hideMany, within this set/clear window.
      autoHideInFlightRef.current = new Set(toHide);
      ds.stateStore.hideMany(toHide, now, { batchKey: scrollBatchKey.current });
      autoHideInFlightRef.current = null;
    },
    [ds, captureExitTopAnchor],
  );

  // Auto-hide-on-scroll must never remove rows while the viewport is still in
  // motion. A removed row above the viewport shifts everything below it up by
  // its height unless the scroll offset is corrected in the same frame, and
  // mid-motion no correction can be trusted: the browser's own scroll anchoring
  // doesn't exist on iOS/Safari, is suppressed during gestures (and for a beat
  // after a touch) elsewhere, and our own pin must not fight a live fling (see
  // onScroll below). Committing mid-glide therefore shunted rows the reader
  // could still see up under the sticky chrome; the observer then reported
  // those as scrolled past too, and the cascade ate the visible tail of a feed
  // group and snapped the next group into view. So top-exits are buffered
  // whenever the viewport is moving — a finger is down, or scroll events are
  // still arriving (a drag, a wheel burst, or the momentum glide after a
  // flick, which fires no touch/wheel/key events at all) — and the batch
  // commits only once the viewport has been still for SCROLL_SETTLE_MS, under
  // the scroll pin that holds the reader's position across the removal.
  // Pointer events can't track the finger: a `pan-y` scroll fires
  // `pointercancel` the instant the browser claims the gesture, so the finger
  // looks "up" mid-scroll. Touch events keep firing through the scroll, so we
  // track the physical contact with them.
  const touchActiveRef = useRef(false);
  const bufferedExitTopRef = useRef<Set<ItemId>>(new Set());
  // Bumped on every change to the exit-top buffer so renders that read it (the
  // unread-badge memo's provisional decrements below) recompute. The buffer
  // itself stays a ref — the IO callbacks and the settle flush mutate it
  // synchronously mid-gesture and mostly don't need a render.
  const [exitBufferVersion, bumpExitBufferVersion] = useReducer(
    (x: number) => x + 1,
    0,
  );
  const settleFlushTimerRef = useRef<number | null>(null);
  const cancelSettleFlush = useCallback(() => {
    if (settleFlushTimerRef.current !== null) {
      window.clearTimeout(settleFlushTimerRef.current);
      settleFlushTimerRef.current = null;
    }
  }, []);
  // (Re)start the settle clock: the buffer flushes once no input has arrived
  // for a full quiet window. Re-arming on every scroll event pushes the flush
  // back until the viewport is actually at rest.
  const armSettleFlush = useCallback(() => {
    cancelSettleFlush();
    settleFlushTimerRef.current = window.setTimeout(() => {
      settleFlushTimerRef.current = null;
      // A finger came back down before the clock ran out (catching a glide) —
      // the touch-release handler arms a fresh clock when it lifts.
      if (touchActiveRef.current) return;
      const buffered = bufferedExitTopRef.current;
      if (buffered.size === 0) return;
      // Rows scrolled back into view during the wait were already pruned by
      // handleReenter, so whatever remains is still scrolled past.
      const ids = [...buffered];
      buffered.clear();
      // Even when commitExitTop filters everything out (all pinned/mid-sweep)
      // and so never touches the store, the emptied buffer must still reach
      // the badge memo — its provisional decrements would otherwise linger.
      bumpExitBufferVersion();
      commitExitTop(ids);
    }, SCROLL_SETTLE_MS);
  }, [cancelSettleFlush, commitExitTop]);
  const handleExitTop = useCallback(
    (ids: ItemId[]) => {
      for (const id of ids) bufferedExitTopRef.current.add(id);
      // Surface the exit immediately: the badge decrements the moment the row
      // leaves the screen (mid-gesture), not at the settle flush.
      bumpExitBufferVersion();
      // While a finger is down the touch-release handler owns arming the
      // flush; for every other input the exit itself starts the settle clock
      // (and any scrolling still under way keeps pushing it back).
      if (!touchActiveRef.current) armSettleFlush();
    },
    [armSettleFlush],
  );
  // A buffered row the reader scrolls back into view (fully or partially)
  // before the flush is under their eyes again — drop it from the pending
  // batch so the flush never marks a visible row Done. Fires synchronously
  // from the observer, so it always wins the race against the settle flush
  // that follows the re-entry.
  const handleReenter = useCallback((ids: ItemId[]) => {
    if (bufferedExitTopRef.current.size === 0) return;
    let dropped = false;
    for (const id of ids) {
      if (bufferedExitTopRef.current.delete(id)) dropped = true;
    }
    // The row is back under the reader's eyes — lift its provisional badge
    // decrement along with the buffered hide.
    if (dropped) bumpExitBufferVersion();
  }, []);
  useEffect(() => {
    if (!hideOnScroll) return;
    // The buffer's identity is stable across renders; capture it so the cleanup
    // doesn't read `ref.current` (which the exhaustive-deps lint flags).
    const buffered = bufferedExitTopRef.current;
    // Any fresh viewport input — a new touch, a wheel/trackpad scroll, or a
    // keyboard scroll — means the reader is taking control again, so drop any
    // pending scroll pin and stop re-anchoring to the old row.
    const releasePin = () => {
      // Always clear the inline style, even if the anchor ref was already
      // consumed (for example because the anchor row disappeared before cleanup).
      // The style is global to the rendered list body and must not leak across
      // unmounts or setting toggles.
      exitTopAnchorRef.current = null;
      pinnedScrollYRef.current = null;
      setBodyOverflowAnchor('');
    };
    // Momentum/inertial scroll after a flick fires no touch/wheel/key — only
    // `scroll`. Release the pin on any scroll the reader (or that inertia) drove,
    // told apart from our own restoring scrollBy by the scrollY it left behind:
    // our layout effect always lands scrollY back on pinnedScrollYRef, so a
    // scroll event whose offset differs is the fling, and we stop fighting it.
    const onScroll = () => {
      // Still moving — push any pending settle flush back until the viewport
      // rests. Mid-drag scrolls don't arm it (the finger owns the buffer until
      // it lifts).
      if (!touchActiveRef.current && buffered.size > 0) armSettleFlush();
      if (!exitTopAnchorRef.current) return;
      // Until our first correction has recorded where it left scrollY, the pin
      // isn't established — ignore scrolls (e.g. the drag's own position settling
      // right after touchend) rather than release on them.
      if (pinnedScrollYRef.current === null) return;
      // With anchoring suppressed (see captureExitTopAnchor) the only scrollY
      // changes during the settle are our own corrections, which always land back
      // on pinnedScrollYRef — so a scroll whose offset differs is the reader's
      // momentum/inertial fling, and we let the pin go.
      if (Math.round(window.scrollY) === pinnedScrollYRef.current) return;
      releasePin();
    };
    const onTouchStart = () => {
      touchActiveRef.current = true;
      cancelSettleFlush();
      releasePin();
    };
    const onTouchEnd = (e: TouchEvent) => {
      // Hold off until the *last* finger lifts — a multi-touch gesture that
      // releases one finger is still in progress.
      if (e.touches.length > 0) return;
      touchActiveRef.current = false;
      if (buffered.size === 0) return;
      // The lift is not rest: a flick keeps the viewport gliding on momentum,
      // which fires only `scroll` events. Start the settle clock instead of
      // committing here — glide scrolls keep pushing it back, so the buffered
      // batch commits (pinned, via armSettleFlush) once the viewport truly
      // stops.
      armSettleFlush();
    };
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true });
    document.addEventListener('wheel', releasePin, { passive: true });
    document.addEventListener('keydown', releasePin);
    document.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
      document.removeEventListener('wheel', releasePin);
      document.removeEventListener('keydown', releasePin);
      document.removeEventListener('scroll', onScroll);
      // Toggling the feature off (or unmounting during a scroll pin or a
      // pending settle flush) must not strand buffered ids, the armed timer,
      // OR the temporary overflow-anchor opt-out. Otherwise the next list
      // would inherit anchoring disabled and the stale pin could keep
      // fighting scroll after the feature is gone.
      releasePin();
      cancelSettleFlush();
      touchActiveRef.current = false;
      buffered.clear();
      bumpExitBufferVersion();
    };
  }, [hideOnScroll, armSettleFlush, cancelSettleFlush]);

  // Cross-device "dismiss in place" (SPEC.md *Feed views → Dismissed in place*):
  // a server dismiss grays a row IN PLACE only while it's actually on screen —
  // removing an on-screen row would shift the content the reader is looking at.
  // A dismiss that lands on an OFF-screen row (below the fold, or already
  // scrolled above the top) is removed immediately, and a grayed row is dropped
  // the moment it scrolls off screen: both removals are invisible, so there's no
  // jump to avoid. "On screen" = intersecting the visible band (viewport minus
  // the sticky chrome), tracked by the same IntersectionObserver Sweep uses.
  const onScreenIdsRef = useRef<Set<ItemId>>(new Set());
  // Mirror of the latest grayed set so a viewport-exit can tell whether a row
  // leaving the screen is one we're holding grayed (and must now drop) without
  // re-subscribing. Written *synchronously* inside the visibleItems memo (during
  // render) rather than from a passive effect: a row can leave the viewport
  // between graying and a post-render effect, and the exit handler must see the
  // fresh set or it would skip the commit and strand the row grayed (Codex P2 on
  // #416).
  const grayedIdsRef = useRef<Set<ItemId>>(new Set());
  // Bumped only when a currently-grayed row leaves the viewport, so `visibleItems`
  // re-runs and drops it. Separate from `storeVersion` so ordinary scrolling —
  // rows entering/leaving that aren't grayed — never re-runs the memo.
  const [viewportVersion, bumpViewportVersion] = useReducer((x: number) => x + 1, 0);
  const handleViewportEnter = useCallback((ids: ItemId[]) => {
    for (const id of ids) onScreenIdsRef.current.add(id);
    // Entering never resurrects a dropped dismiss (an off-screen dismiss already
    // removed the row from the list), so no recompute is needed here.
  }, []);
  const handleViewportExit = useCallback((ids: ItemId[]) => {
    let droppedGray = false;
    for (const id of ids) {
      onScreenIdsRef.current.delete(id);
      if (grayedIdsRef.current.has(id)) droppedGray = true;
    }
    if (droppedGray) bumpViewportVersion();
  }, []);

  const { inViewIds, getRowRef } = useInViewIds({
    onExitTop: hideOnScroll ? handleExitTop : undefined,
    onReenter: hideOnScroll ? handleReenter : undefined,
    onViewportEnter: handleViewportEnter,
    onViewportExit: handleViewportExit,
  });

  // Ids restored by the most recent Undo, awaiting a scroll-into-view once they
  // re-render. After undoing an auto-hide-on-scroll burst the restored rows
  // remount *above* the viewport (they sit earlier in the feed than where the
  // reader scrolled to), so bring the topmost one back on screen. The scroll
  // effect below consumes this once the rows are actually back in the list — the
  // refetch that re-includes them is async, so we can't scroll on the click.
  const pendingUndoScrollIds = useRef<Set<ItemId> | null>(null);
  // Whether the undo's feed-query refetch has been observed in flight since the
  // request was armed. The undo batch is global across feed views, so a restored
  // burst may belong to a view the reader navigated away from; once that refetch
  // settles without surfacing the rows here, we drop the request (see the effect
  // below) so a later unrelated refetch can't scroll this view by surprise.
  const undoScrollSawFetchRef = useRef(false);
  const handleUndoScroll = useCallback(
    (restoredIds: ItemId[]) => {
      pendingUndoScrollIds.current =
        restoredIds.length > 0 ? new Set(restoredIds) : null;
      undoScrollSawFetchRef.current = false;
      // Undo is the one action where we DO want a refetch. A normal mutation
      // only marks the feed stale (no refetch, so the reader's scroll isn't
      // reflowed) and relies on the local overlay to drop the row — but Undo
      // must RESTORE a row, and if a focus/PTR refresh already reconciled it out
      // of `items[]`, restoring its state alone can't bring it back (it's gone
      // from the cached page). A refetch re-includes it, and the pending-scroll
      // effect below rides that same refetch to bring the topmost restored row
      // on screen. Harmless when the row is still cached — `visibleItems` already
      // re-includes it and the refetch just reconciles. (Codex P2 on #375.)
      //
      // On the live Supabase source the restoring write is delivered through the
      // async outbox, so THIS refetch can race ahead of it and read server truth
      // that still marks the row dismissed — leaving a reconciled-out row absent
      // until the next focus/PTR. The subscribeSynced effect below re-fetches once
      // the outbox drains, and the pending-scroll effect holds the request open
      // while `ds.pendingItemIds()` still lists a restored id (Codex P2 on #376).
      // Routed through undoRefetch so this reconcile stays silent (no Refreshing
      // state) — Undo is a predictable, instant action.
      if (restoredIds.length > 0) void undoRefetch();
    },
    [undoRefetch],
  );

  // When an Undo restore is still pending and the outbox drains its writes
  // server-side, refetch so a reconciled-out row that the immediate post-Undo
  // refetch couldn't resurface (it raced the async write) comes back now that
  // server truth reflects the restore. Reset the saw-fetch latch so the
  // pending-scroll effect waits for THIS refetch to settle before giving up.
  // No-op on the mock (its store is authoritative, so notifySynced never fires).
  useEffect(() => {
    return ds.stateStore.subscribeSynced(() => {
      if (!pendingUndoScrollIds.current) return;
      undoScrollSawFetchRef.current = false;
      void undoRefetch();
    });
  }, [ds, undoRefetch]);

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
  // The blank scroll-space appended at the true end of a feed when auto-hide-on-
  // scroll is on (see the render), so the last screenful of rows can be scrolled
  // up past the top chrome and auto-marked too. Measured off the DOM so the
  // end-of-list check below discounts it — "the end" is the last real row, not
  // the bottom of the blank tail — keeping the pinned-bar pager honest.
  const scrollSpaceRef = useRef<HTMLDivElement>(null);

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

  // Per-section "More" taps that landed while the base query was refetching.
  // `handleFeedMore` reveals rows off `items[]`, which is the stale pre-refetch
  // window mid-refresh (e.g. right after a Sweep) — so rather than disable the
  // button (which flickered every section's More to "Loading…" on any
  // background refetch, even ones the reader never tapped), we keep the button
  // as a stable, tappable "More" and defer the tap. A drain effect re-fires
  // `handleFeedMore` once a *successful* refetch settles and the reveal can run
  // against fresh `items[]`, so the tap is honored, not dropped. Declared up
  // here so `handleMore` (the global pager, below) can clear it.
  const [pendingFeedMore, setPendingFeedMore] = useState<ReadonlySet<FeedId>>(
    () => new Set(),
  );

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
    // Tapping the global pager fetches the next base page via fetchNextPage,
    // which can cancel an in-flight background refetch and settle with page 1
    // still on the stale pre-refetch window and no `error`. Drop any deferred
    // section-"More" taps so the drain effect doesn't run handleFeedMore against
    // that stale window — the reader re-taps the section once data is fresh.
    setPendingFeedMore((prev) => (prev.size === 0 ? prev : new Set()));
    // At the end with another page available → fetch it; the effect scrolls the
    // first new element below the top chrome once it lands. When grouping with
    // collapsed sections, a fetched page can render nothing new (all hidden rows
    // of a continuing collapsed feed) — keep fetching (bounded) until something
    // new is rendered (a visible row OR a new section header) or the feed is
    // exhausted, so "More" never lands the reader on a page that shows nothing.
    pendingAnchorId.current = items[items.length - 1]?.item.id ?? null;
    const baselineRendered = renderedCountOf(items);
    let pagesLoaded = pageCount;
    let appended = false;
    for (let i = 0; i < MAX_AUTO_SKIP_PAGES; i++) {
      const res = await fetchMore();
      const pages = res.data?.pages ?? [];
      // No new page appended (true end, or a fetch error) → stop.
      if (pages.length <= pagesLoaded) break;
      pagesLoaded = pages.length;
      appended = true;
      // Measure progress on the same deduped view the list renders: an
      // appended page can consist entirely of already-loaded items (offset
      // drift re-serving the previous page's tail), which renders nothing —
      // keep fetching past it just like a collapsed-only page.
      const all = dedupeFeedPages(pages);
      // Something new rendered (a row or a new header), or nothing left → done.
      if (renderedCountOf(all) > baselineRendered || !(res.hasNextPage ?? false)) break;
    }
    // Nothing appended (offline, server error, or the true end): disarm the
    // anchor. Left armed, it would survive until some LATER items change — a
    // PTR, a TTL re-materialization, even this view's ids appearing in a
    // different view — and the scroll effect would then yank the viewport to
    // whatever happens to follow the anchor row in that unrelated refresh.
    if (!appended) pendingAnchorId.current = null;
  }, [pinnedBar, atListEnd, items, pageCount, fetchMore, renderedCountOf]);

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

  // Frozen-list dismiss handling (SPEC.md "A stable set of articles"): a dismiss
  // the reader made *this session* removes its row (collapsing up); a dismiss
  // that arrives from another device (resync/hydrate) grays in place only while
  // the row is on screen (see `onScreenIdsRef` above), otherwise it's removed
  // right away since the removal is invisible. A row that arrives on a More page
  // already dismissed is likewise filtered out (it was never on screen).
  //
  // `localDismissedIdsRef` records ids dismissed via the *mutation* channel (your
  // own swipe / Sweep / auto-hide) so `visibleItems` can tell them apart from a
  // server dismiss — the latter never fires this channel.
  const localDismissedIdsRef = useRef<Set<ItemId>>(new Set());

  // Load-time pin baseline for the grouped-view promotion (Codex P2 on #411): the
  // ids that were pinned when they FIRST entered the loaded set. A row pinned at
  // that point is in the server's pinned block and promotes to the section top; a
  // row pinned AFTER it appeared — locally OR from another device — stays at its
  // body position (badge only) until the next re-materialize consolidates it.
  // `seenForBaseRef` records which ids have been baselined so the capture is
  // once-per-id; both reset on a view change / PTR (a re-materialize).
  const basePinnedRef = useRef<Set<ItemId>>(new Set());
  const seenForBaseRef = useRef<Set<ItemId>>(new Set());

  // Per-feed sticky display window: the set of item ids the user has committed
  // to viewing in this section. Initialized from the first base read for each
  // feed (first `perFeedLimit` ids), extended only when the user taps a section
  // "More" (the next batch of already-fetched ids is added in handleFeedMore),
  // and wiped on viewKey change or pull-to-refresh. The base read can still pull in
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
  // tracking below. Not just `items`: in the windowed grouped view, a sticky
  // display id can outlive its row in the base read (the row-cache fallback
  // keeps rendering it) — so a pin on one of those rows would otherwise go
  // undetected and the next refetch (which promotes the pin into the base
  // window) would lift it to the section top. Union both so pinning any
  // visible row is observed.
  const itemIds = useMemo(() => {
    const s = new Set<ItemId>(items.map((fi) => fi.item.id));
    for (const set of displayedByFeed.values()) {
      for (const id of set) s.add(id);
    }
    return s;
  }, [items, displayedByFeed]);
  const itemIdsRef = useRef(itemIds);
  itemIdsRef.current = itemIds;
  // A pin counts as in-session only when the reader does it themselves. We
  // listen on the store's *mutation* channel (set / hide / sweep / undo) rather
  // than the general subscribe, so a background hydrate or cross-device sync —
  // which flips pre-existing server pins to pinned via hydrate(), emitting no
  // diff — is never mistaken for the reader pinning a row. A fresh pin on a row
  // in the loaded window is held at its place.
  //
  // An UNPIN holds the row too (any local pinned-state change, either
  // direction): the feed cache stays pinned-first until the next
  // re-materialization, so an unpinned row must be anchored back to its body
  // slot for that round-trip rather than lingering at the stale top
  // (placeStayInBodyPins re-sorts a held row by date whether or not it's still
  // pinned). This can't rely on the id remaining in the set from pin time —
  // the re-materialization reset (above) clears the set, so a
  // pin-consolidate-then-unpin sequence must re-add it here. The id is cleared
  // when it leaves the window (the GC effect below) or on the next
  // consolidation (PTR / TTL re-materialization / view change) — by which
  // point the cache no longer lifts it anyway.
  useEffect(() => {
    return ds.stateStore.subscribeMutations((id, changed) => {
      if (changed.pinned === undefined) return;
      if (!itemIdsRef.current.has(id)) return;
      setStayInBodyIds((cur) => (cur.has(id) ? cur : new Set(cur).add(id)));
    });
  }, [ds]);
  // Record local dismiss/restore so visibleItems can distinguish YOUR dismiss
  // (remove) from a server one (gray in place). The mutation channel fires only
  // for local set/hide/sweep/undo — never a cross-device hydrate — so an id here
  // is one the reader dismissed themselves. Un-dismissing (pin clears done, an
  // Undo, the per-row restore) drops it again.
  useEffect(() => {
    return ds.stateStore.subscribeMutations((id, changed) => {
      if (changed.done === undefined && changed.hidden === undefined) return;
      if (changed.done === true || changed.hidden === true) {
        localDismissedIdsRef.current.add(id);
      } else if (changed.done === false || changed.hidden === false) {
        localDismissedIdsRef.current.delete(id);
      }
    });
  }, [ds]);
  // As the loaded window changes (pagination, refetch), drop stay ids that left
  // it — a held pin that's no longer displayed has nothing to anchor.
  useEffect(() => {
    // Reconciles against the async-loaded window; the functional updater
    // returns the same set when nothing changed, so it can't cascade renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStayInBodyIds((cur) => {
      if (cur.size === 0) return cur;
      let next: Set<ItemId> | null = null;
      for (const id of cur) {
        if (!itemIds.has(id)) (next ??= new Set(cur)).delete(id);
      }
      return next ?? cur;
    });
  }, [itemIds]);

  // Drop a view's expanded sections only when the view actually changes (not on
  // mount), so switching home → folder → a single feed never carries one view's
  // depth into the next, while a same-view re-render keeps what's expanded.
  const prevViewKey = useRef(viewKey);
  useEffect(() => {
    if (prevViewKey.current !== viewKey) {
      prevViewKey.current = viewKey;
      setDisplayedByFeed(new Map());
      setStayInBodyIds(new Set());
      setPendingFeedMore(new Set());
      // A "More" anchor armed in the previous view must not fire here: the
      // same item ids can appear in this view (home ↔ single feed), and a
      // stale anchor found mid-list would immediately scroll the fresh view.
      pendingAnchorId.current = null;
      // A new view starts clean: no carried-over on-screen/grayed tracking,
      // local-dismiss bookkeeping, or pin baseline from the previous view.
      onScreenIdsRef.current = new Set();
      grayedIdsRef.current = new Set();
      localDismissedIdsRef.current = new Set();
      basePinnedRef.current = new Set();
      seenForBaseRef.current = new Set();
    }
  }, [viewKey]);

  // Re-anchor the sticky display window when the published set RE-MATERIALIZES:
  // any non-Undo whole-list refetch — a stale mount/focus past the 6h freshness
  // TTL, a reconnect confirm, a subscription-change invalidation, or the
  // pull-to-refresh refetch — that settles successfully. SPEC (*A stable set of
  // articles*): the set re-materializes on a load/return past the TTL or a PTR;
  // when it does, each section must repaint as its pinned block + the fresh
  // window, not stay anchored to the previous read's ids. Without this reset the
  // sticky window survived every non-PTR re-materialization, so a long-mounted
  // (or persisted-cache-restored) grouped view whose displayed rows had all been
  // dismissed re-fetched a fresh top it could never paint — and quiet feeds (at
  // or under the window, so nothing unshown, no section "More", no phantom header)
  // collapsed the whole grouped view to a false "You're all caught up." while
  // unread articles sat in items[] behind the sticky gate (the empty
  // grouped-view bug; flat mode has no sticky window, which is why it kept
  // working).
  //
  // Undo (and its outbox-drain reconcile) routes through undoRefetch and keeps
  // the window anchored — it must RESTORE rows into the existing view, not
  // repaint it (excluded at fetch start via `undoRefetchDepth`). A FAILED
  // refetch keeps the old data, so the anchored view must survive it too (same
  // gating as the PTR handler's explicit reset, which this generalizes; that
  // handler's own reset is now a harmless overlap). Deferred section-More taps
  // queued during the refetch are dropped rather than drained: they targeted
  // the pre-refresh window, and the repaint puts a fresh section (with its own
  // "More") in front of the reader anyway —
  // `justRematerializedRef` tells the drain effect below to consume the settle
  // without firing them. The latch itself (`rematerializeRef`) is armed at
  // fetch START by materializingFetchPage (above the query), so a fetch that
  // settles without ever committing an intermediate fetching render still
  // resets.
  const justRematerializedRef = useRef(false);
  // `items` is a dependency because a fast-settling refetch can go
  // fetching→settled without ever committing an `isFetching: true` render —
  // the fresh page landing (a new `items` identity) is the reliable settle
  // signal. A More append or an Undo reconcile also changes `items`, but
  // neither arms the latch, so those runs no-op. Consuming only the 'landed'
  // state (set when the page promise resolved) keeps a commit that settled the
  // fetch STATUS ahead of the fresh DATA from resetting against the stale page
  // and re-anchoring the very ids the refetch replaced.
  useEffect(() => {
    if (isFetching || rematerializeRef.current !== 'landed') return;
    rematerializeRef.current = 'idle';
    if (error) return;
    justRematerializedRef.current = true;
    // Edge-triggered re-baseline when a refetch settles (isFetching → false with
    // the 'landed' latch) — synchronizing with React Query's async fetch state,
    // which is legitimate effect work, not derivable during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDisplayedByFeed(new Map());
    setStayInBodyIds(new Set());
    setPendingFeedMore(new Set());
    grayedIdsRef.current = new Set();
    // Re-baseline pin membership from the fresh page HERE, not by clearing and
    // leaving it to the render-time loop: the sticky-window init effect below
    // runs in this same effect flush, and its state updater executes at the top
    // of the NEXT render — before that render's baseline loop repopulates the
    // refs. Cleared-only refs would make it count every pin against the body
    // window, seating `perFeedLimit − pins` articles instead of `perFeedLimit`
    // (self-healed a commit later by the window-extension branch, but the
    // repaint must be right the first time).
    const seen = new Set<ItemId>();
    const basePinned = new Set<ItemId>();
    for (const fi of items) {
      const id = fi.item.id;
      if (seen.has(id)) continue;
      seen.add(id);
      if (ds.stateStore.get(id).pinned) basePinned.add(id);
    }
    seenForBaseRef.current = seen;
    basePinnedRef.current = basePinned;
  }, [isFetching, error, items, ds]);

  // Initialize the sticky display window for any feed seen in `items` that
  // doesn't have one yet. Takes every load-time-pinned id in that feed's run
  // (pins are exempt from the window — SPEC: a section opens with ALL pinned
  // rows) plus its first `perFeedLimit` body ids — exactly the rows mergedRaw
  // would have shown on first load — so the user's initial view matches the
  // server's top window. Pin membership keys off `basePinnedRef` (pinned when
  // the row entered the loaded set), mirroring the server's pinned block at
  // fetch time, so an in-session pin doesn't grow the window mid-view and the
  // fetched rows past the window stay out until a "More" reveals them.
  //
  // Also EXTENDS an existing sticky window when its ids are still the
  // contiguous prefix of items[]'s run for that feed AND items[] now carries
  // more rows than the sticky set. This handles the row-cap-overflow case
  // (`GROUPED_WINDOW_ROW_CAP` splits a feed's opening window across pages —
  // first page returns the partial section, second page returned by the
  // global "More" appends the rest; without extension the partial-window
  // sticky set would block the rest from rendering and hide them from the
  // section's More). The "still the prefix" check is what keeps this safe
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
        // Walk the WHOLE run (a pin can sit anywhere in it): load-time pins go
        // in uncounted, body ids fill the window up to `perFeedLimit`.
        const firstIds: ItemId[] = [];
        let bodyCount = 0;
        for (let j = i; j < items.length && items[j].item.feedId === feedId; j++) {
          const id = items[j].item.id;
          if (basePinnedRef.current.has(id)) {
            firstIds.push(id);
          } else if (bodyCount < perFeedLimit) {
            firstIds.push(id);
            bodyCount += 1;
          }
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

  // Per-section "More": reveal the next batch of ALREADY-FETCHED rows. The
  // base read carries everything the server returned for each feed (the client
  // sends no fetch cap — the server decides), so a tap never needs a request:
  // it extends the sticky display window with the next `perFeedLimit` unshown
  // fetched body rows — instant, and it works offline. This also covers a row
  // that arrived in the base window after the section was fully revealed (a
  // polled-in item landed by an Undo reconcile, a cross-device promotion):
  // it's fetched-but-unshown, so a tap reveals it. When nothing unshown
  // remains the feed is exhausted — feedsWithMore drops the button, so a tap
  // that races the last reveal simply no-ops.
  const handleFeedMore = useCallback(
    (feedId: FeedId) => {
      if (perFeedLimit == null) return;
      // Base query refetching → `items[]` is the stale pre-refetch window, so
      // a reveal would surface rows the settling refetch is about to replace.
      // Defer the tap instead of dropping it: queue the feed and let the drain
      // effect re-run this once the refetch settles against fresh `items[]`.
      // The button keeps showing a tappable "More" the whole time, so a
      // background refresh never flickers it to "Loading…".
      if (isFetching) {
        setPendingFeedMore((prev) =>
          prev.has(feedId) ? prev : new Set(prev).add(feedId),
        );
        return;
      }
      const allowed = displayedByFeed.get(feedId);
      const unshown = unshownFetchedBodyIds(
        items,
        feedId,
        allowed,
        basePinnedRef.current,
        (id) => {
          const st = ds.stateStore.get(id);
          return st.pinned || (!st.done && !st.hidden);
        },
      );
      if (unshown.length === 0) return;
      const batch = unshown.slice(0, perFeedLimit);
      setDisplayedByFeed((prev) => {
        const cur = prev.get(feedId);
        if (!cur) return prev;
        const next = new Set(cur);
        for (const id of batch) next.add(id);
        const map = new Map(prev);
        map.set(feedId, next);
        return map;
      });
    },
    [perFeedLimit, items, displayedByFeed, ds, isFetching],
  );

  // Drain the deferred section-"More" taps once the base refetch settles, so a
  // tap that landed mid-refresh reveals against fresh `items[]` instead of
  // being lost. handleFeedMore re-checks its own guards against the current
  // view, so a feed with nothing left unshown after the refetch simply no-ops.
  // This drain path now only applies to sticky-preserving refetches (Undo and
  // its outbox-drain reconcile): a RE-MATERIALIZING refetch resets the sticky
  // window on settle (the effect above) and drops deferred taps with it, so
  // this effect must consume that settle without firing them — they targeted
  // the pre-refresh window the reset just discarded.
  useEffect(() => {
    if (isFetching) return;
    // Consume the re-materialization latch on ANY settled run — even one with
    // no queued taps — so a stale latch can't linger and swallow a later,
    // legitimate drain.
    const rematerialized = justRematerializedRef.current;
    justRematerializedRef.current = false;
    if (pendingFeedMore.size === 0) return;
    if (rematerialized) return;
    // Only drain after a *successful* refetch. A failed one (`error` set, data
    // retained) leaves `items[]` as the stale pre-refetch window, so draining
    // now would reveal stale rows. Drop the queued taps instead — the button
    // reverts to a tappable "More" so the reader can retry once a refresh
    // succeeds.
    // Edge-triggered drain of queued "More" taps once a refetch settles —
    // reacting to React Query's async fetch state, legitimate effect work
    // (not derivable during render); the set-state-in-effect disables mark that.
    if (error) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingFeedMore(new Set());
      return;
    }
    const feeds = [...pendingFeedMore];
    setPendingFeedMore(new Set());
    for (const feedId of feeds) handleFeedMore(feedId);
  }, [isFetching, error, pendingFeedMore, handleFeedMore]);

  // Per-id cache of FeedItem objects so a sticky row stays renderable even
  // when a refetch flushes it out of `items[]`. Since the re-materialization
  // reset (a non-Undo whole-list refetch re-anchors the sticky window on the
  // fresh page), the fallback's remaining job is the sticky-preserving
  // refetches — Undo's immediate reconcile and its outbox-drain follow-up —
  // where a restored row can be momentarily absent from the racing server
  // read yet must keep rendering where the reader sees it. Populated below
  // from items[] on every render — mergedRaw falls back to it for sticky ids
  // that didn't make the cut.
  const rowCacheRef = useRef<Map<ItemId, FeedItem>>(new Map());
  if (perGroupMore) {
    for (const fi of items) rowCacheRef.current.set(fi.item.id, fi);
  }

  // The displayed slice of the base river: each feed's rows that sit in its
  // sticky display window, deduped by id. The sticky window (`displayedByFeed`)
  // is initialized to the first `perFeedLimit` base ids per feed on first load
  // and extended by tap-More; everything else — fetched rows past the opening
  // window, fresh items the server slotted in after a Sweep, cross-device
  // drift at the top — stays in `items` but doesn't render here until the
  // reader explicitly asks for it (a tap on More or a pull-to-refresh). Sticky
  // ids that are no longer in items[] (cleared by a heavy refetch) fall back
  // to the row cache, so the displayed window survives even when no live
  // source carries those rows anymore. Other code paths read from this merged
  // list so Sweep, headers, counts and the end-of-list measurement all see
  // exactly the displayed rows. Identity-stable (=== items) outside the
  // windowed grouped view, so the flat river and single-feed views are
  // untouched — except while an in-session pin is held in body position,
  // where it returns a reordered copy (see placeStayInBodyPins).

  // Baseline each row's pin state the first time it enters the loaded set, so the
  // grouped promotion below can tell a load-time pin (promote) from a post-load
  // one (stay in body). Runs during render — idempotent, once per id — so
  // mergedRaw sees it the same render `items` grows. A cross-device pin flips an
  // already-seen row, so it's never added here → correctly stays in body.
  for (const fi of items) {
    const id = fi.item.id;
    if (!seenForBaseRef.current.has(id)) {
      seenForBaseRef.current.add(id);
      if (ds.stateStore.get(id).pinned) basePinnedRef.current.add(id);
    }
  }

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
      const feedSection: FeedItem[] = [];
      const feedSeen = new Set<ItemId>();
      const push = (fi: FeedItem) => {
        if (feedSeen.has(fi.item.id)) return;
        feedSeen.add(fi.item.id);
        feedSection.push(fi);
      };

      // Fill the section pinned-first. Pinned rows are EXEMPT from the position
      // window (mirroring the server RPC: "Pinned is NOT window/floor-filtered",
      // 0031) — they lead the section, then the reader's opted-in window rows
      // follow. Promote only a row pinned when it ENTERED the loaded set
      // (`basePinnedRef`) that the reader hasn't held in body this session
      // (`stayInBodyIds`):
      //   - the reader's own in-session pin is caught by stayInBodyIds — which
      //     also covers a pin on a row revealed by More that basePinned
      //     can't see until it later enters the base window;
      //   - a pin arriving from ANOTHER device is caught by basePinnedRef (the row
      //     was in the set unpinned, so it was never baselined) — the gap the old
      //     stayInBodyIds-only gate left open (Codex P2 on #411), which jumped a
      //     cross-device pin to the top.
      const promotablePin = (fi: FeedItem): boolean =>
        ds.stateStore.get(fi.item.id).pinned &&
        basePinnedRef.current.has(fi.item.id) &&
        !stayInBodyIds.has(fi.item.id);
      // Pinned-first pass over the WHOLE base run — not just `allowed` — so a pin
      // sitting outside the position window still leads its section. Without this,
      // a pin the window doesn't cover (an older pin, a local pin the server still
      // orders by date, or one displaced by rows the reader has since dismissed)
      // is dropped and the section collapses to a phantom "More" that hides the
      // pin, its real favicon, and its unread badge until a tap/refresh (the
      // "pull-to-refresh hides my pinned row" bug). KNOWN GAP (TODO.md "UI /
      // layout"): this scans only `baseRun`, so a locally-pinned row the
      // refreshed *server* read dropped entirely — an old pin in a busy feed,
      // pinned this session before the outbox synced, so `feed_items`' per-feed
      // date window excludes it and branch (c) can't yet rescue it — is NOT
      // promoted here even though it's still in `rowCacheRef`; it reappears on the
      // next focus/resync once the pin syncs (Codex on #418). No cap: pins are
      // exempt from the per-feed window at the server too (0052 — a section is
      // ALL its pins plus the body window), so every promotable pin shows. A
      // pin is shown IN ADDITION to the window rows, never by displacing one
      // (a displaced sticky row would be hidden yet still counted as shown,
      // wasting a More batch slot — Codex P2 on #418).
      for (const fi of baseRun) {
        if (promotablePin(fi)) push(fi);
      }
      if (allowed) {
        // Fill with the sticky (opted-in) rows in iteration order — the order the
        // reader actually opted into (and the full expanded set after a section
        // "More" grew `allowed`). Without this, a heavy refetch that brings fresh
        // top rows into items[] would render them above the reader's existing
        // anchored rows (which fell back to the row cache), visibly shoving the
        // anchor down. Look up each sticky id from items[] → row cache;
        // if both miss, drop it (the row truly is gone for now). Not capped:
        // `allowed` is already the reader's chosen window, and a promoted pin
        // shows on top of it rather than evicting one of these rows.
        //
        // The cost: a row the server filtered out (cross-device Done/Hide, item
        // retracted) stays visible until the local state store learns about the
        // change. That's expected to come through the realtime state-sync path;
        // once `stateStore.get(id).done` flips, the `visibleItems` filter drops
        // the row. The (acceptable) window of staleness here is bounded by sync
        // latency, not "until PTR".
        for (const id of allowed) {
          if (feedSeen.has(id)) continue;
          const fi = baseById.get(id) ?? rowCacheRef.current.get(id);
          if (fi) push(fi);
        }
      } else {
        // No sticky entry yet (init effect hasn't run on the first paint) — fall
        // back to the "all pins + first perFeedLimit body rows" rule so the
        // section isn't blank. The pinned-first pass above already seated the
        // promotable pins; this seats any remaining load-time pin (window-
        // exempt, uncounted) and fills the window with the first perFeedLimit
        // not-yet-shown body rows. The init effect lands shortly after and
        // `allowed` takes over.
        let shown = 0;
        for (const fi of baseRun) {
          if (feedSeen.has(fi.item.id)) continue;
          if (basePinnedRef.current.has(fi.item.id)) {
            push(fi);
            continue;
          }
          if (shown >= perFeedLimit) continue;
          push(fi);
          shown += 1;
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
    displayedByFeed,
    ds,
    storeVersion,
    stayInBodyIds,
    groupByFeed,
    itemSort,
  ]);

  // Three-way overlay (SPEC.md "A stable set of articles"): a normal row shows;
  // a row you dismissed this session is removed (collapsing up); a row dismissed
  // on ANOTHER device grays IN PLACE only while it's on screen, and is removed
  // otherwise (off-screen removals are invisible, so there's no jump to avoid).
  // A row that enters already-dismissed (initial load, or a More page, below the
  // fold) is never on screen either, so it's likewise filtered out — never shown,
  // never grayed. Memoized on `storeVersion` (any store change, local or hydrate)
  // + `mergedRaw` + `viewportVersion` (a grayed row left the screen); the refs it
  // reads are updated alongside those, so they aren't deps.
  const { visibleItems, grayedIds } = useMemo(() => {
    const grayed = new Set<ItemId>();
    const visible: FeedItem[] = [];
    for (const fi of mergedRaw) {
      const id = fi.item.id;
      const st = ds.stateStore.get(id);
      // A PIN is exempt from the Done/Hidden overlay — a pin means "keep this
      // visible", so it always shows normally (never dismissed, never grayed),
      // matching the server feed read, which returns a pinned row regardless of
      // Done/Hidden (0031, the pinned candidate branch). Without this, a row
      // that is both pinned AND Done/Hidden — you pinned it, then opened it on a
      // "mark done on open" feed, or marked it Done — is dropped here, and the
      // remove-when-off-screen rule below makes it VANISH on scroll/PTR (the
      // grouped section then collapses to a phantom "More"), even though it's
      // still in the read and still in `/pinned`.
      if (st.pinned) {
        visible.push(fi);
        continue;
      }
      if (!st.done && !st.hidden) {
        visible.push(fi);
        continue;
      }
      if (localDismissedIdsRef.current.has(id)) continue; // your dismiss → remove
      // Hold (gray) a cross-device dismiss only while the row is on screen. Fast
      // path: the observer's live on-screen set. Fallback: before the observer
      // has reported this row (the window between first paint and its initial
      // delivery), measure the row's DOM position so a resync landing in that gap
      // still grays a visible row rather than removing it and jumping the list
      // (Codex P2 on #416).
      if (onScreenIdsRef.current.has(id) || rowIntersectsViewport(id)) {
        grayed.add(id); // a server dismiss for a row on screen → gray in place
        visible.push(fi);
      }
      // else: off screen (below the fold, or scrolled above the top) → removed
      // immediately; there's no visible shift to avoid.
    }
    // Mirror the grayed set into its ref here (during render) so a viewport-exit
    // that fires before any post-render effect still sees the current set and
    // commits the row (Codex P2 on #416). Idempotent — a re-run with unchanged
    // deps recomputes the same set.
    grayedIdsRef.current = grayed;
    return { visibleItems: visible, grayedIds: grayed };
    // storeVersion drives store-read reactivity; viewportVersion re-runs the memo
    // when a grayed row leaves the screen. The refs are intentionally excluded
    // (they're updated in lockstep with these deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedRaw, storeVersion, viewportVersion, ds]);

  // Undo a grayed (cross-device-dismissed) row via its right-side button: clear
  // done/hidden with a fresh clock so it wins last-write-wins and un-dismisses
  // everywhere. The row re-renders normal on the next commit.
  const handleUndoDismiss = useCallback(
    (id: ItemId) => {
      const st = ds.stateStore.get(id);
      if (st.done) ds.stateStore.set(id, 'done', false);
      if (st.hidden) ds.stateStore.set(id, 'hidden', false);
    },
    [ds],
  );

  // Hold the reader's scroll position across a settle-time top-exit flush.
  // A layout effect (after React commits a render, before paint): reading
  // getBoundingClientRect first forces the layout that applies whatever the
  // browser's own anchoring managed, so we correct only the residual shift — to
  // zero — in the same frame, with no visible flash. The pin re-applies on every
  // render until the reader next touches/wheels/keys the viewport OR drives a
  // native scroll we didn't cause (a post-flick momentum glide — see onScroll),
  // because the flush shifts layout up to three times — the immediate local
  // removal, the invalidated refetch landing ~100ms later, and the cascade
  // auto-hide of rows the collapse pushed under the chrome (fired async by the
  // IntersectionObserver after paint, so no settle heuristic can reliably outlast
  // it). Re-applying is idempotent (delta is 0 once layout is stable). The ref
  // gate makes every render without a live pin a no-op.
  useLayoutEffect(() => {
    const anchor = exitTopAnchorRef.current;
    if (!anchor) return;
    const el = document.querySelector(`[data-item-id="${anchor.id}"]`);
    if (!(el instanceof HTMLElement)) {
      // The anchor row itself left the list — nothing left to pin to.
      exitTopAnchorRef.current = null;
      pinnedScrollYRef.current = null;
      setBodyOverflowAnchor('');
      return;
    }
    const delta = el.getBoundingClientRect().top - anchor.top;
    if (delta !== 0) window.scrollBy(0, delta);
    // Record where we left scrollY so the `scroll` listener can recognize this
    // correction as ours and not mistake it for a reader/momentum scroll.
    pinnedScrollYRef.current = Math.round(window.scrollY);
  }, [visibleItems]);

  // Scroll the list back up to the topmost row an Undo just restored, but only
  // when that row is off-screen above the fold — so undoing a scroll-past burst
  // returns the reader to where they were reading, while undoing a swipe/Sweep
  // (whose rows are still on screen) never jerks the viewport. We wait until the
  // restored rows are actually back in the rendered list: an auto-hide burst's
  // rows were dropped from the cached page by the post-hide refetch, and Undo's
  // refetch re-includes them asynchronously, so there's nothing to scroll to on
  // the click itself. Clearing the pending set once they reappear bounds how
  // long a stale request can linger.
  useEffect(() => {
    const pending = pendingUndoScrollIds.current;
    if (!pending) return;
    const restoredInList = visibleItems.filter((fi) => pending.has(fi.item.id));
    if (restoredInList.length === 0) {
      // Does a restored id still have a write queued in the async outbox? Empty
      // on the mock (authoritative store); on Supabase, true until the restoring
      // write drains. Read imperatively — the effect re-runs when isFetching
      // flips (the drain refetch settling), so this is re-evaluated each pass.
      const pend = ds.pendingItemIds?.();
      const restoredHavePendingWrites =
        pend != null && pend.size > 0 && [...pending].some((id) => pend.has(id));
      // Rows aren't in this view (yet). Undo invalidates the feed query, so a
      // refetch re-includes a same-view burst — wait for it. But once that
      // refetch has run and settled without surfacing the rows, the batch
      // belongs to another view the reader navigated from; drop the request so a
      // later unrelated refetch can't scroll this view (Codex P2 on PR #229).
      //
      // Exception: on the live Supabase source the restoring write drains
      // asynchronously, so the immediate post-Undo refetch settles against
      // still-dismissed server truth. While any restored id still has an
      // un-synced write, hold the request open — the subscribeSynced effect
      // refetches on drain, and only then (write landed, row still absent → truly
      // another view) do we give up (Codex P2 on PR #376).
      if (isFetching) undoScrollSawFetchRef.current = true;
      else if (undoScrollSawFetchRef.current && !restoredHavePendingWrites) {
        pendingUndoScrollIds.current = null;
        undoScrollSawFetchRef.current = false;
      }
      return;
    }
    pendingUndoScrollIds.current = null;
    undoScrollSawFetchRef.current = false;
    let target: HTMLElement | null = null;
    for (const fi of restoredInList) {
      const el = document.querySelector(`[data-item-id="${fi.item.id}"]`);
      if (el instanceof HTMLElement) {
        target = el;
        break;
      }
    }
    if (!target) return; // restored rows aren't rendered (e.g. collapsed section)
    let chrome = measureTopChromeHeight();
    if (groupByFeed) {
      // A pinned section header (position: sticky at the chrome offset) paints
      // over the top of its feed's rows in grouped mode, so extend the inset by
      // its height — otherwise the restored row lands tucked behind the header,
      // and the on-screen guard would treat a header-occluded row as visible.
      // One layout read here, not the per-frame O(sections) scan that
      // measureStickyInset deliberately avoids (Codex P2 on PR #229).
      const header = document.querySelector('[data-header-for]');
      if (header instanceof HTMLElement) chrome += header.offsetHeight;
    }
    const top = target.getBoundingClientRect().top;
    if (top >= chrome) return; // already fully below the sticky chrome — on screen
    // Browsers honoring prefers-reduced-motion fall back to an instant scroll.
    window.scrollTo({
      top: Math.max(0, top + window.scrollY - chrome),
      behavior: 'smooth',
    });
  }, [visibleItems, isFetching, groupByFeed, ds]);

  // Which feed sections should show a "More" at their foot: exactly the feeds
  // whose fetched run still holds at least one showable body row the sticky
  // display window hasn't opted into — the rows the section "More" reveals
  // without a request. The base read carries everything the server returned
  // for the feed, so once nothing fetched is left unshown the feed is
  // exhausted and the button drops with it (SPEC: an exhausted feed shows no
  // dead button) — there is no has-more probe and no per-section server fetch;
  // the server decided what the feed holds. This also catches a row that
  // arrived in the base window after the section was fully revealed
  // (Undo-reconciled poll drift, a cross-device promotion): it sits in items[]
  // behind the sticky gate, so the button comes back to reveal it. Re-derived
  // on store changes (`storeVersion`): a local dismiss can consume the last
  // unshown row, and the button must drop with it.
  const feedsWithMore = useMemo(() => {
    void storeVersion;
    const s = new Set<FeedId>();
    if (!perGroupMore || perFeedLimit == null) return s;
    const seen = new Set<FeedId>();
    for (const fi of items) {
      const feedId = fi.item.feedId;
      if (seen.has(feedId)) continue;
      seen.add(feedId);
      const unshown = unshownFetchedBodyIds(
        items,
        feedId,
        displayedByFeed.get(feedId),
        basePinnedRef.current,
        (id) => {
          const st = ds.stateStore.get(id);
          return st.pinned || (!st.done && !st.hidden);
        },
      );
      if (unshown.length > 0) s.add(feedId);
    }
    return s;
  }, [perGroupMore, perFeedLimit, items, displayedByFeed, ds, storeVersion]);
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
  // Titles and favicons come from `items` (the cached page still carries the
  // feed metadata even when every base row is filtered out of visibleItems),
  // so the phantom header keeps the same icon the live header showed.
  const emptyMoreSections = useMemo(() => {
    if (!feedsWithMore || feedsWithMore.size === 0) return undefined;
    const visibleFeedIds = new Set<FeedId>();
    for (const fi of visibleItems) visibleFeedIds.add(fi.item.feedId);
    const out: Array<{ feedId: FeedId; title: string; faviconUrl: string | null }> =
      [];
    const meta = new Map<FeedId, { title: string; faviconUrl: string | null }>();
    for (const fi of items) {
      if (!meta.has(fi.item.feedId)) {
        meta.set(fi.item.feedId, {
          title: fi.feed.title,
          faviconUrl: fi.feed.faviconUrl,
        });
      }
    }
    for (const feedId of feedsWithMore) {
      if (visibleFeedIds.has(feedId)) continue;
      const m = meta.get(feedId);
      if (m === undefined) continue; // feed dropped out of items entirely
      out.push({ feedId, title: m.title, faviconUrl: m.faviconUrl });
    }
    return out.length > 0 ? out : undefined;
  }, [feedsWithMore, visibleItems, items]);

  const loadingFeeds = useMemo(() => {
    if (!perGroupMore) return undefined;
    // A reveal is instant, so the only "Loading…" state left is a section the
    // reader tapped while the base query was refetching: its tap is deferred
    // (see `pendingFeedMore`) and fires once the refetch settles. A
    // *background* refetch the reader never tapped doesn't flip any section's
    // More to "Loading…" — those buttons stay a stable, tappable "More", and a
    // tap during that window is deferred rather than dropped.
    const s = new Set<FeedId>();
    for (const feedId of pendingFeedMore) s.add(feedId);
    return s;
  }, [perGroupMore, pendingFeedMore]);

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
      // Discount the auto-hide scroll-space (blank tail below the last real row):
      // the list "ends" at the last row, not at the bottom of the empty tail, so
      // the pinned-bar pager settles into "No more items" — and stops paging the
      // reader down into blank — once the real content foot is in view.
      const tail = scrollSpaceRef.current?.offsetHeight ?? 0;
      // Within 2px of the maximum scroll offset = the foot of the list is in
      // view (the sub-pixel slack avoids a sticky "More" at exact bottom).
      setAtListEnd(
        window.scrollY + window.innerHeight >= doc.scrollHeight - tail - 2,
      );
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
  // `isRefreshing` mirrored into a ref so the always-on scroll tracker (mounted
  // once, empty deps) and lockBodyHeight can tell a background-refresh lock from a
  // dismiss lock without re-subscribing. A refresh holds `heightLockedRef` too, but
  // unlike a dismiss it never clamps the reader (the freeze holds the document
  // tall), so the tracker must keep recording through it — see below.
  const isRefreshingRef = useRef(false);
  isRefreshingRef.current = isRefreshing;
  // The reader's last genuine scroll offset, tracked so a dismiss can restore it
  // if the browser clamped it. Recorded on scroll while the viewport is honest and
  // no DISMISS settle owns the offset (a clamp's scroll event during a dismiss would
  // poison it) — but NOT suppressed during a plain background refresh, where the
  // reader scrolls freely and window.scrollY is honest truth.
  const readerScrollYRef = useRef<number | null>(null);
  // Set synchronously by lockBodyHeight when a dismiss/sweep commits while the
  // viewport is ALREADY spiking (innerHeight lying vs. the visual viewport). The
  // spike often fires-and-reverts entirely between the commit and the settle
  // effect's first async sample — the diagnostics only ever caught it on the
  // *synchronous* Done marker — so the settle can't rely on observing it live.
  // This hands that synchronous observation to the settle, which then knows to
  // restore the reader once the viewport is honest again. Consumed (cleared) by
  // the settle effect.
  const spikeSeenAtCommitRef = useRef(false);
  // The reader's offset SNAPSHOT taken the moment a spike is first observed at a
  // dismiss/sweep, frozen so the settle's restore target can't be corrupted by the
  // window between capture and settle. It matters for the animated sweep: the tap
  // sets `spikeSeenAtCommitRef` but the height lock / restore watcher don't engage
  // until commitSweep ~200ms later, and if the spike reverts mid-animation a normal
  // scroll event can land at the CLAMPED offset while `viewportIsHonest()` is true
  // and overwrite `readerScrollYRef`. Snapshotting the pre-spike offset here (the
  // tracker skipped the spike, so the ref still holds it) keeps the restore aimed
  // at where the reader really was. First-write-wins; consumed by the settle.
  const spikeIntendedYRef = useRef<number | null>(null);
  // WRITE-ONCE latch: has this device EVER exhibited the dynamic-toolbar
  // innerHeight spike in this view? Set the first time a spike is observed in a
  // dismiss/sweep flow (the commit sample, the sweep tap, or the settle watch) and
  // NEVER reset.
  // `holdFor` reads it to size the deferred hold spike-safe (a durable extra
  // viewport of tail so a later spike can't clamp) on a spiking device, tight on an
  // ordinary one. Deliberately coarse — "does this device spike?", not "did THIS
  // dismiss spike?": a per-dismiss flag has to be set/preserved/reset correctly
  // across the fresh-lock, reused-lock, sweep-tap, settle, hold-clear, and restore
  // paths, and every one of those transitions was a bug (Codex P2s ×4 on #406). A
  // monotonic latch has no lifecycle, so none of those edges exist. The cost is
  // that once a device has spiked, its later honest dismisses also get the
  // (off-screen, protective) tail — harmless, since it genuinely is a spiking
  // device. A fresh mount re-latches on the first spike it sees.
  const deviceSpikesRef = useRef(false);
  // The sweep's scroll-anchoring opt-out (overflow-anchor: none) has a SHORTER
  // life than the height lock: it's needed only for the single layout where the
  // swept in-viewport rows leave the DOM, whereas the min-height freeze must
  // persist across the whole post-sweep refetch. Tracked separately so a
  // post-paint effect can drop it one frame after the removal — keeping
  // anchoring available for any auto-hide-on-scroll removal the reader triggers
  // by scrolling during that refetch (those remove rows above the viewport and
  // depend on anchoring to hold the first still-visible row steady).
  const anchorLockedRef = useRef(false);
  // A deferred height-lock release armed on the reader's next scroll — see
  // releaseBodyHeight. Held here so it can be torn down on unmount and whenever
  // a fresh lock is taken.
  const heightReleaseScrollRef = useRef<(() => void) | null>(null);
  // The scroll offset the deferred release is currently holding via min-height.
  // The clear/re-apply inside holdFor momentarily clamps window.scrollY and the
  // browser fires a `scroll` event for it; this lets the deferred listener tell
  // that self-induced echo (scrollY back on this value) from a real reader
  // scroll, so it never mistakes its own reflow for the reader scrolling up.
  const heldReleaseScrollYRef = useRef<number | null>(null);
  // The animation-frame chain deferring a no-refetch freeze release across the
  // dismiss's momentary document collapse (see DISMISS_SETTLE_FRAMES and the
  // release effect near the bottom of the component). Held so a fresh lock, a
  // background refresh, or unmount can cancel it.
  const dismissReleaseRafRef = useRef<number | null>(null);
  // Tears down the transient-viewport-clamp restore watcher (its scroll/resize
  // listeners + bounding timer) armed by the settle effect. Held so a fresh
  // dismiss, a background refresh, or unmount can end the previous watch.
  const dismissRestoreCleanupRef = useRef<(() => void) | null>(null);
  // Tear down a deferred height-lock release (the scroll listener armed by
  // releaseBodyHeight). Safe to call when none is pending.
  const detachHeightRelease = useCallback(() => {
    if (heightReleaseScrollRef.current) {
      window.removeEventListener('scroll', heightReleaseScrollRef.current);
      heightReleaseScrollRef.current = null;
    }
    heldReleaseScrollYRef.current = null;
  }, []);
  // Cancel a pending settle-frame release (see the release effect below). Safe to
  // call when none is scheduled.
  const cancelDismissRelease = useCallback(() => {
    if (dismissReleaseRafRef.current !== null) {
      if (typeof cancelAnimationFrame === 'function')
        cancelAnimationFrame(dismissReleaseRafRef.current);
      dismissReleaseRafRef.current = null;
    }
    if (dismissRestoreCleanupRef.current) {
      dismissRestoreCleanupRef.current();
      dismissRestoreCleanupRef.current = null;
    }
  }, []);
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
    // Sample the viewport SYNCHRONOUSLY at the commit — this runs inside the
    // dismiss's hide()/hideMany(), the one moment the diagnostics prove the
    // innerHeight spike is observable (the Done marker) before it reverts. If it's
    // already lying, flag it AND snapshot the reader's pre-spike offset so the
    // settle restores the right place even if no async event samples the spike.
    if (!viewportIsHonest()) {
      spikeSeenAtCommitRef.current = true;
      deviceSpikesRef.current = true; // latch: this device spikes
      if (spikeIntendedYRef.current === null)
        spikeIntendedYRef.current = readerScrollYRef.current;
    }
    const el = bodyRef.current;
    if (!el) return;
    // Sweep-only: opt the body out of the browser's scroll anchoring for the
    // frame in which the swept rows leave the DOM. A Sweep dismisses the rows
    // that are fully inside the viewport, collapsing a scrolled-into section by
    // up to a viewport of height. Anchoring would react by rewinding
    // window.scrollY by that height to keep a row *below* the swept ones fixed —
    // and when the collapse is taller than the current scroll offset, the rewind
    // clamps scrollY to 0 and snaps the reader to the top. The min-height lock
    // can't stop this on its own: anchoring adjusts off the anchor element's
    // movement, not the document's total height. Nothing above the viewport top
    // is removed by a Sweep, so the offset should simply hold — disabling
    // anchoring delivers that. Scoped to the sweep path (only lockBodyHeight
    // sets it) precisely so auto-hide-on-scroll — which removes rows *above* the
    // viewport and relies on anchoring to keep the first still-visible row fixed
    // — keeps its anchoring. The opt-out is dropped one frame after the removal
    // paints (the post-paint release effect below), NOT held for the whole
    // refetch like the min-height lock — otherwise an auto-hide triggered by
    // scrolling mid-refresh would lose anchoring too.
    //
    // Set unconditionally — even when a height lock is already held. A general
    // background refresh (pin/dismiss/auto-hide) takes the min-height lock via
    // the layout effect below WITHOUT disabling anchoring (correctly — those
    // paths don't remove in-viewport rows). If the reader then sweeps mid-
    // refresh, this is the only place that opts anchoring out, so it must run
    // even though `heightLockedRef` is already true; otherwise the swept rows
    // leave with anchoring live and the top-snap recurs. Only the height
    // *measurement* is gated on the lock (re-measuring now would freeze the
    // already-shrunken mid-refresh list too short).
    el.style.overflowAnchor = 'none';
    anchorLockedRef.current = true;
    // The spike-proof floor: the body min-height that keeps the reader's offset
    // scrollable even if the dynamic toolbar momentarily doubles `window.innerHeight`.
    // At the bottom a plain freeze holds `scrollHeight`, but the glitch clamps a
    // different way — since `maxScroll = scrollHeight − innerHeight`, the doubled
    // viewport drops the ceiling below where the reader sits and the browser clamps
    // `scrollY` up (the grow-then-collapse flash we'd otherwise only undo reactively).
    // Sizing the freeze so even a doubled `innerHeight` keeps `maxScroll` at or above
    // the reader's offset stops that clamp from ever firing. Measured from the body's
    // document-space top + trailing footer (NOT `offsetHeight`), so it's valid even
    // mid-refresh when the list may have momentarily reflowed shorter.
    //
    // `target` is the offset the settle will protect. Prefer the pre-spike snapshot
    // (set at a sweep tap / when a spike is already in progress); otherwise read the
    // reader's CURRENT position straight from `window.scrollY` when the viewport is
    // honest.
    // Reading it live matters for the reused-lock path: while a background refresh
    // holds the lock the always-on scroll tracker is frozen (it bails on
    // `heightLockedRef`), so `readerScrollYRef` can be stale if the reader scrolled
    // during the refresh — but the refresh freeze holds the document tall, so
    // `window.scrollY` is their true, un-clamped offset (Codex P2 on #405). Fall back
    // to the tracker only when the viewport is spiking (then `scrollY` may itself be
    // clamped and the tracker holds the last honest value).
    const honestNow = typeof window !== 'undefined' && viewportIsHonest();
    const target =
      spikeIntendedYRef.current ??
      (honestNow ? Math.round(window.scrollY) : readerScrollYRef.current) ??
      (typeof window !== 'undefined' ? Math.round(window.scrollY) : 0);
    const rect = el.getBoundingClientRect();
    const bodyTopDoc = rect.top + (typeof window !== 'undefined' ? window.scrollY : 0);
    const root = el.closest('.item-list');
    const trailing = root
      ? Math.max(0, root.getBoundingClientRect().bottom - rect.bottom)
      : 0;
    const peakInner = VIEWPORT_SPIKE_PEAK_RATIO * layoutViewportHeight();
    // Only provision when a peak spike could ACTUALLY clamp the reader — i.e. the
    // natural (unlocked) document wouldn't keep `target` scrollable under a doubled
    // innerHeight. Away from the bottom, or at the top (`target` small), the plain
    // height already holds them, so this is 0 and nothing is over-provisioned.
    const naturalDocHeight = bodyTopDoc + el.offsetHeight + trailing;
    const spikedMax = Math.max(0, naturalDocHeight - peakInner);
    const spikeSafe =
      target > spikedMax ? target + peakInner - bodyTopDoc - trailing : 0;
    if (heightLockedRef.current) {
      // A background refresh (or an earlier dismiss) already holds the lock at the
      // plain pre-refresh height. Don't re-measure `offsetHeight` (mid-refresh it can
      // be momentarily shorter) or disturb a deferred release's held slack — but DO
      // raise the floor to spike-safe so a Sweep/Done landing during that refresh is
      // still defended. Only ever raises the hold, never lowers it.
      const current = parseFloat(el.style.minHeight) || 0;
      if (spikeSafe > current) el.style.minHeight = `${spikeSafe}px`;
      // When a BACKGROUND REFRESH owns the lock the no-refetch settle bails while
      // `isRefreshing`, so it can't restore a clamp — and a spike already live at
      // this commit has already clamped `scrollY`. Restore inline: the raise above
      // lifted `maxScroll` back to `target`, so `scrollTo` reaches it even mid-spike.
      // Gated to the refresh case — a reused lock from an earlier DISMISS is handled
      // by that dismiss's own settle (which re-runs on this removal), so we mustn't
      // fight it here (Codex P2 on #405).
      if (
        isRefreshingRef.current &&
        spikeSeenAtCommitRef.current &&
        typeof window !== 'undefined'
      ) {
        // Reflow the just-raised min-height so scrollTo clamps against the new, taller
        // max rather than the pre-raise one (else the restore silently no-ops).
        void document.documentElement.scrollHeight;
        if (Math.round(window.scrollY) !== target) window.scrollTo(0, target);
      }
      return;
    }
    // Fresh lock. Don't clear a deferred bottom-sweep release's slack first — it's
    // the only thing holding `window.scrollY` off the shorter natural bottom;
    // measuring `offsetHeight` with it still applied folds it into the new lock so
    // the offset holds. Freeze at the taller of that and the spike-safe floor; the
    // extra tail sits off-screen below the reader (empty space below is the intended
    // resting state after a bottom dismiss/Sweep). A clamp the browser baked before
    // this ran, or a spike beyond the peak ratio, still falls back to the reactive
    // restore in the settle effect below.
    detachHeightRelease();
    el.style.minHeight = `${Math.max(el.offsetHeight, spikeSafe)}px`;
    heightLockedRef.current = true;
  }, [detachHeightRelease]);

  // Release the body height lock without letting the document snap shorter than
  // the reader's current scroll offset.
  //
  // The min-height freeze holds the document tall through the post-sweep
  // refetch (above). But a Sweep removes rows *for good*, so once the refetch
  // returns the survivors the document is permanently shorter. If the reader had
  // scrolled past where it now ends — e.g. they swept a feed near the bottom of
  // the loaded list — simply clearing min-height lets the browser clamp
  // window.scrollY toward the top, sliding every still-pinned group header down
  // (the reported "the group header moves when you sweep a group"). The
  // overflow-anchor opt-out doesn't help here: it's already been dropped, and it
  // only stops the anchor *rewind*, not the document-too-short *clamp*.
  //
  // So when clearing would clamp, keep exactly enough min-height to hold the
  // current scroll and finish the release on the reader's next scroll — when
  // they're driving, so the document settling to its natural height reads as
  // their own scrolling rather than a jump under their eyes. The held slack
  // shrinks in lockstep as they scroll up and clears the moment the natural
  // document can hold the offset, so there's never a persistent blank tail.
  // A no-op (plain clear) whenever the natural document is already tall enough —
  // every sweep except one near the very bottom.
  //
  // `targetY` overrides the offset to hold. The no-refetch/refetch release paths
  // pass nothing and hold the reader's *current* (browser-anchored) scroll, which
  // is already correct. The viewport-spike restore passes the reader's tracked
  // pre-spike offset instead: an innerHeight spike clamps window.scrollY below
  // where the reader actually was and the browser never un-clamps it, so the
  // current offset is the wrong (clamped) value — the pre-spike offset is what
  // must stay valid, holding the reader put with a blank tail rather than
  // snapping them to the collapsed new bottom.
  const releaseBodyHeight = useCallback((targetY?: number) => {
    const el = bodyRef.current;
    detachHeightRelease();
    if (!el) return;
    if (typeof window === 'undefined') {
      el.style.minHeight = '';
      return;
    }
    // Hold the document just tall enough that `target` stays a valid scroll
    // offset, restoring the scroll the clear may have already clamped — measured
    // and corrected synchronously, before paint, so no clamp is ever shown.
    // Returns the leftover slack (0 once the natural document holds `target`).
    //
    // The body height needed to keep `target` scrollable is derived from the
    // body's *document-space top* (`getBoundingClientRect().top + scrollY`) — the
    // fixed chrome above it — NOT from `document.documentElement.scrollHeight`.
    // The browser clamps `scrollHeight` UP to the viewport height, so when the
    // post-sweep document is shorter than one viewport (a bottom group swept out
    // of an otherwise-collapsed list) a scrollHeight-based deficit reads as 0 and
    // under-provisions the min-height — the document then can't hold `target` and
    // the reader snaps to the top. The body-top measurement isn't clamped, so the
    // needed height is correct even for a sub-viewport document.
    const holdFor = (target: number): number => {
      el.style.minHeight = '';
      // Fixed chrome above the body, in document coordinates (invariant across
      // scroll — the +scrollY cancels the clear-induced clamp).
      const bodyRect = el.getBoundingClientRect();
      const bodyTopDoc = bodyRect.top + window.scrollY;
      const naturalBody = el.offsetHeight;
      // In-flow content below the body — the relative-mode bottom `ListToolbar`
      // and the refresh strip render after `.item-list__body` inside the
      // `.item-list` root. Measure it floor-free from the layout boxes
      // (`getBoundingClientRect`), NOT from `documentElement.scrollHeight` (which
      // the browser floors UP to the viewport height, hiding the footer whenever
      // the surviving document is sub-viewport). Bounding the measurement to the
      // list root means any content BELOW the root is conservatively ignored, so
      // `trailing` can only be under-counted — which over-provisions the hold
      // (harmless) rather than under-provisioning it (which would reintroduce the
      // snap-to-top this fix exists to prevent).
      const root = el.closest('.item-list');
      const trailing = root
        ? Math.max(0, root.getBoundingClientRect().bottom - bodyRect.bottom)
        : 0;
      // How much viewport the hold must keep below `target`. TIGHT (`innerHeight`) on
      // an ordinary device — no spurious blank tail. SPIKE-SAFE (`2 × innerHeight`)
      // once this device has EVER shown the dynamic-toolbar spike (`deviceSpikesRef`).
      // A tight hold keeps `target` scrollable only at the honest viewport, but on a
      // spiking device the toolbar keeps doubling `innerHeight` for SECONDS after the
      // dismiss settles, and each spike drops `maxScroll = doc − innerHeight` below
      // `target` and clamps the reader up (the reported "still jumping": a spike after
      // the Done dragged them −262px). Holding `target + 2 × innerHeight` keeps
      // `maxScroll` at or above `target` even under a doubled viewport, so a later
      // spike can't clamp. The extra ~1 viewport of tail is the intended
      // empty-below-after-a-bottom-sweep state; it clears as the reader scrolls up.
      const holdViewport = deviceSpikesRef.current
        ? VIEWPORT_SPIKE_PEAK_RATIO * layoutViewportHeight()
        : window.innerHeight;
      // The unlocked document's true content height and max scroll, used to decide
      // whether the natural document already holds `target` (i.e. whether to
      // release). Floor-free: chrome above + body + trailing footer below.
      const naturalDocHeight = bodyTopDoc + naturalBody + trailing;
      const naturalMax = Math.max(0, naturalDocHeight - holdViewport);
      if (target <= naturalMax) {
        // The natural (unlocked) document already holds `target` — no min-height
        // needed. Still restore a clamped reader to `target` (a spike restore hands
        // us the pre-clamp offset while `window.scrollY` is the clamped one); a no-op
        // for the on-scroll path, where `target` IS the current offset.
        heldReleaseScrollYRef.current = null;
        if (Math.round(window.scrollY) !== target) window.scrollTo(0, target);
        return 0;
      }
      // Body height that keeps the document tall enough to scroll to `target`. The
      // trailing footer sits below the body, so the body needs `trailing` LESS height
      // to put `target` at the document's max scroll.
      const neededBody = target + holdViewport - bodyTopDoc - trailing;
      el.style.minHeight = `${neededBody}px`;
      // Force the just-applied min-height to reflow BEFORE restoring the scroll,
      // so window.scrollTo clamps against the new (taller) max rather than the
      // momentarily-shrunken one from the clear above — otherwise the restore
      // silently no-ops and the reader is left at the clamped-to-top offset.
      void document.documentElement.scrollHeight;
      if (Math.round(window.scrollY) !== target) window.scrollTo(0, target);
      // Remember the offset we're now holding, so the deferred listener below
      // can tell our own reflow-induced scroll events from the reader's.
      heldReleaseScrollYRef.current = Math.round(window.scrollY);
      return neededBody - naturalBody;
    };
    // Capture the offset BEFORE clearing — clearing reflows synchronously and
    // the browser clamps window.scrollY toward the top, so reading it after the
    // clear would already be the clamped (wrong) value. An explicit `targetY`
    // (the spike restore's pre-clamp offset) wins over the live, already-clamped
    // scrollY.
    const holdTarget = targetY ?? Math.round(window.scrollY);
    if (holdFor(holdTarget) <= 0) return;
    // Slack still held: shrink it in lockstep as the reader scrolls UP (they're now
    // driving, so the settle reads as their scrolling, not a jump), and drop it
    // entirely once the natural document can hold where they are under a spike.
    const onScroll = () => {
      if (!bodyRef.current) {
        detachHeightRelease();
        return;
      }
      const y = Math.round(window.scrollY);
      // Clearing then re-applying min-height inside holdFor momentarily clamps
      // window.scrollY (the document shrinks for one synchronous beat), and the
      // browser fires a `scroll` event for that clamp even though holdFor
      // restores the offset in the same frame. Ignore a scroll that lands back
      // on the offset we're already holding: it's our own reflow echo, not the
      // reader. Acting on it would run holdFor(clampedTop) and drop the slack —
      // snapping the reader to the top after a bottom-group sweep, the very jump
      // this whole mechanism exists to prevent.
      if (heldReleaseScrollYRef.current !== null && y === heldReleaseScrollYRef.current) {
        return;
      }
      // Reader scrolled DOWN into the held blank tail (at or past the held offset):
      // leave the spike-safe hold intact. Re-running holdFor here would either yank
      // them back up to the held offset or grow the tail to chase them downward —
      // both wrong. The tail is theirs to scroll into (it's the swept rows' space).
      if (y >= holdTarget) return;
      // Reader scrolled UP: shrink the hold to match their new position (still
      // spike-safe), releasing entirely once the natural document holds them.
      if (holdFor(y) <= 0) detachHeightRelease();
    };
    heightReleaseScrollRef.current = onScroll;
    window.addEventListener('scroll', onScroll, { passive: true });
  }, [detachHeightRelease]);

  // Never leave a deferred-release scroll listener attached past unmount.
  useEffect(() => detachHeightRelease, [detachHeightRelease]);

  // Track the reader's genuine scroll offset so a dismiss can restore it after a
  // clamp (see the release effect). Recorded only when it's trustworthy:
  //  - not while a DISMISS holds the height lock, or a restore watch owns the offset
  //    — a clamp's scroll event during those would poison it. A background REFRESH
  //    holds the lock too, but there the reader scrolls freely with no clamp (the
  //    freeze holds the document tall), so we KEEP recording through it; otherwise a
  //    scroll during the refresh leaves the ref stale and a spike-at-commit that
  //    lands mid-refresh protects/restores the wrong offset (Codex P2 on #405);
  //  - not while the viewport is spiking — the clamp's own scroll event fires as
  //    the browser reverts innerHeight, landing at a near-honest viewport, so it
  //    would otherwise be adopted as a "genuine" scroll to the clamped offset.
  //    Gating on viewportIsHonest() keeps the ref on the reader's real position.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onScroll = () => {
      if (
        (heightLockedRef.current && !isRefreshingRef.current) ||
        dismissRestoreCleanupRef.current
      )
        return;
      if (!viewportIsHonest()) return;
      readerScrollYRef.current = Math.round(window.scrollY);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // A single in-viewport mark-done — the row menu's Done, the wide-viewport Done
  // button, the `d` shortcut, or a swipe-right (all route through `store.hide`)
  // — flips one row Done, which drops it from `visibleItems` in the very next
  // commit. Like a Sweep, that row leaving the DOM lets the browser's scroll
  // anchoring rewind window.scrollY to keep a row *below* it fixed, shifting
  // everything above and yanking the scroll position out from under the reader.
  // Take the same anchor opt-out (+ height freeze) the instant the flip lands —
  // synchronously, while the row is still on screen — so the offset holds
  // exactly: the dismissed row's gap closes from below and nothing above moves.
  //
  // Excluded:
  //  - Auto-hide-on-scroll removes rows that just left the TOP of the viewport
  //    and depends on anchoring to keep the first still-visible row fixed; its
  //    ids are flagged in `autoHideInFlightRef` for the synchronous window of
  //    their hideMany, so they're skipped here.
  //  - Sweep already calls lockBodyHeight itself before its hideMany; the second
  //    idempotent call this triggers is harmless.
  //  - A Done flip on a row not rendered in this list (another view dismissing on
  //    the shared store) has no element here, so it's a no-op.
  // The opt-out is dropped a frame after the removal paints by the existing
  // post-paint release effect (keyed on visibleItems.length); the height lock
  // releases when the background refresh settles.
  useEffect(() => {
    return ds.stateStore.subscribeMutations((id, changed) => {
      if (changed.done !== true) return;
      if (autoHideInFlightRef.current?.has(id)) return;
      if (!document.querySelector(`[data-item-id="${id}"]`)) return;
      lockBodyHeight();
    });
  }, [ds, lockBodyHeight]);

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
    // Sweep clears the visible set, grayed cross-device dismisses included. A
    // grayed row is already done, so hideMany is a no-op for it and the mutation
    // channel never fires — record every swept id as locally dismissed so the
    // overlay drops the grayed rows too, not just the freshly-dismissed ones.
    for (const id of ids) localDismissedIdsRef.current.add(id);
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
      // Sample the viewport at the TAP, not just at the commit. The animated
      // sweep defers lockBodyHeight (its synchronous spike sample) to commitSweep
      // ~200 ms later — long after a ~40 ms dynamic-toolbar spike has reverted —
      // so if the viewport is already lying when the broom is tapped, only this
      // catches it (Codex P2 on #402). Snapshot the pre-spike offset now too: the
      // tracker stays live until the deferred commit, so a scroll landing at the
      // clamped offset during the gap could otherwise overwrite readerScrollYRef.
      // Both persist until the settle pass (which the commit kicks off) consumes them.
      if (!viewportIsHonest()) {
        spikeSeenAtCommitRef.current = true;
        deviceSpikesRef.current = true; // latch: this device spikes
        if (spikeIntendedYRef.current === null)
          spikeIntendedYRef.current = readerScrollYRef.current;
      }
      const reducedMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reducedMotion) {
        // No animation to wait on, so the rows leave immediately — grab the
        // height first, same as the animated commitSweep path does.
        lockBodyHeight();
        // Grayed cross-device dismisses are already done → record them as locally
        // dismissed so the overlay drops them (see commitSweep).
        for (const id of batch) localDismissedIdsRef.current.add(id);
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
  // Grouped section-header Undo. Routes through the same restored-ids scroll
  // callback as the toolbar Undo so a header Undo after a scroll-past burst also
  // brings the topmost restored row back on screen (Codex P2 on PR #229).
  const handleUndo = useCallback(() => {
    const restored = ds.stateStore.undoLast();
    handleUndoScroll(restored);
  }, [ds, handleUndoScroll]);

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
    const headers = new Map<
      ItemId,
      { feedId: FeedId; title: string; faviconUrl: string | null }
    >();
    let lastFeedId: FeedId | null = null;
    for (const fi of visibleItems) {
      if (fi.item.feedId !== lastFeedId) {
        headers.set(fi.item.id, {
          feedId: fi.item.feedId,
          title: fi.feed.title,
          faviconUrl: fi.feed.faviconUrl,
        });
        lastFeedId = fi.item.feedId;
      }
    }
    return headers;
  }, [groupByFeed, visibleItems]);

  // The feeds whose section headers are currently rendered: every feed with a
  // visible row, plus the phantom (swept-empty) More sections — their headers
  // are just as much "in view". Drives the toolbar Collapse/Expand-all and the
  // unread-count badge query; without the phantom ids a swept-empty section
  // dropped out of the count read and its badge went blank even though the
  // feed still held unread articles behind its More button.
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
    for (const p of emptyMoreSections ?? []) {
      if (!seen.has(p.feedId)) {
        seen.add(p.feedId);
        out.push(p.feedId);
      }
    }
    return out;
  }, [groupByFeed, visibleItems, emptyMoreSections]);

  // Per-feed unread/to-do counts for the section-header badges (group-by-feed
  // only). Keyed under ['feed', …] so the app-wide feed invalidation
  // (useFeedInvalidation, fired on every item-state change) refreshes the badges
  // when you sweep / open / mark done, alongside the list itself. Disabled
  // outside the grouped view (no headers to badge).
  //
  // `keepPreviousData`: the key changes whenever the set of feeds in view does —
  // under auto-hide-on-scroll a section empties (and drops out of the key)
  // mid-scroll, which would otherwise blank EVERY badge until the new key's
  // fetch lands. Painting the previous counts through the refetch keeps the
  // surviving headers' badges steady.
  //
  // The server count lags local triage by a sync round-trip, so the badge is
  // reconciled through `unreadLedger` below. The queryFn snapshots which noted
  // dismissals had already drained (synced) when the fetch started: the server
  // answered after those writes committed, so the moment this response lands
  // the ledger can retire their decrements — and not a render before, which is
  // what keeps the badge from bouncing up between drain and refetch.
  const unreadLedgerRef = useRef(new UnreadDecrementLedger());
  const { data: unreadCountsFetch } = useQuery({
    queryKey: ['feed', 'unread-counts', feedIdsInView.join(',')],
    queryFn: async () => ({
      reflected: unreadLedgerRef.current.drainedIds(
        ds.pendingItemIds?.() ?? EMPTY_ID_SET,
        new Set(feedIdsInView),
      ),
      counts: await ds.getFeedUnreadCounts(feedIdsInView),
    }),
    enabled: groupByFeed && feedIdsInView.length > 0,
    placeholderData: keepPreviousData,
  });

  // Reconcile the server count with local triage: a row the user just took out
  // of the unread set (Sweep, row Done, auto-hide-on-scroll) discounts its
  // feed's badge immediately and the decrement HOLDS — through the outbox drain
  // and the row dropping out of the loaded pages — until a count response that
  // reflects the write lands (or an Undo restores the row). See
  // UnreadDecrementLedger for the lifecycle. `storeVersion` (bumped on every
  // local mutation and on outbox drain via notifySynced) keys the recompute.
  // No-op on the mock, which has no outbox and whose count is never stale.
  //
  // On top of the ledger, rows buffered for auto-hide get a PROVISIONAL
  // decrement: a top-exit is held until the viewport settles before its
  // dismissal write commits (see handleExitTop/armSettleFlush), but the badge
  // must not wait for the write — it counts the row out the moment it leaves
  // the screen, mid-gesture. When the flush commits, the write's ledger entry
  // replaces the provisional decrement in the same render (the buffer clears
  // as hideMany applies); a row scrolled back into view is pruned from the
  // buffer and its decrement lifts. `exitBufferVersion` keys both transitions.
  const adjustedUnreadCounts = useMemo(() => {
    if (!groupByFeed || !unreadCountsFetch) return undefined;
    void storeVersion;
    void exitBufferVersion;
    const ledger = unreadLedgerRef.current;
    const getState = (id: ItemId) => ds.stateStore.get(id);
    // Tolerate a persisted cache written by the previous build (guardrail
    // #11): it stored the bare counts map, not {reflected, counts}. On an
    // offline boot right after an upgrade that restored value may be all the
    // badge ever gets — read it as counts with no snapshot rather than
    // blanking every header until a successful refetch.
    const legacyShape =
      typeof unreadCountsFetch.counts !== 'object' ||
      unreadCountsFetch.counts === null;
    const serverCounts = legacyShape
      ? (unreadCountsFetch as unknown as Record<FeedId, number>)
      : unreadCountsFetch.counts;
    ledger.noteDismissals(
      mergedRaw,
      getState,
      ds.pendingItemIds?.() ?? EMPTY_ID_SET,
    );
    ledger.retire(legacyShape ? null : unreadCountsFetch.reflected, getState);
    let counts = ledger.apply(serverCounts);
    const buffered = bufferedExitTopRef.current;
    if (buffered.size > 0) {
      let out: Record<FeedId, number> | null = null;
      for (const fi of mergedRaw) {
        if (!buffered.has(fi.item.id)) continue;
        // Only rows the server still counts as unread: a pinned row will be
        // shielded from the flush, and a Done/Hidden/Opened one has already
        // stopped counting (or is the ledger's to discount).
        const st = getState(fi.item.id);
        if (st.pinned || st.done || st.hidden || st.opened) continue;
        const feedId = fi.item.feedId;
        if ((out ?? counts)[feedId] == null) continue;
        out ??= { ...counts };
        out[feedId] = Math.max(0, out[feedId] - 1);
      }
      if (out) counts = out;
    }
    return counts;
  }, [
    groupByFeed,
    unreadCountsFetch,
    mergedRaw,
    ds,
    storeVersion,
    exitBufferVersion,
  ]);

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
  // The sweep path additionally opts the body out of scroll anchoring while its
  // rows leave the DOM (see lockBodyHeight) — that's a separate clamp (the
  // anchor rewind) the height freeze alone can't stop. Background refreshes that
  // don't remove in-viewport rows (pin/dismiss, auto-hide-on-scroll) keep
  // anchoring, so a row removed above the viewport still holds the view steady.
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
      // General background-refresh lock (pin/dismiss/auto-hide): freeze height
      // only. Anchoring is deliberately left ON here — auto-hide-on-scroll
      // removes rows above the viewport and needs it to keep the first visible
      // row fixed. Only the sweep path (lockBodyHeight) opts anchoring out.
      //
      // Take over any deferred bottom-sweep release the same way lockBodyHeight
      // does: drop its pending scroll listener (but NOT its held slack — that's
      // folded into the lock by measuring offsetHeight with it still applied) so
      // a scroll during this refetch can't run the stale release and clear
      // min-height while we're still locked, shrinking the document under the
      // reader.
      detachHeightRelease();
      el.style.minHeight = `${el.offsetHeight}px`;
      heightLockedRef.current = true;
    } else if (!isRefreshing && heightLockedRef.current) {
      // Release without letting the now-shorter post-sweep document clamp the
      // scroll (which would slide every pinned group header down).
      releaseBodyHeight();
      // Defensive: the sweep anchor opt-out is normally dropped a frame after
      // the removal (the dedicated effect below), well before the refetch
      // settles — but clear it here too so a held lock never strands it.
      if (anchorLockedRef.current) {
        el.style.overflowAnchor = '';
        anchorLockedRef.current = false;
      }
      heightLockedRef.current = false;
    }
  }, [isRefreshing, showMissState, releaseBodyHeight, detachHeightRelease]);

  // Backstop release for a no-refetch freeze (a lone Done or a Sweep — neither
  // refetches, so `isRefreshing` never flips and the layout effect above never
  // drives the release). lockBodyHeight() takes the freeze synchronously while
  // the dismissed rows are still on screen; this post-paint effect drives the
  // release once nothing is refreshing. It also covers the offline partial-sweep
  // case the layout effect misses: with rows remaining, `showMissState` stays
  // false so that effect never re-runs, and without this the body would keep its
  // pre-dismiss min-height forever (a persistent blank tail). Re-runs after a
  // dismiss via `visibleItems`; a no-op online, where isRefreshing is held true
  // across a bridging refetch and the layout effect still owns that release.
  //
  // The release is deferred a few animation frames past the row-removal commit
  // rather than run on it — see DISMISS_SETTLE_FRAMES. A dismiss triggers a
  // momentary document collapse a beat AFTER the removal paints; clearing the
  // freeze on the removal commit leaves that dip unguarded and the browser clamps
  // window.scrollY toward the top (the reported jump). Holding the min-height
  // across the settle frames keeps the document tall through the dip, so the
  // offset is never clamped; the release then lands on the recovered height.
  useEffect(() => {
    // Any re-run supersedes a pending settle: cancel it, then re-decide below.
    // (A fresh removal reschedules; a refresh taking over cancels for good.)
    cancelDismissRelease();
    // Consume the synchronous spike flag + offset snapshot UP FRONT — before the
    // guard — so a settle that early-returns (a background refresh took over) can't
    // leave them stale to mislead the next dismiss.
    const spikeSeen = spikeSeenAtCommitRef.current;
    const spikeIntended = spikeIntendedYRef.current;
    spikeSeenAtCommitRef.current = false;
    spikeIntendedYRef.current = null;
    if (isRefreshing || !heightLockedRef.current || !bodyRef.current) return;
    const curMaxScroll = () =>
      typeof window === 'undefined'
        ? 0
        : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    // The offset this settle protects. When a spike was observed synchronously at
    // the commit, prefer the SNAPSHOT taken then (immune to the tracker being
    // polluted by a clamped-offset scroll during the tap→commit gap); otherwise
    // the reader's last honest position. Kept in a local so nothing can move the
    // target out from under a still-pending restore. `sawSpike` records that the
    // bogus innerHeight spike actually occurred — from that synchronous
    // observation, since the spike often reverts before any async sample — so a
    // restore only fires against a real clamp, never against the reader
    // legitimately scrolling to a shorter new bottom.
    let intended = spikeSeen
      ? spikeIntended ?? readerScrollYRef.current
      : readerScrollYRef.current;
    let sawSpike = spikeSeen;
    // The scrollY the watch last saw, so a change made while the viewport is
    // HONEST is recognized as the reader scrolling (superseding a pending clamp),
    // while the clamp's own jump — which happens while the viewport is spiking —
    // is absorbed, not mistaken for the reader. Seed it with the ACTUAL current
    // scrollY, NOT `intended`: when `spikeSeen` came from the synchronous capture
    // and the spike has already reverted by the time this runs (the animated-sweep
    // case — commit is ~200 ms behind a ~40 ms spike), scrollY is already the
    // clamped value. Seeding `lastWatchY = intended` (the PRE-clamp offset) would
    // make the very first watch() read that clamp as an honest reader move and
    // clear `sawSpike`, killing the restore (Codex P2 on #402). Seeding from the
    // real scrollY means the clamp reads as "no change" and the restore survives.
    let lastWatchY =
      typeof window !== 'undefined' ? Math.round(window.scrollY) : intended;
    const EPS = 2;
    // Restore the reader's protected offset once the viewport is honest again. A
    // spike (innerHeight lying tall vs. the visual viewport) slashes maxScroll and
    // the browser clamps scrollY down; when innerHeight tells the truth again
    // maxScroll re-grows, but the clamped offset stays put. So: note the spike
    // while it's live, and the moment the viewport is honest AND the ceiling again
    // reaches the protected offset, put the reader back. `min(intended, max)`
    // keeps it a no-op for the deferred bottom-sweep hold (whose ceiling sits at
    // the offset, not below it) and never scrolls past the real bottom.
    const watch = () => {
      if (intended == null || typeof window === 'undefined') return;
      const y = Math.round(window.scrollY);
      if (!viewportIsHonest()) {
        // Spiking: the ceiling is bogusly low and the browser may clamp scrollY.
        // Absorb whatever it does (record y) so the clamp jump isn't later read
        // as a reader move once the viewport is honest again. This device spikes, so
        // the deferred hold must be spike-safe (durable) once we release.
        sawSpike = true;
        deviceSpikesRef.current = true; // latch: this device spikes
        lastWatchY = y;
        return;
      }
      const max = curMaxScroll();
      // A scrollY change while the viewport is HONEST and landing in headroom is
      // the reader scrolling — adopt it as the new intent and drop the pending
      // clamp (their move supersedes the restore). The clamp's own jump never
      // reaches here: it happened while spiking and was absorbed above.
      if (
        lastWatchY != null &&
        Math.abs(y - lastWatchY) > EPS &&
        y < max - EPS
      ) {
        intended = y;
        sawSpike = false;
        lastWatchY = y;
        return;
      }
      lastWatchY = y;
      if (!sawSpike) return;
      // Wait for the min-height freeze to lift first: while it's held the ceiling
      // is the (inflated) frozen height, so restoring against it would land at the
      // OLD bottom, not the row-shorter new one. `curMaxScroll` reads the true
      // settled height only once the freeze is released.
      if (heightLockedRef.current) return;
      if (intended > max + 1 || intended - y > 1) {
        // Restore the reader's pre-spike offset AND size the deferred hold to keep it
        // valid. `releaseBodyHeight(intended)` handles both cases: when `intended`
        // sits past the collapsed natural bottom (a sweep removed more on-screen
        // content than the reader had below them) it holds a blank tail so they stay
        // exactly put rather than snapping to the new bottom; when it fits, it
        // restores them there. On a spiking device the hold is spike-safe, so a LATER
        // spike can't re-clamp the offset it just restored — sizing the hold for the
        // still-clamped `window.scrollY` instead would leave it spike-vulnerable.
        // Stop the spike-watch so the two don't fight over the scroll position.
        releaseBodyHeight(intended);
        intended = null;
        return;
      }
    };
    const runRelease = () => {
      const el = bodyRef.current;
      if (!el) return;
      // Size the release for the offset the reader will END UP at. When a spike is
      // pending restore that's `intended` (the pre-spike offset), NOT the still-
      // clamped `window.scrollY` — otherwise the hold is sized for the clamp and the
      // watch's follow-up restore to `intended` sits above the held max. With no
      // spike pending, hold the reader's current offset as before.
      releaseBodyHeight(sawSpike && intended != null ? intended : undefined);
      if (anchorLockedRef.current) {
        el.style.overflowAnchor = '';
        anchorLockedRef.current = false;
      }
      heightLockedRef.current = false;
      // Opportunistic restore the instant the freeze lifts — covers the case
      // where the spike is still live (or just reverted) at release time.
      watch();
    };
    // The clamp fires-and-reverts on the browser's own clock: on a real device
    // the spike's scroll/resize events routinely BEAT the passive-effect rAF
    // settle's first frame, and the revert can lag the 4-frame release by
    // 50–100 ms — so the rAF frames alone miss it. Listen to the real
    // scroll/resize events for the whole restore window; that is what actually
    // catches the clamp and its revert in real time. Bounded by a timer so a
    // deliberate later scroll/resize is never mistaken for a clamp.
    const onViewportEvent = () => watch();
    let restoreTimer: number | null = null;
    const teardown = () => {
      window.removeEventListener('scroll', onViewportEvent);
      window.removeEventListener('resize', onViewportEvent);
      if (restoreTimer != null && typeof clearTimeout === 'function') {
        clearTimeout(restoreTimer);
      }
      restoreTimer = null;
      // Hand the offset back to the always-on tracker at where the reader really
      // ended up, so the next dismiss starts fresh (and a genuine scroll during
      // the window, which the tracker deferred to us, is picked up) — but only
      // when the viewport is honest, so a teardown that fires mid-spike doesn't
      // bake in a clamped offset.
      if (typeof window !== 'undefined' && viewportIsHonest()) {
        readerScrollYRef.current = Math.round(window.scrollY);
      }
      if (dismissRestoreCleanupRef.current === teardown) {
        dismissRestoreCleanupRef.current = null;
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', onViewportEvent, { passive: true });
      window.addEventListener('resize', onViewportEvent);
      if (typeof setTimeout === 'function') {
        restoreTimer = setTimeout(teardown, VIEWPORT_CLAMP_RESTORE_MS) as unknown as number;
      }
      dismissRestoreCleanupRef.current = teardown;
    }
    if (typeof requestAnimationFrame !== 'function') {
      // No rAF (SSR / older jsdom): release synchronously. The scroll/resize
      // watch above still stands until its timer (or the next dismiss) tears down.
      runRelease();
      return cancelDismissRelease;
    }
    let frames = DISMISS_SETTLE_FRAMES;
    // Extra frames the release will wait through while the viewport is still
    // spiking, past the normal settle frames. The freeze is sized so a peak spike
    // can't clamp the reader (see lockBodyHeight) — but only while it's held, so we
    // must not RELEASE it mid-spike or the ceiling drops and the clamp fires after
    // all. Hold until the viewport is honest again, bounded to the restore window
    // so a spike that never reverts can't spin forever (past the bound `watch`'s
    // reactive restore still covers a live clamp). ~1 frame per 16 ms.
    let spikeHold = Math.ceil(VIEWPORT_CLAMP_RESTORE_MS / 16);
    const step = () => {
      // A background refresh grabbing the lock, or the body unmounting, aborts —
      // the refresh's own layout effect (or the next mount) then owns the release.
      if (isRefreshing || !heightLockedRef.current || !bodyRef.current) {
        dismissReleaseRafRef.current = null;
        return;
      }
      watch();
      if (frames > 0 || (!viewportIsHonest() && spikeHold > 0)) {
        if (frames > 0) frames -= 1;
        else spikeHold -= 1;
        dismissReleaseRafRef.current = requestAnimationFrame(step);
        return;
      }
      dismissReleaseRafRef.current = null;
      runRelease();
    };
    // Check once synchronously too — the clamp is often already in force by the
    // time this effect runs (a beat after the flip), so catch it before frame 1.
    watch();
    dismissReleaseRafRef.current = requestAnimationFrame(step);
    return cancelDismissRelease;
  }, [isRefreshing, visibleItems.length, releaseBodyHeight, cancelDismissRelease]);

  // Drop the sweep's scroll-anchoring opt-out one frame after the swept rows
  // leave the DOM — a passive (post-paint) effect, so the browser has already
  // laid out the row-removal with anchoring suppressed (no rewind/top-snap)
  // before we re-enable it. Decoupled from the min-height lock on purpose: the
  // height freeze must persist for the whole post-sweep refetch, but anchoring
  // only needs to be off for that one collapsing layout. Holding it longer would
  // strip anchoring from any auto-hide-on-scroll removal the reader triggers by
  // scrolling during the refetch (those drop rows ABOVE the viewport and need
  // anchoring to keep the first still-visible row fixed). `visibleItems.length`
  // drops on the sweep's removal, so this runs on exactly that commit; the ref
  // guard makes every other run a no-op.
  useEffect(() => {
    if (!anchorLockedRef.current) return;
    anchorLockedRef.current = false;
    if (bodyRef.current) bodyRef.current.style.overflowAnchor = '';
  }, [visibleItems.length]);

  // Cover the on-screen list with a "Refreshing" state while a fresh-list fetch
  // is in flight, so the reader can't tap a row that's about to re-materialize
  // (SPEC.md *Feed views → Refreshing*). `isRefreshing` is a whole-list refetch
  // with rows already present (PTR, or a stale mount/focus past the 6h TTL) — but
  // NOT a "More" next-page append (that's predictable, at the bottom) and NOT an
  // Undo reconcile (excluded via undoRefetchDepth — Undo restores instantly and
  // must stay silent). The empty-cache first load has no rows to cover, so
  // ItemRows renders the same state inline (its `isLoading` path, relabeled
  // "Refreshing") instead.
  const showRefreshing =
    isRefreshing && undoRefetchDepth.current === 0 && items.length > 0;

  // Auto-hide-on-scroll marks a row Done once it scrolls off the TOP — but the
  // last screenful of RENDERED rows can never do that (nothing below them to
  // scroll into), so they stay unmarkable-by-scroll and need a Sweep. Append a
  // blank scroll-space below the foot, tall enough to push the final rows up
  // past the top chrome, so the pure-scroll flow reaches the very last visible
  // article. Present whenever the feature is on and rows are showing —
  // independent of `hasMore`: auto-hide only ever marks rendered rows, and rows
  // still behind "More" aren't in the DOM (so they can't be scrolled past
  // anyway), yet the last LOADED row is stranded just the same whether or not
  // another page could be fetched. Gating on the true end would force the reader
  // to page in more unread content just to mark the tail they can already see.
  // See ItemList.css.
  const showScrollSpace =
    hideOnScroll && !showMissState && visibleItems.length > 0;

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
        onUndo={handleUndoScroll}
      />

      <PullToRefresh
        onRefresh={async () => {
          // The server-side re-poll is best-effort freshness: if it fails —
          // the refresh function's per-caller rate limit (429, easy to hit
          // when the reader pulls repeatedly), a timeout, offline — the pull
          // must still re-run the view's fetch. The refetch is what actually
          // repaints the list (the background poller keeps the DB fresh
          // anyway), and aborting here made a pull a complete visual no-op
          // with no error surfaced: the refresh-failure strip keys off the
          // QUERY's error, and the query never ran.
          // Run the server re-poll and (when linked) the reverse newshacker pull
          // together — both are best-effort freshness that feed the refetch
          // below. The pull brings the linked account's Done/Pinned lists back so
          // triage done on newshacker reflects here; PTR is the deliberate
          // refresh gesture where that reconciliation belongs (a Done drops via
          // the store overlay, an out-of-window pin surfaces in the fresh page).
          // allSettled, NOT all: `ds.refresh()` rejects on a rate-limit/offline,
          // and `Promise.all` would abort before the still-running pull applied +
          // hydrated — so the refetch would miss the reverse-sync results (e.g.
          // out-of-window pins). allSettled waits for the pull to finish first.
          {
            const [refreshResult] = await Promise.allSettled([
              ds.refresh(),
              newshackerLinked && ds.pullNewshackerState
                ? ds.pullNewshackerState()
                : Promise.resolve(),
            ]);
            if (refreshResult.status === 'rejected') {
              console.warn(
                '[readmo] pull-to-refresh server poll failed; refetching anyway:',
                refreshResult.reason,
              );
            }
          }
          // The pull (success or fail) resolves any open-on-newshacker "syncing"
          // spinners — a completed reverse pull reconciles the full newshacker
          // state, so each pending card's outcome is now known.
          clearAllReverseSyncPending();
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
          setDisplayedByFeed(new Map());
          // A pull-to-refresh consolidates: in-session pins re-group at the top.
          setStayInBodyIds(new Set());
          // Re-baseline the load-time pin capture on this same consolidation.
          // Clearing stayInBodyIds alone re-groups rows that were pinned AT LOAD
          // (already in basePinnedRef), but a row pinned THIS SESSION entered
          // unpinned, so it was never baselined — the promotion gate would still
          // reject it, leaving it in body and, if the fresh window doesn't cover
          // it (the server hasn't reordered it pinned-first yet), hidden behind a
          // phantom "More" (Codex P2 on #418). Resetting these refs lets the
          // inline baseline capture re-run against the fresh page, treating every
          // currently-pinned row as a load-time pin so it consolidates to — and
          // stays at — its section top. Mirrors the view-change reset.
          seenForBaseRef.current = new Set();
          basePinnedRef.current = new Set();
          // …and compacts grayed cross-device dismisses (the refetch also drops
          // them server-side, so this just clears the in-session bookkeeping;
          // `onScreenIdsRef` is re-derived by the observer as the fresh rows
          // mount).
          grayedIdsRef.current = new Set();
          await checkForServiceWorkerUpdate();
        }}
      >
        {showMissState ? (
          // Copy is a function of BOTH the connectivity status and the actual
          // read error — not status alone. A reachable read that errored is a
          // server problem to name (with a curated detail), not the connection
          // to blame; only a truly unreachable backend gets "isn't responding".
          (() => {
            const { headline, detail, offlineLink } = loadFailureCopy(status, error, {
              action: 'fetching the feed list',
              noun: 'items',
            });
            return (
              <LoadError
                headline={headline}
                detail={detail}
                offlineLink={offlineLink}
                onRetry={() => refetch()}
              />
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
              // Loading indicator (not the caught-up label) whenever a fetch is
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
              onOpenReader={handleOpenReader}
              grayedIds={grayedIds}
              onUndoDismiss={handleUndoDismiss}
              emptyLabel={emptyLabel ?? 'Nothing here yet.'}
              loadingLabel="Refreshing"
            />
          </div>
        )}
      </PullToRefresh>

      {/* Refreshing state — covers the on-screen list and blocks taps while a
          fresh-list fetch could reorder it (SPEC.md *Feed views → Refreshing*).
          Anchored below the top chrome so the header/toolbar stay usable. */}
      {showRefreshing ? (
        <div
          className="item-list__refreshing"
          role="status"
          aria-live="polite"
          data-testid="refreshing-overlay"
          style={
            topChromeHeight > 0 ? { top: `${topChromeHeight}px` } : undefined
          }
        >
          <span className="state__spinner" aria-hidden="true" />
          <span className="state__loading-label">Refreshing</span>
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

      {/* Pinned bar: the scroll-space goes ABOVE the sticky bar so the bar stays
          the last flow element and never un-sticks from the viewport foot; the
          blank tail still gives the last rows room to scroll off the top under
          the pinned bar. */}
      {showScrollSpace && pinnedBar ? (
        <div
          className="item-list__scroll-space"
          data-testid="scroll-space"
          aria-hidden="true"
          ref={scrollSpaceRef}
        />
      ) : null}

      <ListToolbar
        placement="bottom"
        onUndo={handleUndoScroll}
        // Only offer More once the feed is populated. Until the first page
        // lands (the loading indicator, error/retry, or an empty result) hasMore
        // is false, so an unconditional More would flash a disabled "No more
        // items" under the loading or retry UI even though the feed isn't
        // actually exhausted. Matches newshacker, whose footer renders only on a
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

      {/* Relative bar: the scroll-space sits BELOW the in-flow bottom toolbar,
          so the reader scrolls past the last row → toolbar → blank tail, and the
          final rows clear the top chrome to auto-hide. */}
      {showScrollSpace && !pinnedBar ? (
        <div
          className="item-list__scroll-space"
          data-testid="scroll-space"
          aria-hidden="true"
          ref={scrollSpaceRef}
        />
      ) : null}
    </div>
  );
}
