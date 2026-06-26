import { useSyncExternalStore } from 'react';
import { useDataSource } from '../lib/data/context';
import { useBottomBarPosition } from '../hooks/useReadingPrefs';
import { useFeedBar } from './FeedBarContext';
import { TooltipButton } from './TooltipButton';
import { Sweep, Undo, UnfoldLess, UnfoldMore, VerticalAlignTop } from './icons';
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
