import type { AnimationEventHandler, ReactNode, Ref } from 'react';
import { Link } from 'react-router-dom';
import type { FeedId, FeedItem, ItemId } from '../lib/types';
import { useShareItem } from '../hooks/useShareItem';
import { useOpenOriginalFeeds } from '../hooks/useOpenOriginalFeeds';
import { useOpenNewshackerFeeds } from '../hooks/useOpenNewshackerFeeds';
import { useMarkDoneOnOpenFeeds } from '../hooks/useMarkDoneOnOpenFeeds';
import { useListLayoutFeeds } from '../hooks/useListLayoutFeeds';
import {
  useShowRowFavicon,
  useShowGroupFavicon,
  useHideSportsSpoilers,
} from '../hooks/useReadingPrefs';
import { useCapabilities, canUseFullText } from '../hooks/useCapabilities';
import { displayTitle } from '../lib/spoilerHeadline';
import { FeedFavicon } from './FeedFavicon';
import { ItemRow, type RightAction } from './ItemRow';
import { ChevronRight, Sweep, Undo } from './icons';
import { TooltipButton } from './TooltipButton';
import { LoadingState } from './States';
import './ItemList.css';

/** What to render as a feed-section header before a given row. */
export interface GroupHeader {
  feedId: FeedId;
  title: string;
  /** Site favicon shown to the left of the name; null/absent → no icon (the
   * common case until the poller has resolved one — see Feed.faviconUrl). */
  faviconUrl?: string | null;
}

