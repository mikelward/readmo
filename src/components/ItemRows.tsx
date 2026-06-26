import { Fragment, type AnimationEventHandler, type Ref } from 'react';
import type { FeedId, FeedItem, ItemId } from '../lib/types';
import { useShareItem } from '../hooks/useShareItem';
import { ItemRow, type RightAction } from './ItemRow';
import { ChevronRight, Sweep, Undo } from './icons';
import { TooltipButton } from './TooltipButton';
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
  /** Per-feed unread/to-do count for the group-header badge (keyed by feed id).
   * A feed at 0 (or absent) renders no badge. Only meaningful alongside
   * `groupHeaders`. */
  groupCounts?: Record<FeedId, number>;
  /** Feeds whose section is collapsed: their header still renders, but its rows
   * are hidden. Only meaningful alongside `groupHeaders`. */
  collapsedFeeds?: Set<FeedId>;
  /** Toggle a feed's collapsed state (tapping its header). When provided the
   * header renders as a button; otherwise it's a static label. */
  onToggleCollapse?: (feedId: FeedId) => void;
  /** Sweep (mark done) a feed's fully-visible unpinned rows. When provided,
   * each header renders a Sweep button on its right. */
  onSweepFeed?: (feedId: FeedId) => void;
  /** Feeds with at least one sweepable visible row right now → that feed's
   * header Sweep button is enabled. */
  sweepableFeeds?: Set<FeedId>;
  /** Restore the last hide/sweep batch — the single-level global undo. When
   * provided, each header renders an Undo button next to Sweep. */
  onUndo?: () => void;
  /** Whether there's anything to undo → enables the header Undo buttons. */
  canUndo?: boolean;
  /** Group-by-feed per-section "More": feeds that have more rows to reveal past
   * their opening window → a "More" button renders at the foot of that section
   * (after its last visible row). Only meaningful alongside `onFeedMore`. */
  feedsWithMore?: Set<FeedId>;
  /** Feeds whose per-section "More" is mid-fetch → its button shows a loading
   * state and is disabled. */
  loadingFeeds?: Set<FeedId>;
  /** Append that feed's next page inline (tapping a section's foot "More"). When
   * provided, sections in `feedsWithMore` render the button. */
  onFeedMore?: (feedId: FeedId) => void;
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
  groupCounts,
  collapsedFeeds,
  onToggleCollapse,
  onSweepFeed,
  sweepableFeeds,
  onUndo,
  canUndo = false,
  feedsWithMore,
  loadingFeeds,
  onFeedMore,
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
      {items.map((fi, idx) => {
        const header = groupHeaders?.get(fi.item.id);
        const collapsed = collapsedFeeds?.has(fi.item.feedId) ?? false;
        // Last (visible) row of a feed section: the next row is a different feed
        // or the list ends. The per-section "More" sits here, after the section's
        // rows but before the next header — and never under a collapsed section.
        const lastOfFeed =
          idx === items.length - 1 ||
          items[idx + 1].item.feedId !== fi.item.feedId;
        const showFeedMore =
          !!onFeedMore &&
          !collapsed &&
          lastOfFeed &&
          (feedsWithMore?.has(fi.item.feedId) ?? false);
        const feedMoreLoading = loadingFeeds?.has(fi.item.feedId) ?? false;
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
                    aria-label={`${header.title}${
                      groupCounts && (groupCounts[header.feedId] ?? 0) > 0
                        ? `, ${groupCounts[header.feedId]} unread`
                        : ''
                    }: ${collapsed ? 'expand' : 'collapse'} feed`}
                    onClick={() => onToggleCollapse(header.feedId)}
                  >
                    <ChevronRight
                      className="item-list__group-chevron"
                      width={18}
                      height={18}
                    />
                    <span className="item-list__group-label">
                      <span className="item-list__group-title">{header.title}</span>
                      {groupCounts && (groupCounts[header.feedId] ?? 0) > 0 ? (
                        // Decorative: the count is announced via the button's
                        // aria-label above (its own aria-label here would be
                        // ignored, since the button label is the accessible name).
                        <span className="item-list__group-count" aria-hidden="true">
                          {groupCounts[header.feedId] > 99
                            ? '99+'
                            : groupCounts[header.feedId]}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ) : (
                  <span className="item-list__group-title" aria-hidden="true">
                    {header.title}
                  </span>
                )}
                {onSweepFeed || onUndo ? (
                  <div className="item-list__group-actions">
                    {onUndo ? (
                      <TooltipButton
                        type="button"
                        className="item-list__group-action"
                        data-testid="group-undo"
                        onClick={canUndo ? onUndo : undefined}
                        disabled={!canUndo}
                        tooltip={canUndo ? 'Undo' : 'Nothing to undo'}
                        aria-label={canUndo ? 'Undo' : 'Nothing to undo'}
                      >
                        <Undo width={20} height={20} />
                      </TooltipButton>
                    ) : null}
                    {onSweepFeed ? (
                      (() => {
                        const canSweep = sweepableFeeds?.has(header.feedId) ?? false;
                        return (
                          <TooltipButton
                            type="button"
                            className="item-list__group-action"
                            data-testid="group-sweep"
                            onClick={canSweep ? () => onSweepFeed(header.feedId) : undefined}
                            disabled={!canSweep}
                            tooltip={canSweep ? 'Mark visible done' : 'Nothing to dismiss'}
                            aria-label={
                              canSweep
                                ? `Mark visible ${header.title} items done`
                                : `Nothing to dismiss in ${header.title}`
                            }
                          >
                            <Sweep width={20} height={20} />
                          </TooltipButton>
                        );
                      })()
                    ) : null}
                  </div>
                ) : null}
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
            {showFeedMore ? (
              <li className="item-list__group-more">
                <button
                  type="button"
                  className="item-list__group-more-btn"
                  data-testid="group-more"
                  data-feed-more={fi.item.feedId}
                  onClick={() => onFeedMore?.(fi.item.feedId)}
                  disabled={feedMoreLoading}
                  aria-label={
                    feedMoreLoading
                      ? `Loading more ${fi.feed.title} items`
                      : `More from ${fi.feed.title}`
                  }
                >
                  {feedMoreLoading ? 'Loading…' : 'More'}
                </button>
              </li>
            ) : null}
          </Fragment>
        );
      })}
    </ul>
  );
}
