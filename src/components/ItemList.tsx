import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataSource } from '../lib/data/context';
import { useConnectivityStatus } from '../hooks/useOnlineStatus';
import { useFeedItems, type FetchPage } from '../hooks/useFeedItems';
import { useInViewIds } from '../hooks/useInViewIds';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import { measureStickyBottomInset, measureTopChromeHeight } from '../lib/stickyInset';
import { checkForServiceWorkerUpdate } from '../lib/swUpdate';
import { ItemRows } from './ItemRows';
import { ListToolbar } from './ListToolbar';
import { PromoBar } from './PromoBar';
import { PullToRefresh } from './PullToRefresh';
import { useFeedBar } from './FeedBarContext';
import './ItemList.css';

interface Props {
  viewKey: string;
  fetchPage: FetchPage;
  /** Shown in the empty state, e.g. "No unread items". */
  emptyLabel?: string;
}

/** A feed view (home / folder / single feed): sticky toolbar, item rows with
 * swipe, an explicit "More" button, and the background-refresh status strip. */
export function ItemList({ viewKey, fetchPage, emptyLabel }: Props) {
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
  } = useFeedItems(viewKey, fetchPage);
  const listRef = useListKeyboardNav();
  const { registerSweep } = useFeedBar();
  const { inViewIds, getRowRef } = useInViewIds();

  // The bottom toolbar (with "More") is pinned to the viewport foot, so it's
  // always on screen — `hasMore` alone (another *page* is fetchable) can't drive
  // it, or it flashes "No more items" while loaded rows still sit below the fold
  // (the reader isn't at the end, they just haven't scrolled there). So "More"
  // is a pager: while the bottom of the loaded list is off-screen it scrolls a
  // page down to reveal more rows; once the list end is in view and another page
  // exists it fetches that page (and the effect below scrolls its first row up);
  // only when the end is reached *and* nothing more can be fetched does it
  // settle into a disabled "No more items".
  const [atListEnd, setAtListEnd] = useState(false);

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
    // Re-measure when the row count changes — a new page grows the document.
  }, [items.length]);

  // Anchors the fetch-and-scroll path: the id of the last row before a tap that
  // triggers a fetch (ids are stable across a plain page fetch — no state change
  // reorders them), so the effect below can scroll the page's first row up once
  // it renders.
  const pendingAnchorId = useRef<string | null>(null);

  const handleMore = useCallback(() => {
    // Bottom of the loaded list still below the fold → page down to it.
    if (!atListEnd) {
      const page =
        window.innerHeight - measureTopChromeHeight() - measureStickyBottomInset();
      // Browsers honoring prefers-reduced-motion fall back to an instant scroll.
      window.scrollBy({ top: Math.max(page, 200), behavior: 'smooth' });
      return;
    }
    // At the end with another page available → fetch it; the effect scrolls its
    // first row just below the top chrome once it lands.
    pendingAnchorId.current = items[items.length - 1]?.item.id ?? null;
    fetchMore();
  }, [atListEnd, items, fetchMore]);

  useEffect(() => {
    const anchorId = pendingAnchorId.current;
    if (anchorId === null) return;
    const anchorIndex = items.findIndex((fi) => fi.item.id === anchorId);
    // Wait until the appended page has rendered (a row now follows the anchor).
    if (anchorIndex === -1 || anchorIndex >= items.length - 1) return;
    pendingAnchorId.current = null;
    const firstNewId = items[anchorIndex + 1].item.id;
    const row = document.querySelector(`[data-item-id="${firstNewId}"]`);
    if (!(row instanceof HTMLElement)) return;
    const top = row.getBoundingClientRect().top + window.scrollY - measureTopChromeHeight();
    // Browsers honoring prefers-reduced-motion fall back to an instant scroll.
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [items]);

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

  useEffect(() => {
    registerSweep(() => ds.stateStore.hideMany(sweepIds), sweepIds.length);
    return () => registerSweep(null, 0);
  }, [registerSweep, ds, sweepIds]);

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
  const showMissState =
    isError ||
    (refreshFailed && items.length === 0) ||
    (!isLoading && items.length === 0 && status !== 'online');

  return (
    <div className="item-list">
      <ListToolbar />

      <PullToRefresh onRefresh={async () => { await ds.refresh(); await refetch(); await checkForServiceWorkerUpdate(); }}>
        {showMissState ? (
          <div className="item-list__state" role="alert">
            {/* Say which failure it is so a server problem doesn't read as the
                user being offline. 'offline' = the device has no network;
                anything else (backend unreachable, or a 5xx that still
                reached us) is a server-side problem they can only wait out. */}
            <p>
              {status === 'offline'
                ? 'You’re offline. Reconnect to load items.'
                : 'Readmo’s server isn’t responding right now — it may be busy.'}
            </p>
            <button type="button" onClick={() => refetch()}>
              Retry
            </button>
          </div>
        ) : (
          <>
            {/* Onboarding hint sits above the rows, but only once items exist —
                there's nothing to pin under skeletons or an empty feed. */}
            {items.length > 0 ? (
              <PromoBar id="pin-to-download">
                Pin an article to download it
              </PromoBar>
            ) : null}
            <ItemRows
              items={items}
              // Skeletons (not the caught-up label) whenever a fetch is
              // validating an empty feed — the initial load, a reconnect
              // confirm, a boot-time cache-invalidation refetch over an empty
              // persisted page, or a focus/PTR refresh. An empty result isn't
              // trustworthy as "all caught up" until the in-flight read that
              // could populate it (or fail and surface the miss-state) settles.
              isLoading={isLoading || (isFetching && items.length === 0)}
              skeletonCount={6}
              enableSwipe
              listRef={listRef}
              getRowRef={getRowRef}
              emptyLabel={emptyLabel ?? 'Nothing here yet.'}
            />
          </>
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
          Couldn't refresh.{' '}
          <button type="button" onClick={() => refetch()}>
            Retry
          </button>
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
                // Enabled while there's anything left to reveal — unseen loaded
                // rows below the fold, or another fetchable page at the end.
                canAdvance: !atListEnd || hasMore,
                isFetching: isFetchingMore,
                onMore: handleMore,
              }
            : undefined
        }
      />
    </div>
  );
}
