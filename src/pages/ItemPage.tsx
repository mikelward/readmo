import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useItemState } from '../hooks/useItemState';
import { useWideViewport } from '../hooks/useWideViewport';
import { useShareItem } from '../hooks/useShareItem';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { formatAge, formatDisplayDomain, isSafeHttpUrl } from '../lib/itemMeta';
import { looksTruncated } from '../lib/fullText';
import type { Feed, Item, ItemState, ItemStateField } from '../lib/types';
import { TooltipButton } from '../components/TooltipButton';
import {
  ArrowBack,
  CheckCircleFilled,
  CheckCircleOutline,
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

interface ReaderToolbarProps {
  /** Where the bar sits. The bottom copy suffixes its test ids so the two
   * toolbars don't collide. */
  placement: 'top' | 'bottom';
  item: Item;
  feed: Feed;
  state: ItemState;
  wide: boolean;
  onBack: () => void;
  openOriginal: () => void;
  toggle: (field: ItemStateField) => void;
  set: (field: ItemStateField, value: boolean) => void;
  markDone: () => void;
  share: (item: { title: string; url: string }) => void;
}

function ReaderToolbar({
  placement,
  item,
  feed,
  state,
  wide,
  onBack,
  openOriginal,
  toggle,
  set,
  markDone,
  share,
}: ReaderToolbarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
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
          {state.done ? <CheckCircleFilled /> : <CheckCircleOutline />}
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
            type="button"
            className="reader__action"
            tooltip="More"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((o) => !o)}
            data-testid={`reader-more${sfx}`}
          >
            <MoreVert />
          </TooltipButton>
          {moreOpen ? (
            <div
              className={
                'reader__more-menu' +
                (placement === 'bottom' ? ' reader__more-menu--up' : '')
              }
              role="menu"
              onMouseLeave={() => setMoreOpen(false)}
            >
              {!wide ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="reader__more-item"
                    onClick={() => {
                      setMoreOpen(false);
                      toggle('favorite');
                    }}
                  >
                    {state.favorite ? 'Unfavorite' : 'Favorite'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="reader__more-item"
                    onClick={() => {
                      setMoreOpen(false);
                      share({ title: item.title, url: item.url });
                    }}
                  >
                    Share
                  </button>
                </>
              ) : null}
              <Link
                to={`/feed/${feed.id}`}
                role="menuitem"
                className="reader__more-item"
                onClick={() => setMoreOpen(false)}
              >
                Open feed
              </Link>
            </div>
          ) : null}
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
  const online = useOnlineStatus();

  const { state, set, toggle } = useItemState(id);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['item', id],
    queryFn: () => ds.getItem(id),
  });

  // Reading mode: when the feed body looks truncated, fetch the full article
  // from its source (server-side extraction). `manualTrigger` lets the user
  // request it for a feed whose body looked complete; `showFeedVersion` flips
  // back to the feed's own body when both exist.
  //
  // TODO(offline): also warm full-text on PIN (pinned/favorited are the offline
  // buckets) and persist full_content_html into the device's offline cache so a
  // pinned-but-unopened truncated item saves the readable body, not just the
  // feed stub. And sync that readable body across the user's devices. Both are
  // part of the offline/sync milestone — see SPEC.md *Open questions*.
  const [manualTrigger, setManualTrigger] = useState(false);
  const [showFeedVersion, setShowFeedVersion] = useState(false);

  const cachedFull = data?.item.fullContentHtml ?? null;
  const truncated = data ? looksTruncated(data.item) : false;
  const wantFull = !!data && !cachedFull && online && (truncated || manualTrigger);

  const fullQuery = useQuery({
    queryKey: ['fulltext', id],
    queryFn: () => ds.fetchFullText(id),
    enabled: wantFull,
    // Terminal outcomes (ok/empty/auth) are cached forever — re-fetching won't
    // change them. A transient `unreachable` stays stale so reopening the reader
    // retries it (and the in-view "Try again" forces a refetch immediately);
    // otherwise a momentary network blip would wedge reading mode off forever.
    staleTime: (query) =>
      query.state.data && query.state.data.status !== 'unreachable' ? Infinity : 0,
  });

  // Opening the reader marks the item Opened (auto), and resets the per-article
  // reading-mode view state when navigating between items.
  useEffect(() => {
    if (data) set('opened', true);
    setManualTrigger(false);
    setShowFeedVersion(false);
    // Only when the item first resolves / changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.item.id]);

  const openOriginal = useCallback(() => {
    if (data && isSafeHttpUrl(data.item.url)) {
      set('opened', true);
      window.open(data.item.url, '_blank', 'noopener,noreferrer');
    }
  }, [data, set]);

  const markDone = useCallback(() => {
    set('done', true); // also clears pinned via the mutation shield
    navigate(-1);
  }, [set, navigate]);

  const goBack = useCallback(() => navigate(-1), [navigate]);

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

  if (isLoading) {
    return <div className="reader__state">Loading…</div>;
  }
  if (isError || !data) {
    return (
      <div className="reader__state">
        {online ? (
          <p>Couldn’t load this article.</p>
        ) : (
          <p>This article isn’t saved offline. Pin it while online to keep a copy.</p>
        )}
      </div>
    );
  }

  const { item, feed } = data;
  const source = feed.title || formatDisplayDomain(item.url);

  // Resolve the reading-mode body. Prefer the cached/fetched full article, but
  // let the user flip back to the feed's own body when both exist.
  const fetched = fullQuery.data;
  const fullHtml = cachedFull ?? (fetched?.status === 'ok' ? fetched.contentHtml : null);
  const showReading = !!fullHtml && !showFeedVersion;
  const bodyHtml = showReading ? fullHtml : item.contentHtml;
  const fetchingFull = fullQuery.isFetching && !fullHtml;
  // A non-"ok" result (paywall/teaser/unreachable) — only worth surfacing once
  // we have nothing better than the feed body to show.
  const fullFailed = !fullHtml && fetched != null && fetched.status !== 'ok';
  const canGetFull = !fullHtml && !fetchingFull && !wantFull && online;

  const toolbarProps = {
    item,
    feed,
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
      <ReaderToolbar placement="top" {...toolbarProps} />

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
        ) : fullHtml && item.contentHtml ? (
          <button
            type="button"
            className="reader__mode-toggle"
            data-testid="reader-view-toggle"
            onClick={() => setShowFeedVersion((v) => !v)}
          >
            {showReading ? 'Show feed version' : 'Show reading view'}
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
            onClick={() => setManualTrigger(true)}
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

      <ReaderToolbar placement="bottom" {...toolbarProps} />
    </article>
  );
}
