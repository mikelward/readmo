import type { AnimationEventHandler, ReactNode, Ref } from 'react';
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
  /** Feeds in `feedsWithMore` that have *no* visible rows — typically the
   * section the reader just swept where nothing pinned remained. Each entry
   * here renders a phantom header + "More" so the reader can still pull the
   * next page (without it the swept section vanishes and More becomes
   * unreachable until pull-to-refresh). Each row carries the feed title at the
   * call site to avoid a separate feed-metadata lookup. Title-only headers
   * have no Sweep/Undo (no rows to act on). */
  emptyMoreSections?: Array<{ feedId: FeedId; title: string }>;
  /** Canonical feed order (from the full base read, not just visible items),
   * used to interleave phantom sections at the right ordinal position so a
   * swept middle feed's header doesn't shift to the end of the list. Lower
   * ranks render earlier. Only meaningful alongside `emptyMoreSections`. */
  feedRank?: Map<FeedId, number>;
  /** Ids currently playing the sweep-out animation — their `<li>` carries the
   * `--sweeping` modifier so it slides + fades together with its peers. The
   * parent commits the hide on the matching `animationend`. */
  sweepingIds?: ReadonlySet<ItemId>;
  /** Fired on the list `<ul>`; the parent watches for the
   * `item-list__sweep-out` keyframe name to commit the deferred Sweep. */
  onAnimationEnd?: AnimationEventHandler<HTMLUListElement>;
}

/** A run of contiguous rows under one section header: the (optional) header,
 * the id of the row it's anchored to (for the fetch-and-scroll target), and the
 * feed it belongs to. Built by walking `items` and starting a new section at
 * every `groupHeaders` boundary, so it matches the server-side feed sectioning
 * without assuming a header for the very first rows. */
interface Section {
  header?: GroupHeader;
  /** The row id the header is anchored to (`data-header-for`). */
  headerForId?: ItemId;
  feedId: FeedId;
  rows: FeedItem[];
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
  emptyMoreSections,
  feedRank,
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

  // Empty state only when there are *also* no phantom More-sections to show.
  // A grouped view that swept its only unpinned section still needs the
  // section header + More to stay reachable, even when visibleItems is empty.
  const phantoms = emptyMoreSections ?? [];
  if (items.length === 0 && phantoms.length === 0) {
    return (
      <div className="item-list__state">
        <p>{emptyLabel}</p>
      </div>
    );
  }

  const renderRow = (fi: FeedItem) => (
    <li
      key={fi.item.id}
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
  );

  // Non-grouped views (flat river, single feed, library/search/offline) have no
  // section headers, so they stay a plain flat list of rows — unchanged.
  if (!groupHeaders) {
    return (
      <ul className="item-list__rows" ref={listRef} onAnimationEnd={onAnimationEnd}>
        {items.map((fi) => renderRow(fi))}
      </ul>
    );
  }

  // Grouped view. Each section is its own container <li>, which is what bounds
  // the `position: sticky` header to its OWN feed run: only the current
  // section's header is ever pinned, and it's pushed back out by the section's
  // end as the next header arrives — earlier headers don't pile up stuck (and
  // keep stale, off-section controls in the tab order) behind the visible one.
  const renderHeader = (
    feedId: FeedId,
    title: string,
    headerForId: string,
    phantom: boolean,
  ): ReactNode => {
    const collapsed = collapsedFeeds?.has(feedId) ?? false;
    const count =
      !phantom && groupCounts ? (groupCounts[feedId] ?? 0) : 0;
    const showCount = count > 0;
    const ariaLabel = `${title}${showCount ? `, ${count} unread` : ''}: ${
      collapsed ? 'expand' : 'collapse'
    } feed`;
    return (
      <div
        className={
          'item-list__group-header' +
          (collapsed ? ' item-list__group-header--collapsed' : '')
        }
        // Tag with the row it precedes so the fetch-and-scroll anchor can target
        // a section header (a collapsed feed has no visible row).
        data-header-for={headerForId}
      >
        {onToggleCollapse ? (
          <button
            type="button"
            className="item-list__group-toggle"
            data-testid="group-toggle"
            aria-expanded={!collapsed}
            aria-label={ariaLabel}
            onClick={() => onToggleCollapse(feedId)}
          >
            <ChevronRight
              className="item-list__group-chevron"
              width={18}
              height={18}
            />
            <span className="item-list__group-label">
              <span className="item-list__group-title">{title}</span>
              {showCount ? (
                // Decorative: the count is announced via the button's aria-label
                // above (its own aria-label here would be ignored, since the
                // button label is the accessible name).
                <span className="item-list__group-count" aria-hidden="true">
                  {count > 99 ? '99+' : count}
                </span>
              ) : null}
            </span>
          </button>
        ) : (
          <span className="item-list__group-title" aria-hidden="true">
            {title}
          </span>
        )}
        {onUndo || (!phantom && onSweepFeed) ? (
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
            {!phantom && onSweepFeed
              ? (() => {
                  const canSweep = sweepableFeeds?.has(feedId) ?? false;
                  return (
                    <TooltipButton
                      type="button"
                      className="item-list__group-action"
                      data-testid="group-sweep"
                      onClick={canSweep ? () => onSweepFeed(feedId) : undefined}
                      disabled={!canSweep}
                      tooltip={canSweep ? 'Mark visible done' : 'Nothing to dismiss'}
                      aria-label={
                        canSweep
                          ? `Mark visible ${title} items done`
                          : `Nothing to dismiss in ${title}`
                      }
                    >
                      <Sweep width={20} height={20} />
                    </TooltipButton>
                  );
                })()
              : null}
          </div>
        ) : null}
      </div>
    );
  };

