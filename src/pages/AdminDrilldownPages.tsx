import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useCapabilities } from '../hooks/useCapabilities';
import { usePageTitle } from '../hooks/useDocumentTitle';
import { AdminDenied } from './AdminDenied';
import './AdminPage.css';

interface AdminDrilldownProps<T> {
  title: string;
  /** Section heading under the page title (feed title / account email). */
  heading: string | null;
  queryKey: readonly unknown[];
  queryFn: () => Promise<T[]>;
  enabled: boolean;
  errorLabel: string;
  emptyLabel: string;
  rowKey: (row: T) => string;
  renderRow: (row: T) => ReactNode;
  backTo: string;
  backLabel: string;
}

/** Shared shell for the admin drill-down lists: admin guard, query, and the
 * loading / error-with-Retry / empty / list states. Admin-gated (the server
 * re-checks on the RPC); the row-menu links that reach these pages are only
 * offered when `canViewSubscriptions` confirms the 0047 RPC is deployed, so a
 * direct hit on an older backend is the only way to reach the error state. */
function AdminDrilldownPage<T>({
  title,
  heading,
  queryKey,
  queryFn,
  enabled,
  errorLabel,
  emptyLabel,
  rowKey,
  renderRow,
  backTo,
  backLabel,
}: AdminDrilldownProps<T>) {
  const { admin } = useCapabilities();

  const {
    data: rows = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({ queryKey, queryFn, enabled: admin && enabled });

  if (!admin) return <AdminDenied title={title} />;

  return (
    <div className="admin">
      <div className="page-header">
        <h1 className="page-header__title">{title}</h1>
      </div>

      <section className="settings__section">
        {heading ? <h2 className="settings__heading">{heading}</h2> : null}
        {isLoading ? (
          <p className="admin__empty">Loading…</p>
        ) : isError ? (
          <p className="admin__empty">
            {errorLabel}{' '}
            <button
              type="button"
              className="admin__retry"
              onClick={() => void refetch()}
            >
              Retry
            </button>
          </p>
        ) : rows.length === 0 ? (
          <p className="admin__empty">{emptyLabel}</p>
        ) : (
          <ul className="admin__list">
            {rows.map((row) => (
              <li key={rowKey(row)} className="admin__row">
                <span className="admin__email">{renderRow(row)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="admin__back">
        <Link to={backTo}>&larr; Back to {backLabel}</Link>
      </p>
    </div>
  );
}

/** Admin drill-down: the accounts subscribed to a given feed. Reached from the
 * `/admin/feeds` row menu's **Users** item. The feed's title rides in on
 * router state from the link (nice heading), falling back to a generic one on
 * a direct hit. */
export function AdminFeedUsersPage() {
  const { feedId = '' } = useParams();
  const location = useLocation();
  const feedTitle = (location.state as { feedTitle?: string } | null)?.feedTitle;
  usePageTitle(`${feedTitle ?? 'Feed'} · Subscribers`);
  const ds = useDataSource();

  return (
    <AdminDrilldownPage
      title="Subscribers"
      heading={feedTitle ?? null}
      queryKey={['admin-feed-subscribers', feedId]}
      queryFn={() => ds.listFeedSubscribers(feedId)}
      enabled={feedId.length > 0}
      errorLabel="Couldn’t load this feed’s subscribers."
      emptyLabel="No one is subscribed to this feed."
      rowKey={(sub) => sub.email}
      renderRow={(sub) => (
        <>
          {sub.email}
          {sub.family ? (
            <span className="admin__tag admin__tag--family">Family</span>
          ) : null}
          {sub.blocked ? (
            <span className="admin__tag admin__tag--blocked">Blocked</span>
          ) : null}
          {sub.muted ? <span className="admin__tag">Muted</span> : null}
        </>
      )}
      backTo="/admin/feeds"
      backLabel="Feeds"
    />
  );
}

/** Admin drill-down: the feeds a given account subscribes to. Reached from the
 * `/admin/users` row menu's **Feeds** item. */
export function AdminUserFeedsPage() {
  const { email = '' } = useParams();
  usePageTitle(`${email} · Feeds`);
  const ds = useDataSource();

  return (
    <AdminDrilldownPage
      title="Feeds"
      heading={email}
      queryKey={['admin-user-feeds', email]}
      queryFn={() => ds.listUserFeeds(email)}
      enabled={email.length > 0}
      errorLabel="Couldn’t load this user’s feeds."
      emptyLabel="This user has no subscriptions."
      rowKey={(feed) => feed.feedId}
      renderRow={(feed) => (
        <>
          {feed.title}
          {feed.folder ? <span className="admin__tag">{feed.folder}</span> : null}
          {feed.muted ? <span className="admin__tag">Muted</span> : null}
        </>
      )}
      backTo="/admin/users"
      backLabel="Users"
    />
  );
}