interface Props {
  items: FeedItem[];
  /** Shown when there are no items and not loading. */
  emptyLabel: string;
  /** Render a loading indicator instead of rows or the empty state. */
  isLoading?: boolean;
  /** Label under the loading spinner. Feed views pass "Refreshing" (a fresh
   * article-list fetch could reorder the list); library/search/offline keep the
   * default "Loading…". */
  loadingLabel?: string;
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
  emptyMoreSections?: Array<{ feedId: FeedId; title: string; faviconUrl?: string | null }>;
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
  /** Forwarded to each row: fired when a row opens the in-app reader, so the
   * feed view can warm its own query cache while the reader is up. */
  onOpenReader?: () => void;
  /** Ids to render grayed-in-place: a cross-device dismiss that landed on a row
   * the reader was looking at (SPEC.md *Feed views → A stable set of articles*).
   * The row dims + strikes its title and its right-side button becomes Undo,
   * until a compaction (a pull-to-refresh, or a nav that remounts the list). */
  grayedIds?: Set<ItemId>;
  /** Restore a grayed row — wired to its Undo button. */
  onUndoDismiss?: (id: ItemId) => void;
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
  loadingLabel = 'Loading…',
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
  onOpenReader,
  grayedIds,
  onUndoDismiss,
}: Props) {
  const share = useShareItem();
  // Share the DISPLAYED headline, not the raw title, so a spoiler-hidden row
  // doesn't leak the original scoreline into the share sheet (same gate the row
  // renders with — see ItemRow / lib/spoilerHeadline).
  const { hideSportsSpoilers } = useHideSportsSpoilers();
  const spoilerAllowed = canUseFullText(useCapabilities());
  // Feeds the user set to "open original" — their rows link straight to the
  // source website instead of the in-app reader. One shared subscriptions read
  // backs every row, deduped via React Query.
  const openOriginalFeeds = useOpenOriginalFeeds();
  // Feeds the user set to "open on newshacker" — their rows link to the item's
  // Hacker News discussion on newshacker.app instead of the in-app reader.
  const openNewshackerFeeds = useOpenNewshackerFeeds();
  // Feeds the user set to "mark done when opening" — opening a row's original /
  // newshacker target also marks the item done. Same shared subscriptions read,
  // deduped via React Query.
  const markDoneOnOpenFeeds = useMarkDoneOnOpenFeeds();
  // Feeds the user gave a per-feed "card style" override — their rows render at
  // that layout instead of the app-wide Article layout setting. Same shared
  // subscriptions read, deduped via React Query. A feed absent from the map
  // (the common case) falls back to the app-wide setting inside ItemRow.
  const listLayoutFeeds = useListLayoutFeeds();
  // Off-by-default per-device setting (Settings → Appearance → Feed icons). Only
  // consulted in the non-grouped path below.
  const { showRowFavicon: showRowFaviconPref } = useShowRowFavicon();
  // On-by-default per-device setting (Settings → Appearance → Feed icons):
  // whether the group-by-feed section header carries the feed's icon.
  const { showGroupFavicon } = useShowGroupFavicon();

  // A subtle spinner with a visible "Loading…" label, rather than a run of
  // blank shimmer rows — the wait reads as loading, not as an empty feed still
  // painting in.
  if (isLoading) {
    return <LoadingState label={loadingLabel} showLabel />;
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

  // Grouped view (groupHeaders present) attributes each feed run with a section
  // header that carries the favicon, so rows omit it. Non-grouped views (flat
  // river, library, search, offline) have no header, so each row *can* show its
  // feed's favicon to attribute the interleaved sources — gated on the
  // off-by-default `show-row-favicon` setting.
  const showRowFavicon = showRowFaviconPref && !groupHeaders;

  const renderRow = (fi: FeedItem) => {
    // A grayed row is a cross-device dismiss caught in place: dim + strikethrough
    // (CSS on the row class), its right-side button swapped to Undo, and swipe
    // disabled (it's already done — the only action left is restore).
    const grayed = grayedIds?.has(fi.item.id) ?? false;
    const undoAction: RightAction | undefined =
      grayed && onUndoDismiss
        ? {
            label: 'Undo',
            icon: <Undo width={20} height={20} />,
            onToggle: () => onUndoDismiss(fi.item.id),
            testId: 'row-undo-dismiss',
            active: false,
          }
        : undefined;
    return (
      <li
        key={fi.item.id}
        className={
          'item-list__row' +
          (sweepingIds?.has(fi.item.id) ? ' item-list__row--sweeping' : '') +
          (grayed ? ' item-list__row--dismissed' : '')
        }
        data-item-id={fi.item.id}
        ref={getRowRef?.(fi.item.id)}
      >
        <ItemRow
          feedItem={fi}
          enableSwipe={enableSwipe && !grayed}
          openOriginal={openOriginalFeeds.has(fi.item.feedId)}
          openNewshacker={openNewshackerFeeds.has(fi.item.feedId)}
          markDoneOnOpen={markDoneOnOpenFeeds.has(fi.item.feedId)}
          listLayout={listLayoutFeeds.get(fi.item.feedId)}
          showFavicon={showRowFavicon}
          onShare={() =>
            share({
              title: displayTitle(fi.item, {
                hideSpoilers: hideSportsSpoilers,
                allowed: spoilerAllowed,
              }).text,
              url: fi.item.url,
            })
          }
          rightAction={undoAction ?? rightAction?.(fi)}
          onOpenReader={onOpenReader}
        />
      </li>
    );
  };

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
    faviconUrl?: string | null,
    reserveFaviconSpace = false,
  ): ReactNode => {
    const collapsed = collapsedFeeds?.has(feedId) ?? false;
    // Decorative site icon to the left of the name. On load error — a 404'd
    // guess (e.g. a derived /favicon.ico) or a bot-blocked favicon that won't
    // load in the browser — hide the image so there's no broken-image glyph,
    // but keep its 16px box (visibility, not display) so the feed name doesn't
    // snap left out of alignment with the siblings whose icons did load. Any
    // list rendering an <img> here already "uses favicons" (reserveFaviconSpace
    // is true whenever a header has a URL), so the slot is always worth holding.
    // A header with no favicon URL at all stands the same-size placeholder in
    // that slot, so every feed name in the list starts at the same left edge.
    // Suppressed entirely when the group-favicon setting is off — no icon and no
    // reserved slot, so the feed name sits flush against the chevron.
    const favicon = showGroupFavicon ? (
      <FeedFavicon
        url={faviconUrl}
        name={title}
        className="item-list__group-favicon"
        reserveSpace={reserveFaviconSpace}
        placeholderClassName="item-list__group-favicon-placeholder"
      />
    ) : null;
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
          // The name row collapses everywhere *except* the feed-name link (which
          // opens the feed) and the right-side Undo/Sweep actions. The chevron
          // stays far left as the keyboard-focusable collapse control; the unread
          // count rides the feed name's baseline inside the link (so it stays
          // aligned with the name, and tapping it opens the feed like the name);
          // the blank space to the right is a second, pointer-only collapse
          // region (aria-hidden, out of the tab order) so tapping beside the name
          // toggles too, without a duplicate screen-reader stop.
          <>
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
            </button>
            <Link
              className="item-list__group-link"
              data-testid="group-link"
              to={`/feed/${feedId}`}
              aria-label={`View ${title}`}
            >
              {favicon}
              {/* Title + count baseline-aligned so the number sits on the name's
                  text baseline rather than being centered against it (which left
                  the larger title looking slightly high). */}
              <span className="item-list__group-label">
                <span className="item-list__group-title">{title}</span>
                {showCount ? (
                  // Decorative: the count is announced via the chevron button's
                  // aria-label, so screen readers still hear the unread total.
                  <span className="item-list__group-count" aria-hidden="true">
                    {count > 99 ? '99+' : count}
                  </span>
                ) : null}
              </span>
            </Link>
            {/* A plain (non-focusable) div, not a button: this is a redundant
                pointer-only collapse region for the blank space beside the name,
                so it must never take focus or land in the accessibility tree —
                the chevron button above is the labeled, keyboard-operable
                collapse control. aria-hidden keeps it out of the a11y tree;
                keyboard/AT users use the chevron, so the deliberately missing key
                handler here is not an accessibility gap. */}
            <div
              className="item-list__group-collapse-rest"
              data-testid="group-collapse-rest"
              aria-hidden="true"
              onClick={() => onToggleCollapse(feedId)}
            />
          </>
        ) : (
          <span className="item-list__group-static" aria-hidden="true">
            {favicon}
            <span className="item-list__group-title">{title}</span>
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

  // Once any header in this list shows a favicon, reserve the icon slot in the
  // headers that lack one (feeds the poller hasn't resolved yet, or phantom
  // swept sections) so every feed name lines up at the same left edge instead
  // of some snapping flush to the chevron. Skipped when the group-favicon
  // setting is off — no header shows an icon, so there's nothing to align to.
  const anyFavicon =
    showGroupFavicon && sections.some((s) => !!s.header?.faviconUrl);

  const renderFeedSection = (section: Section): ReactNode => {
    const { feedId } = section;
    const collapsed = collapsedFeeds?.has(feedId) ?? false;
    const showFeedMore =
      !!onFeedMore && !collapsed && (feedsWithMore?.has(feedId) ?? false);
    return (
      <li className="item-list__section" key={`feed:${feedId}`}>
        {section.header
          ? renderHeader(
              feedId,
              section.header.title,
              section.headerForId!,
              false,
              section.header.faviconUrl,
              anyFavicon,
            )
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

  const renderPhantomSection = (p: { feedId: FeedId; title: string; faviconUrl?: string | null }): ReactNode => {
    const collapsed = collapsedFeeds?.has(p.feedId) ?? false;
    return (
      <li className="item-list__section" key={`empty-more:${p.feedId}`}>
        {renderHeader(p.feedId, p.title, `empty-more:${p.feedId}`, true, p.faviconUrl, anyFavicon)}
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
