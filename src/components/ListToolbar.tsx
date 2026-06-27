import { useSyncExternalStore } from 'react';
import { useDataSource } from '../lib/data/context';
import { useBottomBarPosition } from '../hooks/useReadingPrefs';
import { useFeedBar } from './FeedBarContext';
import { TooltipButton } from './TooltipButton';
import {
  SortNewestFirst,
  SortOldestFirst,
  ListFlat,
  ListTree,
  Sweep,
  Undo,
  UnfoldLess,
  UnfoldMore,
  VerticalAlignTop,
} from './icons';
import type { ItemSort } from '../lib/data/DataSource';
import './ListToolbar.css';

function scrollToTop() {
  // Browsers that honor prefers-reduced-motion fall back to an instant scroll.
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Drives the bottom bar's "More" button. Feed views pass this so paging lives
 * in the toolbar next to Back to top / Undo / Sweep instead of a separate
 * control (SPEC.md *Bottom action bar*). Because the bottom bar is pinned to
 * the viewport foot, "More" is a pager: tapping it scrolls the next chunk of
 * loaded rows into view, or fetches the next page once the end is in view — see
 * {@link ItemList}. It's enabled (`canAdvance`) while anything is left to reveal
 * or fetch, then a disabled "No more items" once the feed end is reached, so
 * exhaustion is explicit feedback rather than a vanished control. Library views
 * omit it. */
export interface MoreAction {
  /** Whether tapping does anything — unseen rows below the fold or a fetchable
   * page. False only at the true end of the feed. */
  canAdvance: boolean;
  isFetching: boolean;
  onMore: () => void;
}

/** Collapse-all / Expand-all controls for the group-by-feed view. Passed to the
 * top bar only (and only when grouping is on with feeds in view). */
export interface CollapseAction {
  onCollapseAll: () => void;
  onExpandAll: () => void;
  /** Every feed in view is already collapsed → disable Collapse all. */
  allCollapsed: boolean;
  /** At least one feed is collapsed → enable Expand all. */
  anyCollapsed: boolean;
}

/** Top-bar toggle for the group-by-feed reading preference. Passed only to the
 * top bar on multi-feed views (Home, folders) where grouping changes the layout;
 * single-feed views omit it since grouping is a no-op there. */
export interface GroupAction {
  /** Current state of the `readmo:group-by-feed` preference. */
  groupByFeed: boolean;
  /** Flip the preference (which re-keys the list view and refetches). */
  onToggle: () => void;
}

/** Top-bar toggle for the chronological sort preference. Passed to the top bar
 * on every feed view (Home, folders, and single feeds — sort applies to all,
 * unlike grouping). Flips between newest- and oldest-first. */
export interface SortAction {
  /** Current state of the `readmo:item-sort` preference. */
  itemSort: ItemSort;
  /** Flip the order (which re-keys the list view and refetches). */
  onToggle: () => void;
}

interface Props {
  /** Where the bar sits. The bottom copy mirrors the top bar but leads with a
   * Back to top button in the left slot, matching the reader's two bars
   * (SPEC.md *List toolbar*). Defaults to the top. */
  placement?: 'top' | 'bottom';
  /** Whether to render the Undo + Sweep actions. List views with no sweepable
   * selection (library, search) pass false so their bottom bar is Back to top
   * only. */
  actions?: boolean;
  /** Feed bottom bars pass this to render the "More" (load next page) button
   * between Back to top and the Undo/Sweep group. Omit on the top bar and on
   * library footers. */
  more?: MoreAction;
  /** Group-by-feed views pass this to the top bar to render Collapse all /
   * Expand all. Omitted when not grouping or on the bottom bar. */
  collapse?: CollapseAction;
  /** Multi-feed views pass this to the top bar to render the group-by-feed
   * toggle. Omitted on single-feed views (no-op) and on the bottom bar. */
  group?: GroupAction;
  /** Feed views pass this to the top bar to render the sort-order toggle.
   * Omitted on the bottom bar. */
  sort?: SortAction;
}

/** Sticky list toolbar: Back to top (bottom bar only) on the left, then
 * right-aligned Undo + Sweep (Hide unpinned). The RSS analog of newshacker's
 * Undo + Sweep (SPEC.md *List toolbar*). Rendered at both the top and bottom of
 * a list so Back to top is always within reach without a separate button. */
export function ListToolbar({
  placement = 'top',
  actions = true,
  more,
  collapse,
  group,
  sort,
}: Props = {}) {
  const ds = useDataSource();
  const store = ds.stateStore;
  const { sweep, sweepCount } = useFeedBar();
  const { bottomBarPosition } = useBottomBarPosition();

  // The bottom bar defaults to a relative footer at the end of the list
  // (newshacker's model); 'screen' pins it to the viewport foot. Only the
  // bottom bar is positioned this way; the top bar always sticks below the
  // header.
  const relative = placement === 'bottom' && bottomBarPosition === 'list';

  const canUndo = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.canUndo(),
    () => store.canUndo(),
  );

  const canSweep = !!sweep && sweepCount > 0;

  return (
    <section
      className={
        `list-toolbar list-toolbar--${placement}` +
        (relative ? ' list-toolbar--relative' : '')
      }
      aria-label="List actions"
    >
      <div className="list-toolbar__row" role="toolbar">
        {placement === 'bottom' ? (
          <TooltipButton
            type="button"
            className="list-toolbar__button"
            data-testid="back-to-top"
            onClick={scrollToTop}
            tooltip="Back to top"
            aria-label="Back to top"
          >
            <VerticalAlignTop />
          </TooltipButton>
        ) : null}
        {group ? (
          <TooltipButton
            type="button"
            className={
              'list-toolbar__button' +
              (group.groupByFeed ? ' list-toolbar__button--active' : '')
            }
            data-testid="group-by-feed-btn"
            aria-pressed={group.groupByFeed}
            onClick={group.onToggle}
            tooltip="Group by feed"
            aria-label="Group by feed"
          >
            {/* The glyph mirrors the current layout: a tree when grouped, a
                flat list when not — reinforcing the aria-pressed state. */}
            {group.groupByFeed ? <ListTree /> : <ListFlat />}
          </TooltipButton>
        ) : null}
        {collapse ? (
          <div className="list-toolbar__collapse">
            <TooltipButton
              type="button"
              className="list-toolbar__button"
              data-testid="collapse-all-btn"
              onClick={collapse.onCollapseAll}
              disabled={collapse.allCollapsed}
              tooltip="Collapse all"
              aria-label="Collapse all"
            >
              <UnfoldLess />
            </TooltipButton>
            <TooltipButton
              type="button"
              className="list-toolbar__button"
              data-testid="expand-all-btn"
              onClick={collapse.onExpandAll}
              disabled={!collapse.anyCollapsed}
              tooltip="Expand all"
              aria-label="Expand all"
            >
              <UnfoldMore />
            </TooltipButton>
          </div>
        ) : null}
        {sort ? (
          <TooltipButton
            type="button"
            className="list-toolbar__button"
            data-testid="sort-order-btn"
            onClick={sort.onToggle}
            tooltip={sort.itemSort === 'newest' ? 'Newest first' : 'Oldest first'}
            aria-label={
              sort.itemSort === 'newest' ? 'Newest first' : 'Oldest first'
            }
          >
            {/* Stacked digits + arrow show the current order: 9→0 + down =
                newest-first (descending), 0→9 + up = oldest-first (ascending). */}
            {sort.itemSort === 'newest' ? (
              <SortNewestFirst />
            ) : (
              <SortOldestFirst />
            )}
          </TooltipButton>
        ) : null}
        {more ? (
          <button
            type="button"
            className="list-toolbar__more"
            data-testid="more-btn"
            onClick={more.canAdvance ? more.onMore : undefined}
            disabled={!more.canAdvance || more.isFetching}
            aria-disabled={!more.canAdvance || undefined}
          >
            {more.isFetching
              ? 'Loading…'
              : more.canAdvance
                ? 'More'
                : 'No more items'}
          </button>
        ) : null}
        {actions ? (
          <div className="list-toolbar__right">
            <TooltipButton
              type="button"
              className="list-toolbar__button"
              data-testid={`undo-btn${placement === 'bottom' ? '-bottom' : ''}`}
              onClick={canUndo ? () => store.undoLast() : undefined}
              disabled={!canUndo}
              tooltip={canUndo ? 'Undo' : 'Nothing to undo'}
              aria-label={canUndo ? 'Undo' : 'Nothing to undo'}
            >
              <Undo />
            </TooltipButton>
            <TooltipButton
              type="button"
              className="list-toolbar__button"
              data-testid={`sweep-btn${placement === 'bottom' ? '-bottom' : ''}`}
              onClick={canSweep ? sweep : undefined}
              disabled={!canSweep}
              tooltip={canSweep ? 'Mark all done' : 'Nothing to dismiss'}
              aria-label={canSweep ? 'Mark all done' : 'Nothing to dismiss'}
            >
              <Sweep />
            </TooltipButton>
          </div>
        ) : null}
      </div>
    </section>
  );
}
