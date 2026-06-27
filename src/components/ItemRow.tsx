import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { FeedItem } from '../lib/types';
import { formatDisplayDomain, formatItemMetaTail, isSafeHttpUrl } from '../lib/itemMeta';
import { usePointerDevice } from '../hooks/usePointerDevice';
import { useWideViewport } from '../hooks/useWideViewport';
import { useSwipeToDismiss } from '../hooks/useSwipeToDismiss';
import { useItemState } from '../hooks/useItemState';
import { ItemRowMenu, type ItemRowMenuItem } from './ItemRowMenu';
import { TooltipButton } from './TooltipButton';
import { Check, PushPinFilled, PushPinOutline } from './icons';
import './ItemRow.css';

export interface RightAction {
  label: string;
  icon: ReactNode;
  onToggle: () => void;
  testId?: string;
  active?: boolean;
}

interface Props {
  feedItem: FeedItem;
  /** Replaces the default Pin/Unpin button with a view-contextual inverse
   * action (library views: Unpin / Unfavorite / Unmark done / Unhide /
   * Mark unread). */
  rightAction?: RightAction;
  /** Feed views enable swipe (right=Hide, left=Pin). Library views disable
   * it — every row there already holds the state the view represents. */
  enableSwipe?: boolean;
  onShare?: (item: FeedItem) => void;
}

