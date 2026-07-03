import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useCapabilities } from '../hooks/useCapabilities';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { faviconNeedsDarkInvert } from '../lib/faviconInvert';
import {
  feedHealth,
  isUnhealthy,
  FEED_HEALTH_LABEL,
  type FeedHealth,
} from '../lib/feedHealth';
import type { AdminFeedStatus } from '../lib/data/DataSource';
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
  const { admin } = useCapabilities();
  const [filter, setFilter] = useState<Filter>('all');

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
          <button
            type="button"
            className="admin__retry admin-feeds__reload"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? 'Refreshing…' : 'Refresh'}
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
              <FeedStatusRow key={feed.id} feed={feed} health={health} />
            ))}
          </ul>
        )}
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
}: {
  feed: AdminFeedStatus;
  health: FeedHealth;
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
