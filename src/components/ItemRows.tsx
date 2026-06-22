import type { Ref } from 'react';
import type { FeedItem } from '../lib/types';
import { useShareItem } from '../hooks/useShareItem';
import { ItemRow, type RightAction } from './ItemRow';
import './ItemList.css';

interface Props {
  items: FeedItem[];
  /** Shown when there are no items and not loading. */
  emptyLabel: string;
  /** Render skeleton placeholders instead of rows or the empty state. */
  isLoading?: boolean;
  /** How many skeletons to show while loading (feed views use 6). */
  skeletonCount?: number;
  /** Feed views enable swipe (right=Hide, left=Pin); library/search/offline
   * disable it — every row there already holds the state the view represents. */
  enableSwipe?: boolean;
  /** Forwarded to the rows <ul> so feed views can wire up keyboard navigation. */
  listRef?: Ref<HTMLUListElement>;
  /** Per-item inverse action that replaces the default Pin button (library
   * views: Unpin / Unfavorite / …). */
  rightAction?: (feedItem: FeedItem) => RightAction;
}

/** The shared body of a list view: loading skeletons, the empty state, or the
 * item rows. The surrounding shell (page header, toolbars, feed-only refresh
 * strip and More button) lives in {@link ListPage} or {@link ItemList}. */
export function ItemRows({
  items,
  emptyLabel,
  isLoading = false,
  skeletonCount = 4,
  enableSwipe = false,
  listRef,
  rightAction,
}: Props) {
  const share = useShareItem();

  if (isLoading) {
    return (
      <ul className="item-list__skeletons" aria-hidden="true">
        {Array.from({ length: skeletonCount }).map((_, i) => (
          <li key={i} className="item-list__skeleton" />
        ))}
      </ul>
    );
  }

  if (items.length === 0) {
    return (
      <div className="item-list__state">
        <p>{emptyLabel}</p>
      </div>
    );
  }

  return (
    <ul className="item-list__rows" ref={listRef}>
      {items.map((fi) => (
        <li key={fi.item.id} className="item-list__row">
          <ItemRow
            feedItem={fi}
            enableSwipe={enableSwipe}
            onShare={() => share({ title: fi.item.title, url: fi.item.url })}
            rightAction={rightAction?.(fi)}
          />
        </li>
      ))}
    </ul>
  );
}
