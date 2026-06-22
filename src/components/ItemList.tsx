import { useEffect, useMemo } from 'react';
import { useDataSource } from '../lib/data/context';
import { useFeedItems, type FetchPage } from '../hooks/useFeedItems';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import { useShareItem } from '../hooks/useShareItem';
import { ItemRow } from './ItemRow';
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
  const share = useShareItem();
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

      {isLoading ? (
        <ul className="item-list__skeletons" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="item-list__skeleton" />
          ))}
        </ul>
      ) : isError ? (
        <div className="item-list__state" role="alert">
          <p>Couldn’t load items.</p>
          <button type="button" onClick={() => refetch()}>
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="item-list__state">
          <p>{emptyLabel ?? 'Nothing here yet.'}</p>
        </div>
      ) : (
        <ul className="item-list__rows" ref={listRef}>
          {items.map((fi) => (
            <li key={fi.item.id} className="item-list__row">
              <ItemRow
                feedItem={fi}
                onShare={() =>
                  share({ title: fi.item.title, url: fi.item.url })
                }
              />
            </li>
          ))}
        </ul>
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
