import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useCapabilities } from '../hooks/useCapabilities';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { usePointerDevice } from '../hooks/usePointerDevice';
import { ItemRowMenu, type ItemRowMenuItem } from '../components/ItemRowMenu';
import { faviconNeedsDarkInvert } from '../lib/faviconInvert';
import {
  feedHealth,
  isUnhealthy,
  FEED_HEALTH_LABEL,
  type FeedHealth,
} from '../lib/feedHealth';
import type { AdminFeedStatus } from '../lib/data/DataSource';
import type { FeedId } from '../lib/types';
import './AdminPage.css';
import './AdminFeedsPage.css';

const FEEDS_KEY = ['admin-feeds'] as const;

type Filter = 'all' | 'unhealthy';

/** Operator-only feed-status console (`/admin/feeds`): one row per system feed
 * with a single derived status and, for the article most recently pinned by an
 * allowlisted user, the last reading-mode download outcome and the server's
 * response (HTTP code / reason). Gated on the `admin` capability; the backing
 * `admin_list_feeds` RPC re-checks `is_admin()` server-side. */
export function AdminFeedsPage() {
  useDocumentTitle('Feed status · Readmo');
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { admin } = useCapabilities();
  // Pointer devices get the anchored popover; touch gets the bottom sheet.
  const pointerDevice = usePointerDevice();
  const [filter, setFilter] = useState<Filter>('all');
  // Which feed's overflow (⋯) menu is open, and the element it anchors to.
  const [menuFor, setMenuFor] = useState<FeedId | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const closeMenu = () => {
    setMenuFor(null);
    setMenuAnchor(null);
  };

  const {
    data: feeds = [],
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: FEEDS_KEY,
    queryFn: () => ds.listFeedStatuses(),
    enabled: admin,
  });

  // Per-feed "Refresh" — force an immediate server-side poll of one feed, then
  // re-read so its status reflects the result. Server-debounced (60s), so a
  // just-fetched feed no-ops rather than erroring.
  const refreshFeed = useMutation({
    mutationFn: (feedId: FeedId) => ds.refresh(feedId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FEEDS_KEY });
      showToast({ message: 'Feed refresh requested.' });
    },
    onError: (err) =>
      showToast({ message: 'Couldn’t refresh that feed.', detail: String(err) }),
  });

  // Per-feed Delete — a system-wide hard delete (the feed, its items, and every
  // user's subscription to it). Confirm-gated in the menu; the server re-checks
  // is_admin().
  const deleteFeed = useMutation({
    mutationFn: (feedId: FeedId) => ds.deleteFeed(feedId),
    onSuccess: (_data, feedId) => {
      // The feed, its items, and the caller's subscription are all gone. An admin
      // who was subscribed to (or had loaded) it must not keep seeing the deleted
      // subscription/articles from cache until the 5-min stale window. Invalidate
      // the same reader buckets unsubscribe does — subscriptions/folders/feed —
      // plus the item-bearing buckets (library/search/offline/item + feed-meta),
      // since a delete removes items too (mirrors the rename handler's sweep).
      for (const queryKey of [
        FEEDS_KEY,
        ['subscriptions'],
        ['folders'],
        ['feed'],
        ['feed-meta', feedId],
        ['library'],
        ['search'],
        ['offline'],
        ['item'],
      ] as const) {
        void queryClient.invalidateQueries({ queryKey });
      }
      showToast({ message: 'Feed deleted.' });
    },
    onError: (err) =>
      showToast({ message: 'Couldn’t delete that feed.', detail: String(err) }),
  });

  // Derive each feed's status once, then filter. Sorting worst-first surfaces
  // problems at the top; healthy feeds sink to the bottom.
  const rows = useMemo(() => {
    const withHealth = feeds.map((feed) => ({ feed, health: feedHealth(feed) }));
    // Worst-first: hard failures on top, informational states below, healthy
    // downloads last.
    const order: Record<FeedHealth, number> = {
      'poll-failed': 0,
      blocked: 1,
      unreachable: 2,
      empty: 3,
      'not-tried': 4,
      downloaded: 5,
    };
    withHealth.sort((a, b) => order[a.health] - order[b.health]);
    return filter === 'unhealthy'
      ? withHealth.filter((r) => isUnhealthy(r.health))
      : withHealth;
  }, [feeds, filter]);

  const unhealthyCount = useMemo(
    () => feeds.filter((f) => isUnhealthy(feedHealth(f))).length,
    [feeds],
  );

  // The feed whose overflow menu is open, and its actions. "Refresh" is the
  // first (only, for now) entry — a per-feed server-side poll.
  const menuFeed = menuFor ? feeds.find((f) => f.id === menuFor) ?? null : null;
  const menuItems: ItemRowMenuItem[] = menuFeed
    ? [
        {
          key: 'refresh',
          label: 'Refresh',
          onSelect: () => refreshFeed.mutate(menuFeed.id),
        },
        {
          key: 'delete',
          label: 'Delete…',
          onSelect: () => {
            if (
              window.confirm(
                `Delete “${menuFeed.title}”? This removes the feed and all its ` +
                  `stored articles for everyone, and unsubscribes every user. ` +
                  `This can’t be undone.`,
              )
            ) {
              deleteFeed.mutate(menuFeed.id);
            }
          },
        },
      ]
    : [];

  if (!admin) {
    return (
      <div className="admin">
        <div className="page-header">
          <h1 className="page-header__title">Feed status</h1>
        </div>
        <p className="admin__denied">You don’t have access to this page.</p>
        <p className="admin__back">
          <Link to="/">&larr; Back to Home</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="admin">
      <div className="page-header">
        <h1 className="page-header__title">Feed status</h1>
      </div>

      <section className="settings__section" data-testid="admin-feeds">
        <div className="admin-feeds__controls">
          {/* Filter: all feeds, or only those that aren't healthy. */}
          <div
            className="admin-feeds__filter"
            role="group"
            aria-label="Filter feeds"
          >
            <button
              type="button"
              className={
                'admin-feeds__filter-btn' +
                (filter === 'all' ? ' admin-feeds__filter-btn--on' : '')
              }
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              All{feeds.length > 0 ? ` (${feeds.length})` : ''}
            </button>
            <button
              type="button"
              className={
                'admin-feeds__filter-btn' +
                (filter === 'unhealthy' ? ' admin-feeds__filter-btn--on' : '')
              }
              aria-pressed={filter === 'unhealthy'}
              onClick={() => setFilter('unhealthy')}
            >
              Unhealthy{unhealthyCount > 0 ? ` (${unhealthyCount})` : ''}
            </button>
          </div>
          {/* Re-reads the status list (distinct from a per-feed Refresh, which
              triggers an actual server-side poll). */}
          <button
            type="button"
            className="admin__retry admin-feeds__reload"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? 'Reloading…' : 'Reload'}
          </button>
        </div>

        {isLoading ? (
          <p className="admin__empty">Loading…</p>
        ) : isError ? (
          <p className="admin__empty">
            Couldn’t load feed status.{' '}
            <button
              type="button"
              className="admin__retry"
              onClick={() => void refetch()}
            >
              Retry
            </button>
          </p>
        ) : feeds.length === 0 ? (
          <p className="admin__empty">No feeds yet.</p>
        ) : rows.length === 0 ? (
          <p className="admin__empty">No unhealthy feeds — everything looks good.</p>
        ) : (
          <ul className="admin__list">
            {rows.map(({ feed, health }) => (
              <FeedStatusRow
                key={feed.id}
                feed={feed}
                health={health}
                menuOpen={menuFor === feed.id}
                busy={refreshFeed.isPending || deleteFeed.isPending}
                onOpenMenu={(anchor) => {
                  if (menuFor === feed.id) {
                    closeMenu();
                  } else {
                    // Anchor only on pointer devices → touch falls back to the
                    // 44px bottom sheet.
                    setMenuAnchor(pointerDevice ? anchor : null);
                    setMenuFor(feed.id);
                  }
                }}
              />
            ))}
          </ul>
        )}
        <ItemRowMenu
          open={menuFor !== null}
          title={menuFeed?.title ?? ''}
          items={menuItems}
          anchorEl={menuAnchor}
          onClose={closeMenu}
        />
      </section>

      <p className="admin__back">
        <Link to="/admin">&larr; Back to Admin</Link>
      </p>
    </div>
  );
}

