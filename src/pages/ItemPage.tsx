import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useIsRestoring, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { findCachedFeedItem } from '../lib/offlineItem';
import { useItemState } from '../hooks/useItemState';
import { useWideViewport } from '../hooks/useWideViewport';
import { useShareItem } from '../hooks/useShareItem';
import { useConnectivityStatus } from '../hooks/useOnlineStatus';
import { formatAge, formatDisplayDomain, isSafeHttpUrl } from '../lib/itemMeta';
import { fullTextStaleTime, looksTruncated } from '../lib/fullText';
import type { FullTextResult } from '../lib/fullText';
import type { Item, ItemState, ItemStateField } from '../lib/types';
import { TooltipButton } from '../components/TooltipButton';
import { ItemRowMenu, type ItemRowMenuItem } from '../components/ItemRowMenu';
import { LoadError } from '../components/LoadError';
import { loadFailureCopy } from '../lib/loadErrorCopy';
import { ReaderSkeleton } from '../components/Skeletons';
import {
  ArrowBack,
  Check,
  FavoriteFilled,
  FavoriteOutline,
  MoreVert,
  OpenInNew,
  PushPinFilled,
  PushPinOutline,
  Share as ShareIcon,
  VerticalAlignTop,
} from '../components/icons';
import './ItemPage.css';

/** True when a cached `['fulltext', id]` result already holds a usable reading
 * body (a terminal `ok` with HTML) — i.e. the full article is available without
 * a fresh fetch, so the reader can open straight into the reading view. */
function cachedFullTextOk(ft: FullTextResult | undefined): boolean {
  return ft?.status === 'ok' && !!ft.contentHtml;
}

interface ReaderToolbarProps {
  /** Where the bar sits. The bottom copy suffixes its test ids so the two
   * toolbars don't collide. */
  placement: 'top' | 'bottom';
  item: Item;
  state: ItemState;
  wide: boolean;
  onBack: () => void;
  openOriginal: () => void;
  toggle: (field: ItemStateField) => void;
  set: (field: ItemStateField, value: boolean) => void;
  markDone: () => void;
  share: (item: { title: string; url: string }) => void;
  /** Whether the shared overflow menu is currently open (drives the More
   * button's aria-expanded). The menu itself lives at the page level so
   * the top and bottom bars share one instance — see newshacker's Thread. */
  menuOpen: boolean;
  /** Open the shared overflow menu anchored to the given element (the More
   * button of whichever bar was tapped). */
  onOpenMenu: (anchor: HTMLElement | null) => void;
}

function ReaderToolbar({
  placement,
  item,
  state,
  wide,
  onBack,
  openOriginal,
  toggle,
  set,
  markDone,
  share,
  menuOpen,
  onOpenMenu,
}: ReaderToolbarProps) {
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const sfx = placement === 'bottom' ? '-bottom' : '';

  return (
    <div className={`reader__${placement}bar`}>
      {placement === 'bottom' ? (
        <button
          type="button"
          className="reader__back"
          aria-label="Back to top"
          data-testid="reader-back-to-top"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <VerticalAlignTop />
        </button>
      ) : (
        <button
          type="button"
          className="reader__back"
          aria-label="Back"
          onClick={onBack}
        >
          <ArrowBack />
        </button>
      )}

      <div className="reader__actions" role="toolbar" aria-label="Article actions">
        <TooltipButton
          type="button"
          className="reader__action reader__action--primary"
          tooltip="Open original"
          aria-label="Open original article"
          onClick={openOriginal}
          data-testid={`open-original${sfx}`}
        >
          <OpenInNew />
          <span className="reader__action-label">Open original</span>
        </TooltipButton>

        <TooltipButton
          type="button"
          className={'reader__action' + (state.pinned ? ' reader__action--active' : '')}
          tooltip={state.pinned ? 'Unpin' : 'Pin'}
          aria-label={state.pinned ? 'Unpin' : 'Pin'}
          aria-pressed={state.pinned}
          onClick={() => toggle('pinned')}
          data-testid={`reader-pin${sfx}`}
        >
          {state.pinned ? <PushPinFilled /> : <PushPinOutline />}
        </TooltipButton>

        <TooltipButton
          type="button"
          className={'reader__action' + (state.done ? ' reader__action--active' : '')}
          tooltip={state.done ? 'Unmark done' : 'Done'}
          aria-label={state.done ? 'Unmark done' : 'Done'}
          aria-pressed={state.done}
          onClick={() => (state.done ? set('done', false) : markDone())}
          data-testid={`reader-done${sfx}`}
        >
          <Check />
        </TooltipButton>

        {wide ? (
          <>
            <TooltipButton
              type="button"
              className={
                'reader__action' + (state.favorite ? ' reader__action--active' : '')
              }
              tooltip={state.favorite ? 'Unfavorite' : 'Favorite'}
              aria-label={state.favorite ? 'Unfavorite' : 'Favorite'}
              aria-pressed={state.favorite}
              onClick={() => toggle('favorite')}
              data-testid={`reader-favorite${sfx}`}
            >
              {state.favorite ? <FavoriteFilled /> : <FavoriteOutline />}
            </TooltipButton>
            <TooltipButton
              type="button"
              className="reader__action"
              tooltip="Share"
              aria-label="Share"
              onClick={() => share({ title: item.title, url: item.url })}
              data-testid={`reader-share${sfx}`}
            >
              <ShareIcon />
            </TooltipButton>
          </>
        ) : null}

        <div className="reader__more">
          <TooltipButton
            ref={moreBtnRef}
            type="button"
            className="reader__action"
            tooltip="More"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => onOpenMenu(moreBtnRef.current)}
            data-testid={`reader-more${sfx}`}
          >
            <MoreVert />
          </TooltipButton>
        </div>
      </div>
    </div>
  );
}