export function ItemRow({
  feedItem,
  rightAction,
  enableSwipe = true,
  onShare,
}: Props) {
  const { item, feed } = feedItem;
  const { state, set, toggle, hide } = useItemState(item.id);
  const pinned = state.pinned;
  const opened = state.opened;
  const done = state.done;

  const title = item.title || '[untitled]';
  const source = feed.title || formatDisplayDomain(item.url);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const pointerDevice = usePointerDevice();
  const wide = useWideViewport();

  const handleHide = useCallback(() => hide(), [hide]);
  const handlePin = useCallback(() => set('pinned', true), [set]);
  const handleTogglePin = useCallback(() => toggle('pinned'), [toggle]);
  const handleMarkUnread = useCallback(() => set('opened', false), [set]);
  const handleShare = useCallback(() => onShare?.(feedItem), [onShare, feedItem]);
  const markOpened = useCallback(() => set('opened', true), [set]);

  const openMenu = useCallback(() => {
    setMenuAnchor(articleRef.current);
    setMenuOpen(true);
  }, []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // Pin shields against every swipe (both directions rubber-band); a swipe
  // whose handler is undefined falls through to snap-back. Library views
  // (enableSwipe=false) bind no swipe handlers, only long-press.
  const { dragging, isDismissing, reset, style, handlers } = useSwipeToDismiss({
    onSwipeRight: enableSwipe && !pinned ? handleHide : undefined,
    onSwipeLeft: enableSwipe && !pinned ? handlePin : undefined,
    onLongPress: openMenu,
    // Swipe-right hides the row → it will unmount when the data layer
    // refetches; hold the off-screen state until then so the row doesn't
    // visibly snap back during the async unmount window. Swipe-left pins,
    // which keeps the row mounted in place (an in-session pin holds its
    // position rather than jumping to the top), so it snaps back.
    dismissOnRight: true,
  });

  // The off-screen state from a swipe-right dismissal persists until the
  // parent unmounts the row. If the dismissal is rolled back before that
  // happens — toolbar Undo flips `done` back to false, or a refetch failure
  // means the row never gets dropped from the page and the user undoes it —
  // the same component would remain mounted but invisible. Snap it back the
  // moment `done` reverts.
  //
  // Crucial gate: the hook flips `isDismissing` to true on *pointer-up*, but
  // `handleHide` doesn't run (so `done` doesn't flip) until the 200ms exit
  // timer fires. A naive `isDismissing && !done` check matches during the
  // animation and would `reset()` — clearing the pending timer before the
  // swipe handler runs — making swipe-right silently snap back without
  // mutating state. Swipe-left Pin never sets `done` at all, same problem.
  // We must observe `done` going true (the dismissal landed) *first*; only
  // then does a subsequent false count as an undo.
  const observedDoneRef = useRef(false);
  useEffect(() => {
    if (!isDismissing) {
      observedDoneRef.current = false;
      return;
    }
    if (done) {
      observedDoneRef.current = true;
    } else if (observedDoneRef.current) {
      reset();
    }
  }, [done, isDismissing, reset]);

  const swipeOnContextMenu = handlers.onContextMenu;
  const handleContextMenu = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      swipeOnContextMenu?.(e);
      if (!pointerDevice) return;
      e.preventDefault();
      setMenuAnchor(articleRef.current);
      setMenuOpen(true);
    },
    [swipeOnContextMenu, pointerDevice],
  );

  const menuItems = useMemo<ItemRowMenuItem[]>(() => {
    const items: ItemRowMenuItem[] = [];
    if (pinned) {
      items.push({ key: 'unpin', label: 'Unpin', onSelect: handleTogglePin });
    } else {
      items.push({ key: 'pin', label: 'Pin', onSelect: handlePin });
    }
    // Done is suppressed on pinned rows (same rule as swipe-right).
    if (!pinned) {
      items.push({ key: 'hide', label: 'Done', onSelect: handleHide });
    }
    if (opened) {
      items.push({
        key: 'mark-unread',
        label: 'Mark unread',
        onSelect: handleMarkUnread,
      });
    }
    if (onShare) {
      items.push({ key: 'share', label: 'Share', onSelect: handleShare });
    }
    return items;
  }, [
    pinned,
    opened,
    onShare,
    handlePin,
    handleHide,
    handleTogglePin,
    handleMarkUnread,
    handleShare,
  ]);

  const rowClass =
    'item-row' +
    (dragging ? ' item-row--dragging' : '') +
    (isDismissing ? ' item-row--dismissing' : '') +
    (opened ? ' item-row--opened' : '');

  const handleRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLAnchorElement>) => {
      if (e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case ' ':
        case 'Spacebar': {
          if (menuItems.length > 0) {
            e.preventDefault();
            openMenu();
          }
          break;
        }
        case 'o': {
          if (isSafeHttpUrl(item.url)) {
            e.preventDefault();
            markOpened();
            window.open(item.url, '_blank', 'noopener,noreferrer');
          }
          break;
        }
        case 'p': {
          e.preventDefault();
          handleTogglePin();
          break;
        }
        case 'd': {
          if (enableSwipe && !pinned) {
            e.preventDefault();
            handleHide();
          }
          break;
        }
      }
    },
    [
      menuItems.length,
      openMenu,
      item.url,
      markOpened,
      handleTogglePin,
      enableSwipe,
      pinned,
      handleHide,
    ],
  );

  // Swipe-reveal hints — each edge labels the outcome of a swipe revealing
  // that edge; shield text when the row's state blocks the gesture.
  const leftHint = pinned
    ? { label: 'Pinned', testId: 'swipe-hint-pinned-left' }
    : enableSwipe
      ? { label: 'Done', testId: 'swipe-hint-done' }
      : null;
  const rightHint = pinned
    ? { label: 'Pinned', testId: 'swipe-hint-pinned-right' }
    : enableSwipe
      ? { label: 'Pin', testId: 'swipe-hint-pin' }
      : null;

  const pinLabel = pinned ? `Unpin ${title}` : `Pin ${title}`;
  const doneLabel = done ? `Unmark ${title} done` : `Mark ${title} done`;
  // Wide-viewport-only Done button on feed rows: surfaces the same toggle the
  // reader's action bar has, in the row's reserved middle slot. Suppressed on
  // library views (the row's right-side action already names the slot's intent)
  // and on narrow viewports (the row keeps its two-tap-zone mobile shape).
  const showDoneButton = !rightAction && wide;
  const handleToggleDone = useCallback(() => {
    if (done) set('done', false);
    else hide();
  }, [done, set, hide]);

  return (
    <>
      {leftHint ? (
        <span
          className="item-row__swipe-hint item-row__swipe-hint--left"
          data-testid={leftHint.testId}
          aria-hidden="true"
        >
          {leftHint.label}
        </span>
      ) : null}
      {rightHint ? (
        <span
          className="item-row__swipe-hint item-row__swipe-hint--right"
          data-testid={rightHint.testId}
          aria-hidden="true"
        >
          {rightHint.label}
        </span>
      ) : null}
      <article
        ref={articleRef}
        className={rowClass}
        data-testid="item-row"
        style={style}
        {...handlers}
        onContextMenu={handleContextMenu}
      >
        <Link
          to={`/item/${item.id}`}
          className="item-row__body"
          data-testid="item-title"
          onClick={markOpened}
          onKeyDown={handleRowKeyDown}
        >
          <span className="item-row__title-text">{title}</span>
          <span className="item-row__meta" data-testid="item-meta">
            {feed.faviconUrl ? (
              <img
                className="item-row__favicon"
                src={feed.faviconUrl}
                alt=""
                aria-hidden="true"
                width={14}
                height={14}
              />
            ) : null}
            {formatItemMetaTail({
              source,
              publishedAt: item.publishedAt,
              author: item.author,
            })}
          </span>
        </Link>

        {showDoneButton ? (
          <TooltipButton
            type="button"
            className={'pin-btn' + (done ? ' pin-btn--active' : '')}
            data-testid="done-btn"
            aria-pressed={done}
            aria-label={doneLabel}
            tooltip={done ? 'Unmark done' : 'Done'}
            onClick={handleToggleDone}
          >
            <span className="pin-btn__icon">
              <Check />
            </span>
          </TooltipButton>
        ) : null}

        {rightAction ? (
          <TooltipButton
            type="button"
            className={
              'pin-btn' + (rightAction.active === false ? '' : ' pin-btn--active')
            }
            data-testid={rightAction.testId ?? 'row-action-btn'}
            aria-label={rightAction.label}
            tooltip={rightAction.label}
            onClick={rightAction.onToggle}
          >
            <span className="pin-btn__icon">{rightAction.icon}</span>
          </TooltipButton>
        ) : (
          <TooltipButton
            type="button"
            className={'pin-btn' + (pinned ? ' pin-btn--active' : '')}
            data-testid="pin-btn"
            aria-pressed={pinned}
            aria-label={pinLabel}
            tooltip={pinned ? 'Unpin' : 'Pin'}
            onClick={handleTogglePin}
          >
            <span className="pin-btn__icon">
              {pinned ? <PushPinFilled /> : <PushPinOutline />}
            </span>
          </TooltipButton>
        )}

        {menuItems.length > 0 ? (
          <ItemRowMenu
            open={menuOpen}
            title={title}
            items={menuItems}
            anchorEl={menuAnchor}
            onClose={closeMenu}
          />
        ) : null}
      </article>
    </>
  );
}
