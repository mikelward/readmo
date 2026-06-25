import { Fragment, type AnimationEventHandler, type Ref } from 'react';
import type { FeedId, FeedItem, ItemId } from '../lib/types';
import { useShareItem } from '../hooks/useShareItem';
import { ItemRow, type RightAction } from './ItemRow';
import { ChevronRight } from './icons';
import './ItemList.css';

/** What to render as a feed-section header before a given row. */
export interface GroupHeader {
  feedId: FeedId;
  title: string;
}

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
  /** Feed views pass a per-id callback ref (from {@link useInViewIds}) so the
   * row's `<li>` is observed for viewport visibility — Sweep hides only the
   * rows fully in view. Omitted by library/search/offline, which don't sweep. */
  getRowRef?: (id: FeedItem['item']['id']) => (el: HTMLElement | null) => void;
  /** When grouping by feed, maps an item id → the feed-section header to render
   * immediately before that row (the first row of each feed section). Computed
   * in {@link ItemList} so the header tracks the server-side feed sectioning
   * across pages. Header rows aren't navigable (keyboard nav targets
   * `.item-row__body`) and aren't swept. */
  groupHeaders?: Map<ItemId, GroupHeader>;
  /** Feeds whose section is collapsed: their header still renders, but its rows
   * are hidden. Only meaningful alongside `groupHeaders`. */
  collapsedFeeds?: Set<FeedId>;
  /** Toggle a feed's collapsed state (tapping its header). When provided the
   * header renders as a button; otherwise it's a static label. */
  onToggleCollapse?: (feedId: FeedId) => void;
  /** Ids currently playing the sweep-out animation — their `<li>` carries the
   * `--sweeping` modifier so it slides + fades together with its peers. The
   * parent commits the hide on the matching `animationend`. */
  sweepingIds?: ReadonlySet<ItemId>;
  /** Fired on the list `<ul>`; the parent watches for the
   * `item-list__sweep-out` keyframe name to commit the deferred Sweep. */
  onAnimationEnd?: AnimationEventHandler<HTMLUListElement>;
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
  getRowRef,
  groupHeaders,
  collapsedFeeds,
  onToggleCollapse,
  sweepingIds,
  onAnimationEnd,
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
    <ul className="item-list__rows" ref={listRef} onAnimationEnd={onAnimationEnd}>
      {items.map((fi) => {
        const header = groupHeaders?.get(fi.item.id);
        const collapsed = collapsedFeeds?.has(fi.item.feedId) ?? false;
        return (
          <Fragment key={fi.item.id}>
            {header !== undefined ? (
              <li
                className={
                  'item-list__group-header' +
                  (collapsed ? ' item-list__group-header--collapsed' : '')
                }
                // Tag with the row it precedes so the fetch-and-scroll anchor can
                // target a section header (a collapsed feed has no visible row).
                data-header-for={fi.item.id}
              >
                {onToggleCollapse ? (
                  <button
                    type="button"
                    className="item-list__group-toggle"
                    data-testid="group-toggle"
                    aria-expanded={!collapsed}
                    aria-label={`${header.title}: ${collapsed ? 'expand' : 'collapse'} feed`}
                    onClick={() => onToggleCollapse(header.feedId)}
                  >
                    <ChevronRight
                      className="item-list__group-chevron"
                      width={18}
                      height={18}
                    />
                    <span className="item-list__group-title">{header.title}</span>
                  </button>
                ) : (
                  <span className="item-list__group-title" aria-hidden="true">
                    {header.title}
                  </span>
                )}
              </li>
            ) : null}
            {collapsed ? null : (
              <li
                className={
                  'item-list__row' +
                  (sweepingIds?.has(fi.item.id) ? ' item-list__row--sweeping' : '')
                }
                data-item-id={fi.item.id}
                ref={getRowRef?.(fi.item.id)}
              >
                <ItemRow
                  feedItem={fi}
                  enableSwipe={enableSwipe}
                  onShare={() => share({ title: fi.item.title, url: fi.item.url })}
                  rightAction={rightAction?.(fi)}
                />
              </li>
            )}
          </Fragment>
        );
      })}
    </ul>
  );
}