  const renderMore = (feedId: FeedId, title: string): ReactNode => {
    const loading = loadingFeeds?.has(feedId) ?? false;
    return (
      <div className="item-list__group-more">
        <button
          type="button"
          className="item-list__group-more-btn"
          data-testid="group-more"
          data-feed-more={feedId}
          onClick={() => onFeedMore?.(feedId)}
          disabled={loading}
          aria-label={loading ? `Loading more ${title} items` : `More from ${title}`}
        >
          {loading ? 'Loading…' : 'More'}
        </button>
      </div>
    );
  };

  // Split `items` into sections at every `groupHeaders` boundary (not raw feed
  // id), matching the previous flat layout: a header renders before any item
  // the data layer flagged, and the section runs until the next flagged item.
  // Items before the first header (only happens in non-canonical inputs) form a
  // leading headerless section.
  const sections: Section[] = [];
  for (const fi of items) {
    const header = groupHeaders.get(fi.item.id);
    if (header || sections.length === 0) {
      sections.push({
        header,
        headerForId: header ? fi.item.id : undefined,
        feedId: fi.item.feedId,
        rows: [fi],
      });
    } else {
      sections[sections.length - 1].rows.push(fi);
    }
  }

  const renderFeedSection = (section: Section): ReactNode => {
    const { feedId } = section;
    const collapsed = collapsedFeeds?.has(feedId) ?? false;
    const showFeedMore =
      !!onFeedMore && !collapsed && (feedsWithMore?.has(feedId) ?? false);
    return (
      <li className="item-list__section" key={`feed:${feedId}`}>
        {section.header
          ? renderHeader(feedId, section.header.title, section.headerForId!, false)
          : null}
        {collapsed ? null : (
          <ul className="item-list__section-rows">
            {section.rows.map((fi) => renderRow(fi))}
          </ul>
        )}
        {showFeedMore ? renderMore(feedId, section.rows[0].feed.title) : null}
      </li>
    );
  };

  const renderPhantomSection = (p: { feedId: FeedId; title: string }): ReactNode => {
    const collapsed = collapsedFeeds?.has(p.feedId) ?? false;
    return (
      <li className="item-list__section" key={`empty-more:${p.feedId}`}>
        {renderHeader(p.feedId, p.title, `empty-more:${p.feedId}`, true)}
        {collapsed || !onFeedMore ? null : renderMore(p.feedId, p.title)}
      </li>
    );
  };

  // Interleave phantom sections at their canonical ordinal position so a swept
  // middle feed's header stays put instead of shifting to the bottom of the
  // list (mirrors the previous `phantomsBeforeRank` interleave).
  const sortedPhantoms = phantoms
    .slice()
    .sort(
      (a, b) =>
        (feedRank?.get(a.feedId) ?? Number.POSITIVE_INFINITY) -
        (feedRank?.get(b.feedId) ?? Number.POSITIVE_INFINITY),
    );
  let phantomCursor = 0;
  const out: ReactNode[] = [];
  for (const section of sections) {
    const rank = feedRank?.get(section.feedId) ?? Number.POSITIVE_INFINITY;
    while (phantomCursor < sortedPhantoms.length) {
      const p = sortedPhantoms[phantomCursor];
      if ((feedRank?.get(p.feedId) ?? Number.POSITIVE_INFINITY) >= rank) break;
      out.push(renderPhantomSection(p));
      phantomCursor += 1;
    }
    out.push(renderFeedSection(section));
  }
  while (phantomCursor < sortedPhantoms.length) {
    out.push(renderPhantomSection(sortedPhantoms[phantomCursor]));
    phantomCursor += 1;
  }

  return (
    <ul className="item-list__rows" ref={listRef} onAnimationEnd={onAnimationEnd}>
      {out}
    </ul>
  );
}
