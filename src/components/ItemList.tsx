import { useEffect, useMemo } from 'react';
import { useDataSource } from '../lib/data/context';
import { useFeedItems, type FetchPage } from '../hooks/useFeedItems';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import { ItemRows } from './ItemRows';
import { ListToolbar } from './ListToolbar';
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

  // Sweepable rows = currently-loaded, unpinned rows (Done/Hidden are already
  // filtered out by the DataSource). Sweep hides them as one undoable batch.
  const sweepIds = useMemo(
    () =>
      items
        .filter((fi) => !ds.stateStore.get(fi.item.id).pinned)
        .map((fi) => fi.item.id),
    [items, ds],
  );

  useEffect(() => {
    registerSweep(() => ds.stateStore.hideMany(sweepIds), sweepIds.length);
    return () => registerSweep(null, 0);
  }, [registerSweep, ds, sweepIds]);

  return (
    <div className="item-list">
      <ListToolbar />

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
          emptyLabel={emptyLabel ?? 'Nothing here yet.'}
        />
      )}

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
        </div>
      ) : null}

      {hasMore ? (
        <div className="item-list__more">
          <button
            type="button"
            data-testid="more-btn"
            onClick={() => fetchMore()}
            disabled={isFetchingMore}
          >
            {isFetchingMore ? 'Loading…' : 'More'}
          </button>
        </div>
      ) : null}

      <ListToolbar placement="bottom" />
    </div>
  );
}