function FeedStatusRow({
  feed,
  health,
  menuOpen,
  busy,
  onOpenMenu,
}: {
  feed: AdminFeedStatus;
  health: FeedHealth;
  menuOpen: boolean;
  busy: boolean;
  onOpenMenu: (anchor: HTMLElement) => void;
}) {
  return (
    <li className="admin__row admin-feeds__row">
      <div className="admin-feeds__main">
        {feed.faviconUrl ? (
          <img
            className={
              'admin-feeds__favicon' +
              (faviconNeedsDarkInvert(feed.faviconUrl) ? ' favicon--invert-dark' : '')
            }
            src={feed.faviconUrl}
            alt=""
            aria-hidden="true"
            width={16}
            height={16}
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
        ) : null}
        <div className="admin-feeds__text">
          <span className="admin-feeds__title">{feed.title}</span>
          {feed.sample?.title ? (
            <span className="admin-feeds__article">{feed.sample.title}</span>
          ) : null}
          <span className="admin-feeds__detail">{detailFor(feed, health)}</span>
        </div>
      </div>
      <span
        className={`admin-feeds__status admin-feeds__status--${health}`}
        data-testid={`feed-status-${feed.id}`}
      >
        {FEED_HEALTH_LABEL[health]}
      </span>
      {/* One row action — an overflow menu (⋯) — keeps the row at a single tap
          zone (guardrail #2). */}
      <button
        type="button"
        className="admin__manage admin-feeds__menu-btn"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Actions for ${feed.title}`}
        disabled={busy}
        onClick={(e) => onOpenMenu(e.currentTarget)}
      >
        ⋮
      </button>
    </li>
  );
}

/** The muted second line under a feed's title — the server response / reason
 * behind its status. */
function detailFor(feed: AdminFeedStatus, health: FeedHealth): string {
  const sample = feed.sample;
  const http = sample?.downloadHttpStatus;
  const err = sample?.downloadError;
  const rule = sample?.downloadRobotsRule;
  switch (health) {
    case 'poll-failed':
      return feed.lastError
        ? `Last poll failed: ${feed.lastError}`
        : 'Last poll failed';
    case 'not-tried':
      return 'No reading-mode download attempted yet';
    case 'downloaded':
      return 'Full article downloaded';
    case 'blocked':
      return http
        ? `Publisher blocked the fetch (HTTP ${http})`
        : 'Publisher blocked the fetch';
    case 'unreachable':
      return err
        ? `Fetch failed: ${err}`
        : http
          ? `Fetch failed (HTTP ${http})`
          : 'Fetch failed';
    case 'empty':
      // A robots.txt block records the reason + the matching directive.
      if (rule) return `${err ?? 'Disallowed by robots.txt'} — ${rule}`;
      return err ?? 'Fetched, but no article body found';
  }
}
