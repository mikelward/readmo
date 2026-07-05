import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { FeedItem } from '../lib/types';
import {
  articleSourceDomain,
  formatDisplayDomain,
  formatItemMetaTail,
  isSafeHttpUrl,
} from '../lib/itemMeta';
import { FeedFavicon } from './FeedFavicon';
import { usePointerDevice } from '../hooks/usePointerDevice';
import { useWideViewport } from '../hooks/useWideViewport';
import { useSwipeToDismiss } from '../hooks/useSwipeToDismiss';
import { useItemState } from '../hooks/useItemState';
import { useHideSportsSpoilers, useListLayout } from '../hooks/useReadingPrefs';
import { leadImageUrl, itemPreviewText } from '../lib/itemPreview';
import { useCapabilities, canUseFullText } from '../hooks/useCapabilities';
import { displayTitle } from '../lib/spoilerHeadline';
import { ItemRowMenu, type ItemRowMenuItem } from './ItemRowMenu';
import { TooltipButton } from './TooltipButton';
import { Article, Check, PushPinFilled, PushPinOutline, VisibilityOff } from './icons';
import {
  hackerNewsItemId,
  isHackerNewsFeed,
  newshackerUrlForItem,
} from '../lib/newshacker';
import { suppressNextDoneMirror } from '../lib/newshackerMirrorSuppress';
import { rememberHackerNewsItemId } from '../lib/newshackerItemIds';
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
  /** When true (the feed's "open original" preference), the row body links
   * straight to the source website in a new tab instead of the in-app reader.
   * Ignored when the item URL isn't a safe http(s) URL — falls back to the
   * reader. */
  openOriginal?: boolean;
  /** When true (the feed's "open on newshacker" preference), the row body links
   * to the item's Hacker News discussion on newshacker.app in a new tab instead
   * of the in-app reader. `openOriginal` takes precedence if both are somehow set
   * (see {@link openModeOf}). Ignored when the item has no derivable Hacker News
   * id — falls back to the reader. */
  openNewshacker?: boolean;
  /** When true (the feed's "mark done when opening" preference), opening this
   * row's external target — the original source (open-original mode or the `o`
   * shortcut) or the newshacker discussion (newshacker mode) — also marks the
   * item Done. Deliberately does NOT fire for an in-app reader open (the plain
   * row-body tap on a reader-mode feed). */
  markDoneOnOpen?: boolean;
  /** Show the feed's favicon at the start of the meta line. On in non-grouped
   * views (flat river, library, search, offline), where rows from different
   * feeds interleave with no section header to attribute them; off in
   * group-by-feed view, where the section header carries the icon once instead
   * of repeating it on every row. */
  showFavicon?: boolean;
  onShare?: (item: FeedItem) => void;
}

