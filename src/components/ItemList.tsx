import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataSource } from '../lib/data/context';
import { useFeedItems, type FetchPage } from '../hooks/useFeedItems';
import { useInViewIds } from '../hooks/useInViewIds';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import { measureStickyBottomInset, measureTopChromeHeight } from '../lib/stickyInset';
import { checkForServiceWorkerUpdate } from '../lib/swUpdate';
import { ItemRows } from './ItemRows';
import { ListToolbar } from './ListToolbar';
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
  const {
    items,
    isLoading,
    isError,
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

  return (
    <div className="item-list">
      <ListToolbar />

      <PullToRefresh onRefresh={async () => { await ds.refresh(); await refetch(); await checkForServiceWorkerUpdate(); }}>
        {isError ? (
          <div className="item-list__state" role="alert">
            <p>Couldn’t load items.</p>
            <button type="button" onClick={() => refetch()}>
              Retry
            </button>
          </div>
        ) : (
          <ItemRows
            items={items}
            isLoading={isLoading}
            skeletonCount={6}
            enableSwipe
            listRef={listRef}
            getRowRef={getRowRef}
            emptyLabel={emptyLabel ?? 'Nothing here yet.'}
          />
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
