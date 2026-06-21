import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useItemState } from '../hooks/useItemState';
import { useWideViewport } from '../hooks/useWideViewport';
import { useShareItem } from '../hooks/useShareItem';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { formatAge, formatDisplayDomain, isSafeHttpUrl } from '../lib/itemMeta';
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
} from '../components/icons';
import './ItemPage.css';

export function ItemPage() {
  const { id = '' } = useParams();
  const ds = useDataSource();
  const navigate = useNavigate();
  const wide = useWideViewport();
  const share = useShareItem();
  const online = useOnlineStatus();

  const { state, set, toggle } = useItemState(id);
  const [moreOpen, setMoreOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['item', id],
    queryFn: () => ds.getItem(id),
  });

  // Opening the reader marks the item Opened (auto).
  useEffect(() => {
    if (data) set('opened', true);
    // Only when the item first resolves.
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

  const actionBar = (
    <div className="reader__actions" role="toolbar" aria-label="Article actions">
      <TooltipButton
        type="button"
        className="reader__action reader__action--primary"
        tooltip="Open original"
        aria-label="Open original article"
        onClick={openOriginal}
        data-testid="open-original"
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
        data-testid="reader-pin"
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
        data-testid="reader-done"
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
            data-testid="reader-favorite"
          >
            {state.favorite ? <FavoriteFilled /> : <FavoriteOutline />}
          </TooltipButton>
          <TooltipButton
            type="button"
            className="reader__action"
            tooltip="Share"
            aria-label="Share"
            onClick={() => share({ title: item.title, url: item.url })}
            data-testid="reader-share"
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
          data-testid="reader-more"
        >
          <MoreVert />
        </TooltipButton>
        {moreOpen ? (
          <div
            className="reader__more-menu"
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
  );

  return (
    <article className="reader">
      <div className="reader__topbar">
        <button
          type="button"
          className="reader__back"
          aria-label="Back"
          onClick={() => navigate(-1)}
        >
          <ArrowBack />
        </button>
        {actionBar}
      </div>

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

      {item.contentHtml ? (
        <div
          className="reader__body"
          // Content is sanitized server-side before storage (SPEC.md *Feed
          // fetching & parsing*); the mock seed is trusted local HTML.
          dangerouslySetInnerHTML={{ __html: item.contentHtml }}
        />
      ) : (
        <div className="reader__state">
          <p>No content — open the original.</p>
        </div>
      )}

      <div className="reader__bottombar">
        <button
          type="button"
          className="reader__action reader__action--primary"
          onClick={() => window.scrollTo({ top: 0 })}
        >
          Back to top
        </button>
      </div>
    </article>
  );
}