export function ItemRow({
  feedItem,
  rightAction,
  enableSwipe = true,
  openOriginal = false,
  openNewshacker = false,
  markDoneOnOpen = false,
  showFavicon = false,
  onShare,
}: Props) {
  const { item, feed } = feedItem;
  const { state, set, toggle, hide } = useItemState(item.id);
  // Remember this row's HN id while it's on screen, so the newshacker mirror can
  // still resolve it when a later unpin/un-dismiss clears the item's visibility
  // (see src/lib/newshackerItemIds.ts). HN feeds only, so a non-HN post that
  // merely links to HN is never mirrored.
  useEffect(() => {
    if (!isHackerNewsFeed(feed)) return;
    const hnId = hackerNewsItemId(item);
    if (hnId != null) rememberHackerNewsItemId(item.id, Number(hnId));
  }, [item, feed]);
  const pinned = state.pinned;
  const opened = state.opened;
  const done = state.done;

  // Spoiler-free headline: for allowlisted callers with the setting on, show the
  // server-cached rewrite of a sports-result headline instead of the original
  // (see lib/spoilerHeadline). `title` is the DISPLAYED text, so every label /
  // menu header below stays spoiler-free too; the original rides the marker's
  // hover reveal.
  const { hideSportsSpoilers } = useHideSportsSpoilers();
  // Optimistic allowlist gate: OPEN while capabilities are still loading (default
  // caps → allowed). For a spoiler-HIDING feature this is the safe pending state
  // — showing the already-cached rewrite immediately avoids flashing the original
  // (spoiler) headline before caps resolve. The rewrite is non-sensitive (it
  // hides info, derived from a title the caller can already see), so an off-list
  // user briefly seeing it before the gate closes is harmless. (This differs from
  // the FETCH gate `useFullTextAllowed`, which must stay closed while loading to
  // avoid firing Edge calls — here there's no request, just which text to paint.)
  const spoilerAllowed = canUseFullText(useCapabilities());
  const headline = displayTitle(item, {
    hideSpoilers: hideSportsSpoilers,
    allowed: spoilerAllowed,
  });
  const title = headline.text || '[untitled]';
  const source = feed.title || formatDisplayDomain(item.url);
  // Surface the article's domain next to the feed name on aggregator feeds
  // (Hacker News, Reddit) whose rows link out elsewhere. Only when there's a
  // feed name to sit beside — without one, `source` is already the domain.
  const domain = feed.title
    ? articleSourceDomain(item.url, feed.siteUrl ?? feed.url)
    : '';
  // Larger Article-layout card variants (Settings → Appearance → Article
  // layout). 'title' is the compact default; 'thumbnail' adds a right-floated
  // image and 'excerpt' a preview of the feed body. Both extra elements live
  // INSIDE the row-body link, so the row keeps its two tap zones (guardrail #2).
  const { listLayout } = useListLayout();
  const [imageFailed, setImageFailed] = useState(false);
  const leadImage = useMemo(
    () => (listLayout === 'thumbnail' ? leadImageUrl(item) : null),
    [listLayout, item],
  );
  const showLeadImage = leadImage != null && !imageFailed;
  // Excerpt layout always previews the body; thumbnail layout falls back to the
  // same preview when the row has no usable image — none found, or it failed to
  // load (`imageFailed`) — so a thumbnail-mode row is never a bare title, it
  // shows the excerpt instead. (An image-bearing thumbnail row shows the image
  // and no excerpt.)
  const wantExcerpt =
    listLayout === 'excerpt' || (listLayout === 'thumbnail' && !showLeadImage);
  const previewText = useMemo(
    () => (wantExcerpt ? itemPreviewText(item) : ''),
    [wantExcerpt, item],
  );
  // The feed's per-feed open mode resolves to an external link target for this
  // row, or null to fall back to the in-app reader. "Open original" wins over
  // "open on newshacker" if both flags are somehow set — the same precedence as
  // {@link openModeOf}, since the only both-true source is a legacy client's
  // explicit open_original write. Each mode falls back to the reader when its
  // target can't be built (no safe http URL / no Hacker News id).
  const openOriginalHref =
    openOriginal && isSafeHttpUrl(item.url) ? item.url : null;
  const newshackerHref = openNewshacker ? newshackerUrlForItem(item) : null;
  const externalHref = openOriginalHref ?? newshackerHref;
  // newshacker is our own sibling app, not an untrusted publisher, so its
  // discussion opens in the SAME tab (no `target="_blank"`) — that makes Readmo
  // the browser's previous entry, so newshacker's Done/back returns here. We
  // also drop `rel="noopener noreferrer"`: there's no reverse-tabnabbing risk
  // from ourselves, and letting newshacker see the readmo.app referrer leaks
  // nothing (route paths carry no secrets). Untrusted source URLs keep the
  // new-tab + noopener/noreferrer hardening (guardrail #6).
  const externalIsNewshacker = openOriginalHref == null && newshackerHref != null;
  // A feed-style external-open row (no library inverse action) gets a dedicated
  // "Open in reader" button to the left of the Done/Pin cluster — since the row
  // body now opens the source/newshacker target, that button is the row's one
  // remaining path to the in-app reader. Library rows keep their own right-side
  // action and just open the external target on a row-body tap.
  const externalRow = externalHref != null && !rightAction;

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  const pointerDevice = usePointerDevice();
  const wide = useWideViewport();
  const navigate = useNavigate();

  const handleHide = useCallback(() => hide(), [hide]);
  const handlePin = useCallback(() => set('pinned', true), [set]);
  const handleTogglePin = useCallback(() => toggle('pinned'), [toggle]);
  const handleMarkUnread = useCallback(() => set('opened', false), [set]);
  const handleShare = useCallback(() => onShare?.(feedItem), [onShare, feedItem]);
  const markOpened = useCallback(() => set('opened', true), [set]);
  // Opening this row's EXTERNAL target — the original source (open-original mode
  // or the `o` shortcut) or the newshacker discussion (newshacker mode) — marks
  // the item Opened and, when the feed opts into "mark done when opening", also
  // marks it Done (which clears pinned via the mutation shield). The plain
  // reader-mode body tap uses `markOpened` above, so an in-app reader open never
  // marks done.
  // TODO(same-tab-open race): the newshacker open is now a same-tab navigation
  // (see externalIsNewshacker below), so these state writes race page-unload —
  // the optimistic local write should survive and re-sync on next load, but the
  // in-flight remote sync can be cancelled. If opened/done occasionally fails to
  // stick on an open-on-newshacker tap, make the write durable across unload
  // (e.g. navigator.sendBeacon, fetch keepalive, or await the local persist
  // before navigating). Source-URL opens stay in a new tab, so they're unaffected.
  const markOpenedExternal = useCallback(() => {
    set('opened', true);
    if (markDoneOnOpen) {
      // Opening ON newshacker is a handoff, not a dismissal: suppress the mirror
      // of this one Done so we don't sweep the item to Done on newshacker as the
      // user arrives to read it there. Opening the ORIGINAL source still mirrors.
      // See src/lib/newshackerMirrorSuppress.ts.
      if (externalIsNewshacker) suppressNextDoneMirror(item.id);
      set('done', true);
    }
  }, [set, markDoneOnOpen, externalIsNewshacker, item.id]);
  // On an external-open row the body itself goes to the source/newshacker target,
  // so the dedicated row button is the one remaining path to the in-app reader:
  // it navigates to the reader and marks the item opened (same as a reader-mode
  // row-body tap), giving the row both destinations.
  const handleOpenReader = useCallback(() => {
    markOpened();
    navigate(`/item/${item.id}`);
  }, [markOpened, navigate, item.id]);

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
    (opened ? ' item-row--opened' : '') +
    (listLayout === 'thumbnail' ? ' item-row--thumbnail' : '') +
    (listLayout === 'excerpt' ? ' item-row--excerpt' : '');

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
            // `o` opens the original, so it honors "mark done when opening" too.
            markOpenedExternal();
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
      markOpenedExternal,
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

  // The row-body label (title + meta), shared by the in-app-reader Link and the
  // "open original" external anchor so the two only differ in where they go.
  const bodyContent = (
    <>
      {showLeadImage ? (
        // Decorative (the title names the article), so alt="" + aria-hidden keeps
        // it out of the accessible name and adds no extra tap zone. Lazy so
        // off-screen rows don't fetch until scrolled near.
        <span className="item-row__lead" aria-hidden="true">
          <img
            className="item-row__lead-img"
            src={leadImage ?? undefined}
            alt=""
            loading="lazy"
            decoding="async"
            data-testid="item-lead-image"
            onError={() => setImageFailed(true)}
          />
        </span>
      ) : null}
      <span className="item-row__title-text">
        {title}
        {headline.rewritten ? (
          // Non-interactive marker (NOT a tap zone — guardrail #2): flags that the
          // headline was rewritten to hide a sports result. role="img" + label so
          // it's announced; native `title` reveals the original on hover/long-press.
          <span
            className="item-row__spoiler-flag"
            role="img"
            aria-label="Spoiler-free headline"
            title={headline.original}
            data-testid="item-spoiler-flag"
          >
            <VisibilityOff width={14} height={14} />
          </span>
        ) : null}
      </span>
      {previewText ? (
        // Excerpt layout: when the headline itself is a hidden spoiler
        // (`headline.rewritten`), the feed body almost always repeats the
        // result the rewrite just concealed — so swap the preview for a
        // placeholder rather than leak the scoreline in the excerpt. The
        // row-body link still opens the full article on tap.
        headline.rewritten ? (
          <span
            className="item-row__excerpt item-row__excerpt--spoiler"
            data-testid="item-excerpt"
          >
            Spoilers hidden. Tap to see article.
          </span>
        ) : (
          <span className="item-row__excerpt" data-testid="item-excerpt">
            {previewText}
          </span>
        )
      ) : null}
      <span className="item-row__meta" data-testid="item-meta">
        {/* Per-row favicon only in non-grouped views (showFavicon). In
            group-by-feed view the icon lives on the section header instead, so
            it isn't repeated on every row. Reserve the slot here: with favicons
            on, a row whose icon is missing (null) or fails to load must keep the
            16px box so its meta line stays aligned with the sibling rows whose
            icons did load, instead of snapping left (a jagged interleaved list). */}
        {showFavicon ? (
          <FeedFavicon
            url={feed.faviconUrl}
            name={source}
            className="item-row__favicon"
            testId="item-favicon"
            reserveSpace
            placeholderClassName="item-row__favicon-placeholder"
          />
        ) : null}
        {formatItemMetaTail({
          source,
          domain,
          publishedAt: item.publishedAt,
          author: item.author,
        })}
      </span>
    </>
  );

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
        {externalHref ? (
          // Open mode (original / newshacker): the row body goes straight to the
          // external target (marking the item opened, like the in-app reader and
          // the `o` shortcut) instead of navigating to the reader. Source URLs
          // open in a new tab with the untrusted-link hardening; the newshacker
          // discussion opens in the same tab (see externalIsNewshacker).
          <a
            href={externalHref}
            target={externalIsNewshacker ? undefined : '_blank'}
            rel={externalIsNewshacker ? undefined : 'noopener noreferrer'}
            className="item-row__body"
            data-testid="item-title"
            onClick={markOpenedExternal}
            onKeyDown={handleRowKeyDown}
          >
            {bodyContent}
          </a>
        ) : (
          <Link
            to={`/item/${item.id}`}
            className="item-row__body"
            data-testid="item-title"
            onClick={markOpened}
            onKeyDown={handleRowKeyDown}
          >
            {bodyContent}
          </Link>
        )}

        {externalRow ? (
          // External-open feed row: the row body opens the source/newshacker
          // target, so this dedicated button — to the left of the Done/Pin
          // cluster — is the row's path to the in-app reader. The `Article` glyph
          // reads as "open in reader" regardless of which external mode the feed
          // is in. Pin and Done are unchanged.
          <TooltipButton
            type="button"
            className="pin-btn"
            data-testid="open-reader-btn"
            aria-label={`Open ${title} in reader`}
            tooltip="Open in reader"
            onClick={handleOpenReader}
          >
            <span className="pin-btn__icon">
              <Article />
            </span>
          </TooltipButton>
        ) : null}

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
