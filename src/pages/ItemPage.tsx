import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useIsRestoring, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { findCachedFeedItem } from '../lib/offlineItem';
import { collapseProxiedSrcset } from '../lib/extractProxiedImageUrls';
import { useItemState } from '../hooks/useItemState';
import { useWideViewport } from '../hooks/useWideViewport';
import { useShareItem } from '../hooks/useShareItem';
import { useConnectivityStatus } from '../hooks/useOnlineStatus';
import { useFullTextAllowed } from '../hooks/useCapabilities';
import {
  articleSourceDomain,
  formatAge,
  formatDisplayDomain,
  isSafeHttpUrl,
} from '../lib/itemMeta';
import { fullTextStaleTime, looksTruncated } from '../lib/fullText';
import type { FullTextResult } from '../lib/fullText';
import type { Item, ItemState, ItemStateField } from '../lib/types';
import { ArticleSummary } from '../components/ArticleSummary';
import { TooltipButton } from '../components/TooltipButton';
import { ItemRowMenu, type ItemRowMenuItem } from '../components/ItemRowMenu';
import { LoadError } from '../components/LoadError';
import { loadFailureCopy } from '../lib/loadErrorCopy';
import {
  ArrowBack,
  Check,
  Comment,
  FavoriteFilled,
  FavoriteOutline,
  MoreVert,
  OpenInNew,
  PushPinFilled,
  PushPinOutline,
  Share as ShareIcon,
  VerticalAlignTop,
} from '../components/icons';
import {
  NEWSHACKER_ORIGIN,
  isHackerNewsFeed,
  newshackerUrlForCommentsUrl,
  newshackerUrlForItem,
} from '../lib/newshacker';
import './ItemPage.css';

/** True when a cached `['fulltext', id]` result already holds a usable reading
 * body (a terminal `ok` with HTML) — i.e. the full article is available without
 * a fresh fetch, so the reader can open straight into the reading view. */
function cachedFullTextOk(ft: FullTextResult | undefined): boolean {
  return ft?.status === 'ok' && !!ft.contentHtml;
}

/** Whether a URL is on newshacker's own origin. Compares the parsed origin, not
 * a string prefix: a publisher-controlled `commentsUrl` like
 * `https://newshacker.app.evil.example/x` or `https://newshacker.app@evil/x`
 * starts with NEWSHACKER_ORIGIN but resolves to a lookalike host, which must NOT
 * be labeled "Comments on newshacker" (PR #264 review). */
function isNewshackerUrl(url: string): boolean {
  try {
    return new URL(url).origin === NEWSHACKER_ORIGIN;
  } catch {
    return false;
  }
}