export function ItemPage() {
  const { id = '' } = useParams();
  const ds = useDataSource();
  const navigate = useNavigate();
  const wide = useWideViewport();
  const share = useShareItem();
  const status = useConnectivityStatus();
  // `online` gates the offline fallback + full-text fetch (both keyed on
  // "fully connected"); `status` distinguishes a genuine disconnect from our
  // backend being down so the miss-state message can say which it is.
  const online = status === 'online';

  const { state, set, toggle } = useItemState(id);
  const queryClient = useQueryClient();
  // True while the persisted query cache is still hydrating at boot. The offline
  // fallback below scans that cache, so it must wait for (and recompute after)
  // restoration — otherwise a cold offline start scans an empty cache and stays
  // stuck on the miss state. Outside the persist provider (tests) this is false.
  const isRestoring = useIsRestoring();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['item', id],
    queryFn: () => ds.getItem(id),
  });

  // Full error to the console (desktop); the on-screen miss-state shows a
  // friendly headline + curated detail for the mobile case where there's no
  // console. Only an actual read error is worth logging — an offline miss with
  // no error object isn't a failure to investigate.
  useEffect(() => {
    if (error) console.error('[readmo] fetching this article failed:', error);
  }, [error]);

  // Offline fallback: when the per-item detail read *fails* (the fetch errored,
  // or we're offline and it can't run) recover the RSS body from a list page
  // already on this device, so an unpinned article stays readable offline (the
  // feed's own body, not the extracted reading view). See `lib/offlineItem`.
  //
  // Gated to "no successful detail result" on purpose. `data === null` is a
  // *successful* miss — the server says the item isn't visible (e.g. after
  // unsubscribing — RLS hides it) — and stays authoritative even offline, so we
  // key on `data === undefined` (errored / never-resolved), NOT `!data` (which
  // would also swallow a cached `null` miss and override it with a stale row).
  const detailUnavailable =
    data === undefined && !isLoading && (isError || !online);
  // Recompute once restoration finishes: `isRestoring` flipping false re-renders
  // this component and re-runs the scan against the now-hydrated list caches.
  const fallback = useMemo(
    () =>
      detailUnavailable && !isRestoring ? findCachedFeedItem(queryClient, id) : null,
    [detailUnavailable, isRestoring, queryClient, id],
  );
  const resolved = data ?? fallback;

  // Reading mode: when the feed body looks truncated, fetch the full article
  // from its source (server-side extraction) in the background while the RSS
  // body shows immediately. `manualTrigger` lets the user request it for a feed
  // whose body looked complete; `userView` is the per-article view the user has
  // chosen (null = the default for this article). Pinning caches this query (and
  // the item detail) for offline via usePinnedCacheLock.
  const [manualTrigger, setManualTrigger] = useState(false);
  const [userView, setUserView] = useState<'feed' | 'full' | null>(null);
  // Whether a full body was ALREADY available when this article opened — cached
  // in the `['fulltext', id]` query by a pinned/favorite prefetch or an earlier
  // open. Such an article opens straight into the reading view (like a body
  // cached on the item itself). Only a body fetched *fresh in the background*
  // this session waits behind "Keep reading" (so the reader doesn't reflow). The
  // lazy init reads the cache synchronously to avoid a one-frame feed flash.
  const [fullReadyAtOpen, setFullReadyAtOpen] = useState(() =>
    cachedFullTextOk(queryClient.getQueryData<FullTextResult>(['fulltext', id])),
  );

  const cachedFull = resolved?.item.fullContentHtml ?? null;
  const truncated = resolved ? looksTruncated(resolved.item) : false;
  const wantFull = !!resolved && !cachedFull && online && (truncated || manualTrigger);

  const fullQuery = useQuery({
    queryKey: ['fulltext', id],
    queryFn: () => ds.fetchFullText(id),
    enabled: wantFull,
    // Terminal outcomes (ok/empty/auth) are cached forever; a transient
    // `unreachable` stays stale so reopening (or the in-view "Try again")
    // retries it. Shared with the pin-time prefetch (useFullTextPrefetch).
    staleTime: fullTextStaleTime,
  });

  // Opening the reader marks the item Opened (auto), and resets the per-article
  // reading-mode view state when navigating between items.
  useEffect(() => {
    if (resolved) set('opened', true);
    setManualTrigger(false);
    setUserView(null);
    // Re-snapshot "was the full body already cached?" for the newly-opened item
    // (SPA navigation between items reuses this component, so the lazy init
    // above only covers the first mount).
    setFullReadyAtOpen(
      cachedFullTextOk(queryClient.getQueryData<FullTextResult>(['fulltext', id])),
    );
    // Only when the item first resolves / changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved?.item.id]);

  const openOriginal = useCallback(() => {
    if (resolved && isSafeHttpUrl(resolved.item.url)) {
      set('opened', true);
      window.open(resolved.item.url, '_blank', 'noopener,noreferrer');
    }
  }, [resolved, set]);

  const markDone = useCallback(() => {
    set('done', true); // also clears pinned via the mutation shield
    navigate(-1);
  }, [set, navigate]);

  const goBack = useCallback(() => navigate(-1), [navigate]);

  // Shared overflow menu for the reader's top + bottom bars. Lifted to the
  // page (like newshacker's Thread) so both ⋮ buttons drive one menu
  // instance — the shared ItemRowMenu, which brings anchored-popover
  // placement, Escape / click-outside dismissal, and the first-tap-only
  // swallow with it.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const openMenu = useCallback(
    (anchor: HTMLElement | null) => {
      // Toggle closed when the same anchor is tapped again — standard
      // popover behavior, matching newshacker's thread menu.
      setMenuOpen((prev) => {
        if (prev && menuAnchor === anchor) {
          setMenuAnchor(null);
          return false;
        }
        setMenuAnchor(anchor);
        return true;
      });
    },
    [menuAnchor],
  );
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setMenuAnchor(null);
  }, []);
  // Favorite/Share live on the bar as inline icons on wide viewports, so
  // they drop out of the menu there to avoid duplicate entry points; below
  // 960px they stay here. Open feed is always in the menu.
  const menuItems = useMemo<ItemRowMenuItem[]>(() => {
    if (!resolved) return [];
    const it = resolved.item;
    const items: ItemRowMenuItem[] = [];
    if (!wide) {
      items.push({
        key: 'favorite',
        label: state.favorite ? 'Unfavorite' : 'Favorite',
        onSelect: () => toggle('favorite'),
      });
      items.push({
        key: 'share',
        label: 'Share',
        onSelect: () => share({ title: it.title, url: it.url }),
      });
    }
    items.push({
      key: 'open-feed',
      label: 'Open feed',
      onSelect: () => navigate(`/feed/${resolved.feed.id}`),
    });
    return items;
  }, [resolved, wide, state.favorite, toggle, share, navigate]);

  // Reader keyboard shortcuts: o open original, p pin, f favorite, d done.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      switch (e.key) {
        case 'o':
          openOriginal();
          break;
        case 'p':
          toggle('pinned');
          break;
        case 'f':
          toggle('favorite');
          break;
        case 'd':
          markDone();
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openOriginal, toggle, markDone]);

  if (isLoading || isRestoring) {
    // role="status" makes this a live region so screen readers announce the
    // loading state; the skeleton itself is decorative (aria-hidden), so the
    // visually-hidden label carries the announced text. No aria-busy here: a
    // busy live region defers its announcement until busy flips to false, but
    // this wrapper unmounts when loading ends rather than flipping, which would
    // suppress the announcement entirely.
    return (
      <div className="reader reader--loading" role="status">
        <span className="visually-hidden">Loading article…</span>
        <ReaderSkeleton />
      </div>
    );
  }
  if (!resolved) {
    // Same accurate-copy approach as the feed list: name the action and show a
    // curated detail when the server actually errored, only say "isn't
    // responding" when the backend is truly unreachable, and keep the bespoke
    // offline line (pin-for-offline, no retry — retrying can't help offline).
    const copy = loadFailureCopy(status, error, {
      action: 'fetching this article',
      noun: 'this article',
      offline: 'This article isn’t saved offline. Pin it while online to keep a copy.',
    });
    return (
      <div className="reader__state">
        <LoadError
          headline={copy.headline}
          detail={copy.detail}
          onRetry={status === 'offline' ? undefined : () => refetch()}
        />
      </div>
    );
  }

  const { item, feed } = resolved;
  const source = feed.title || formatDisplayDomain(item.url);

  // Resolve the reading-mode body. The RSS body always shows first; the full
  // article (cached, or fetched in the background) is revealed only when the
  // user asks for it via "Keep reading" — except a body already cached full
  // (pinned/previously read) defaults straight to the reading view.
  const fetched = fullQuery.data;
  const fullHtml = cachedFull ?? (fetched?.status === 'ok' ? fetched.contentHtml : null);
  // A full body that was already on hand at open — cached on the item, or in the
  // fulltext query from a prefetch/earlier open — opens straight into reading
  // mode; only a fresh background fetch waits behind "Keep reading".
  const defaultView: 'feed' | 'full' = cachedFull || fullReadyAtOpen ? 'full' : 'feed';
  const view = userView ?? defaultView;
  const showReading = view === 'full' && !!fullHtml;
  const bodyHtml = showReading ? fullHtml : item.contentHtml;
  const fetchingFull = fullQuery.isFetching && !fullHtml;
  // Full article is fetched and ready, but we're still showing the feed body —
  // offer to reveal it (no auto-swap, so the reader doesn't reflow mid-read).
  const keepReading = !!fullHtml && !showReading;
  // A non-"ok" result (paywall/teaser/unreachable) — only worth surfacing once
  // we have nothing better than the feed body to show.
  const fullFailed = !fullHtml && fetched != null && fetched.status !== 'ok';
  const canGetFull = !fullHtml && !fetchingFull && !wantFull && online;

  const toolbarProps = {
    item,
    state,
    wide,
    onBack: goBack,
    openOriginal,
    toggle,
    set,
    markDone,
    share,
  } as const;

  return (
    <article className="reader">
      <ReaderToolbar
        placement="top"
        {...toolbarProps}
        menuOpen={menuOpen}
        onOpenMenu={openMenu}
      />
      <ItemRowMenu
        open={menuOpen}
        title={item.title}
        items={menuItems}
        anchorEl={menuAnchor}
        onClose={closeMenu}
      />

      <header className="reader__header">
        <Link to={`/feed/${feed.id}`} className="reader__source">
          {source}
        </Link>
        <h1 className="reader__title">
          {isSafeHttpUrl(item.url) ? (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => set('opened', true)}
            >
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </h1>
        <div className="reader__byline">
          {item.author ? `${item.author} · ` : ''}
          {formatAge(item.publishedAt)}
        </div>
      </header>

      <div className="reader__modebar">
        {fetchingFull ? (
          <span className="reader__mode-note" data-testid="fulltext-loading">
            Loading full article…
          </span>
        ) : keepReading ? (
          <button
            type="button"
            className="reader__mode-toggle"
            data-testid="reader-keep-reading"
            onClick={() => setUserView('full')}
          >
            {truncated ? 'Keep reading' : 'Show reading view'}
          </button>
        ) : showReading && item.contentHtml ? (
          <button
            type="button"
            className="reader__mode-toggle"
            data-testid="reader-view-toggle"
            onClick={() => setUserView('feed')}
          >
            Show feed version
          </button>
        ) : fullFailed ? (
          <>
            <span className="reader__mode-note" data-testid="fulltext-error">
              {fetched?.status === 'auth'
                ? 'This article needs you to sign in — open the original.'
                : fetched?.status === 'empty'
                  ? 'No readable version found — showing the feed version.'
                  : 'Couldn’t load the full article — showing the feed version.'}
            </span>
            {fetched?.status === 'unreachable' ? (
              <button
                type="button"
                className="reader__mode-toggle"
                data-testid="fulltext-retry"
                onClick={() => void fullQuery.refetch()}
              >
                Try again
              </button>
            ) : null}
          </>
        ) : canGetFull ? (
          <button
            type="button"
            className="reader__mode-toggle"
            data-testid="fulltext-get"
            onClick={() => {
              setManualTrigger(true);
              setUserView('full');
            }}
          >
            Get full article
          </button>
        ) : null}
      </div>

      {bodyHtml ? (
        <div
          className="reader__body"
          // Content is sanitized server-side before storage (the feed body by the
          // poller, the full-article body by the fulltext function; SPEC.md *Feed
          // fetching & parsing* / *Full-text reading mode*). The mock seed is
          // trusted local HTML.
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      ) : fetchingFull ? null : (
        <div className="reader__state">
          <p>No content — open the original.</p>
        </div>
      )}

      <ReaderToolbar
        placement="bottom"
        {...toolbarProps}
        menuOpen={menuOpen}
        onOpenMenu={openMenu}
      />
    </article>
  );
}