interface ReaderToolbarProps {
  /** Where the bar sits. The bottom copy suffixes its test ids so the two
   * toolbars don't collide. */
  placement: 'top' | 'bottom';
  item: Item;
  state: ItemState;
  /** The feed name shown next to the leading button, linking back to the feed
   * — a persistent "which feed is this?" anchor while reading (the top bar is
   * sticky). This is the only place the feed name appears; the header shows
   * just the title + meta line. */
  source: string;
  feedId: string;
  wide: boolean;
  onBack: () => void;
  openOriginal: () => void;
  /** The article's comments/discussion destination, or null when it has none —
   * a Hacker News item's newshacker thread, else the feed's structured comments
   * URL. Null hides the Comments button. */
  commentsHref: string | null;
  /** Whether `commentsHref` points at newshacker (an HN item), so the button can
   * name the destination ("Comments on newshacker"). */
  commentsOnNewshacker: boolean;
  openComments: () => void;
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
  source,
  feedId,
  wide,
  onBack,
  openOriginal,
  commentsHref,
  commentsOnNewshacker,
  openComments,
  toggle,
  set,
  markDone,
  share,
  menuOpen,
  onOpenMenu,
}: ReaderToolbarProps) {
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const sfx = placement === 'bottom' ? '-bottom' : '';
  // The narrow bar can't hold a fifth 44px action without breaking the ≥320px
  // single-row invariant (SPEC *Reader action bar*). When the conditional
  // Comments button is present on a narrow viewport, Pin moves into the ⋮
  // overflow menu (see ItemPage's menuItems) so Comments stays inline; with no
  // Comments button, or on a wide viewport, Pin stays inline as before.
  const pinInline = wide || !commentsHref;

  return (
    <div className={`reader__${placement}bar`}>
      {placement === 'bottom' ? (
        <TooltipButton
          type="button"
          className="reader__back"
          tooltip="Back to top"
          aria-label="Back to top"
          data-testid="reader-back-to-top"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <VerticalAlignTop />
        </TooltipButton>
      ) : (
        <TooltipButton
          type="button"
          className="reader__back"
          tooltip="Back"
          aria-label="Back"
          onClick={onBack}
        >
          <ArrowBack />
        </TooltipButton>
      )}

      <Link
        to={`/feed/${feedId}`}
        className="reader__feedname"
        data-testid={`reader-feedname${sfx}`}
      >
        <span className="reader__feedname-text">{source}</span>
      </Link>

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
        </TooltipButton>

        {commentsHref ? (
          <TooltipButton
            type="button"
            className="reader__action"
            tooltip={commentsOnNewshacker ? 'Comments on newshacker' : 'Comments'}
            aria-label={commentsOnNewshacker ? 'Comments on newshacker' : 'Comments'}
            onClick={openComments}
            data-testid={`reader-comments${sfx}`}
          >
            <Comment />
          </TooltipButton>
        ) : null}

        {wide ? (
          <>
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
          </>
        ) : null}

        {pinInline ? (
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
        ) : null}

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

  const { data, isLoading, error, refetch } = useQuery({
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

  // Instant body from cache: paint *something* the moment the reader opens
  // instead of a blank "Loading…". Recover this item's feed body from a list
  // page already in the query cache (Home/folder/feed/library all carry
  // `content_html`). One path covers two cases that both leave `data ===
  // undefined`: the normal online open — the per-item `getItem` is still in
  // flight, so show the feed body now and let the refetch settle in the
  // background — and the offline/errored open, where the fetch can't resolve at
  // all. The extracted reading view isn't in any list payload, so a pinned item
  // layers it on top via the `['fulltext', id]` cache below (`fullReadyAtOpen`).
  // See `lib/offlineItem`.
  //
  // Keyed on `data === undefined`, NOT `!data`: once `getItem` resolves to `null`
  // (a *successful* miss — the server says the item isn't visible, e.g. after
  // unsubscribing, RLS hides it) that null is authoritative and must override any
  // cached row, even offline. So `resolved` prefers `data` whenever the query has
  // settled (null included) and only falls back to the cached body while the read
  // is still unresolved.
  //
  // `isRestoring` gates the scan: the list caches it walks are still hydrating at
  // boot, so wait for restoration (its flip to false re-renders and re-runs this).
  const fallback = useMemo(
    () =>
      data === undefined && !isRestoring ? findCachedFeedItem(queryClient, id) : null,
    [data, isRestoring, queryClient, id],
  );
  const resolved = data === undefined ? fallback : data;

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
  // this session waits behind "Read more" (so the reader doesn't reflow). The
  // lazy init reads the cache synchronously to avoid a one-frame feed flash.
  const [fullReadyAtOpen, setFullReadyAtOpen] = useState(() =>
    cachedFullTextOk(queryClient.getQueryData<FullTextResult>(['fulltext', id])),
  );

  const cachedFull = resolved?.item.fullContentHtml ?? null;
  const truncated = resolved ? looksTruncated(resolved.item) : false;
  // Reading mode is allowlist-gated: when the allowlist is armed and this user
  // isn't on it, don't call the (gated) fulltext function at all — they'd only
  // get the silent feed-stub fallback, and skipping the call avoids the
  // off-list request amplification (see useOfflineCacheLock). The server still
  // enforces the gate; this is purely the client not asking.
  const allowFull = useFullTextAllowed();
  const wantFull =
    !!resolved && !cachedFull && online && allowFull && (truncated || manualTrigger);

  const fullQuery = useQuery({
    queryKey: ['fulltext', id],
    queryFn: () => ds.fetchFullText(id),
    enabled: wantFull,
    // Terminal outcomes (ok/empty/auth) are cached forever; a transient
    // `unreachable` stays stale so reopening (or the in-view "Try again")
    // retries it. Shared with the pin-time prefetch (useFullTextPrefetch).
    staleTime: fullTextStaleTime,
  });

  // Lifted above menuItems so the overflow menu can offer "Show feed version"
  // whenever we're sitting in the reading view and a feed body exists to swap
  // back to. The mode bar used to carry this toggle; it's now menu-only.
  // Reading-mode access gate: when the caller may NOT use full text (armed
  // allowlist, off-list), ignore any full body — including one already cached
  // (a `['fulltext', id]` result from before the allowlist was armed, or before
  // they were removed) — so they're limited to the feed version. `enabled: false`
  // only stops *fetching*; React Query still hands back cached data, so the gate
  // has to drop it here, not just at the query. (We ignore, not evict, so the
  // body is instantly available again if membership flips back to family.)
  const fetched = allowFull ? fullQuery.data : undefined;
  const fullHtml = allowFull
    ? (cachedFull ?? (fetched?.status === 'ok' ? fetched.contentHtml : null))
    : null;
  // Whether the full body on show came from the bot-block fallback fetch, so the
  // reader can flag its provenance ("via fallback") next to the source. Only the
  // fetched body carries this — a `cachedFull` body read off the item has no
  // provenance client-side (the gated columns aren't read there anyway), so it's
  // treated as a direct fetch.
  const fullViaFallback =
    !cachedFull && fetched?.status === 'ok' && fetched.viaFallback === true;
  const defaultView: 'feed' | 'full' =
    allowFull && (cachedFull || fullReadyAtOpen) ? 'full' : 'feed';
  const view = userView ?? defaultView;
  const showReading = view === 'full' && !!fullHtml;

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

  // Go up one level in the content hierarchy: an RSS article's parent is the
  // feed it came from, so `u` jumps to this item's feed page. (newshacker's `u`
  // goes to the parent comment; RSS items have no comment tree, so the feed is
  // the analog — same "Open feed" target the overflow menu offers.) No-op until
  // the item resolves, since the feed id comes from it.
  const goUp = useCallback(() => {
    if (resolved) navigate(`/feed/${resolved.feed.id}`);
  }, [resolved, navigate]);

  // The article's comments/discussion destination. Null hides the button.
  //
  // Hacker News feeds open the newshacker thread (not news.ycombinator.com),
  // deriving the HN id from the item's url/guid/body — same as the row's "open
  // on newshacker" mode, and the only way to find the official HN feed's
  // discussion link (it lives in the description, not a structured field; it
  // also covers a pre-0033 backend that omits comments_url). That broad scan is
  // GATED to HN feeds: on a normal feed a body that merely mentions an HN thread
  // would otherwise mislabel/redirect the button (PR #264 review).
  //
  // Every other feed uses its structured comments URL (RSS <comments> / Atom
  // rel="replies"); if that link itself points at an HN thread it's still routed
  // to newshacker ("if it links to Hacker News, go to newshacker instead").
  const commentsHref = useMemo(() => {
    if (!resolved) return null;
    const { item: it, feed } = resolved;
    if (isHackerNewsFeed(feed)) {
      return (
        newshackerUrlForItem(it) ??
        (isSafeHttpUrl(it.commentsUrl) ? it.commentsUrl : null)
      );
    }
    if (!isSafeHttpUrl(it.commentsUrl)) return null;
    return newshackerUrlForCommentsUrl(it.commentsUrl) ?? it.commentsUrl;
  }, [resolved]);
  const commentsOnNewshacker =
    commentsHref != null && isNewshackerUrl(commentsHref);
  const openComments = useCallback(() => {
    if (commentsHref) window.open(commentsHref, '_blank', 'noopener,noreferrer');
  }, [commentsHref]);

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
  // 960px they stay here. Pin joins them in the menu only when it's been
  // pushed off the narrow bar to make room for the Comments button (see
  // `pinInline` in ReaderToolbar). Open feed is always in the menu. "Show feed
  // version" appears only when the reader is sitting in the extracted
  // reading view AND a feed body exists to swap back to.
  const pinInMenu = !wide && !!commentsHref;
  const menuItems = useMemo<ItemRowMenuItem[]>(() => {
    if (!resolved) return [];
    const it = resolved.item;
    const items: ItemRowMenuItem[] = [];
    if (pinInMenu) {
      items.push({
        key: 'pin',
        label: state.pinned ? 'Unpin' : 'Pin',
        onSelect: () => toggle('pinned'),
      });
    }
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
    if (showReading && it.contentHtml) {
      items.push({
        key: 'show-feed-version',
        label: 'Show feed version',
        onSelect: () => setUserView('feed'),
      });
    }
    items.push({
      key: 'open-feed',
      label: 'Open feed',
      onSelect: () => navigate(`/feed/${resolved.feed.id}`),
    });
    return items;
  }, [
    resolved,
    wide,
    pinInMenu,
    state.favorite,
    state.pinned,
    toggle,
    share,
    navigate,
    showReading,
  ]);

  // Reader keyboard shortcuts: o open original, c comments, p pin, f favorite,
  // d done, u up to the feed, b back.
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
        case 'c':
          openComments();
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
        case 'u':
          goUp();
          break;
        case 'b':
          goBack();
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openOriginal, openComments, toggle, markDone, goUp, goBack]);

  // Only show the blank "Loading…" when there's nothing cached to paint yet — a
  // cold first open, or while the persisted cache is still hydrating (the
  // fallback scan needs it). With a cached body in hand we render immediately
  // and let `getItem` refresh in the background, so there's no "Loading…" gap on
  // an item we already pulled into a list.
  if (isRestoring || (isLoading && !resolved)) {
    return (
      <div className="reader__state">
        <p>Loading…</p>
        <p className="reader__state-tip">
          Tip: <PushPinOutline className="reader__state-tip-icon" /> pin an
          article to make it load faster
        </p>
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
  // Article's publisher domain next to the feed name, for aggregator feeds
  // (Hacker News, Reddit) whose items link out elsewhere; same rule as the row.
  const domain = feed.title
    ? articleSourceDomain(item.url, feed.siteUrl ?? feed.url)
    : '';

  // Resolve the reading-mode body. The RSS body always shows first; the full
  // article (cached, or fetched in the background) is revealed only when the
  // user asks for it via "Read more" — except a body already cached full
  // (pinned/previously read) defaults straight to the reading view. `view` /
  // `showReading` / `fullHtml` are computed above so the overflow menu can
  // offer "Show feed version" while reading.
  // Collapse any stale responsive srcset to a single width before injecting it,
  // so the rendered <img> requests the SAME proxy URL the offline prefetch warms
  // (both use the ~1600px pick) — otherwise a pre-collapse row could render a
  // viewport-dependent candidate that isn't in the offline cache. A no-op for
  // newly-sanitized rows, which already carry a single src.
  const rawBodyHtml = showReading ? fullHtml : item.contentHtml;
  const bodyHtml =
    rawBodyHtml == null ? rawBodyHtml : collapseProxiedSrcset(rawBodyHtml);
  const fetchingFull = fullQuery.isFetching && !fullHtml;
  // Full article is fetched and ready, but we're still showing the feed body —
  // offer to reveal it (no auto-swap, so the reader doesn't reflow mid-read).
  const keepReading = !!fullHtml && !showReading;
  // A non-"ok" result (paywall/teaser/unreachable) — only worth surfacing once
  // we have nothing better than the feed body to show.
  const fullFailed = !fullHtml && fetched != null && fetched.status !== 'ok';
  const canGetFull = !fullHtml && !fetchingFull && !wantFull && online && allowFull;

  const toolbarProps = {
    item,
    state,
    source,
    feedId: feed.id,
    wide,
    onBack: goBack,
    openOriginal,
    commentsHref,
    commentsOnNewshacker,
    openComments,
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
        {/* Meta line below the title. The feed name now lives only on the
            reader bars (next to Back), so this carries author · age, plus the
            article's publisher domain for aggregator feeds whose items link
            out (Hacker News, Reddit) and the "via fallback" reading-body
            provenance tag. */}
        <div className="reader__byline">
          {item.author ? `${item.author} · ` : ''}
          {formatAge(item.publishedAt)}
          {domain ? (
            <span className="reader__domain" data-testid="reader-domain">
              {' · '}
              {domain}
            </span>
          ) : null}
          {showReading && fullViaFallback ? (
            <span className="reader__via-fallback" data-testid="reader-via-fallback">
              {' · '}
              via fallback
            </span>
          ) : null}
        </div>
      </header>

      {/* AI summary — directly after the title/byline, above the article. Shows
          for any article an allowlisted user opens (generated here on open if
          useSummaryPrewarm hasn't already warmed it — e.g. from a pin). The
          gating lives in useSummary, so it's always mounted to keep hook order
          stable and renders nothing when there's nothing to show. */}
      <ArticleSummary id={item.id} online={online} />

      <div className="reader__modebar">
        {fetchingFull ? (
          <>
            {isSafeHttpUrl(item.url) ? (
              <button
                type="button"
                className="reader__mode-toggle"
                data-testid="fulltext-open-original"
                onClick={openOriginal}
              >
                Open original
              </button>
            ) : null}
            <span className="reader__mode-note" data-testid="fulltext-loading">
              Loading full article…
            </span>
          </>
        ) : keepReading ? (
          <button
            type="button"
            className="reader__mode-toggle"
            data-testid="reader-keep-reading"
            onClick={() => setUserView('full')}
          >
            {truncated ? 'Read more' : 'Show reading view'}
          </button>
        ) : fullFailed ? (
          <>
            {/* `empty` isn't worth alarming over: the extractor found nothing
                richer than the feed body already on screen. That covers both a
                link aggregator like Reddit whose entry already *is* the whole
                story and a paywall/teaser the backend couldn't expand — and
                because a short complete entry and a short teaser are
                indistinguishable by length, we don't try to tell them apart.
                Either way the feed body stays and the Open-original button below
                is the escape hatch to the source. (A reading-mode allowlist
                denial is reported as a `retryable` empty, so it's silent here
                for the same reason.) `auth`/`unreachable` are real misses that
                need explaining, so they keep their note. */}
            {fetched?.status === 'auth' ? (
              <span className="reader__mode-note" data-testid="fulltext-error">
                This article needs you to sign in — open the original.
              </span>
            ) : fetched?.status === 'empty' ? null : (
              <span className="reader__mode-note" data-testid="fulltext-error">
                Couldn’t load the full article — showing the feed version.
              </span>
            )}
            {isSafeHttpUrl(item.url) ? (
              <button
                type="button"
                className="reader__mode-toggle"
                data-testid="fulltext-open-original"
                onClick={openOriginal}
              >
                Open original
              </button>
            ) : null}
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
