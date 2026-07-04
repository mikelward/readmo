import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useCapabilities } from '../hooks/useCapabilities';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import './AdminPage.css';

/** Admin drill-down: the feeds a given account subscribes to. Reached from the
 * `/admin/users` row menu's **Feeds** item. Admin-gated (the server re-checks on
 * the RPC); the menu link is only offered when `canViewSubscriptions` confirms
 * the 0047 RPC is deployed, so a direct hit on an older backend is the only way
 * to reach the error state. */
export function AdminUserFeedsPage() {
  const { email = '' } = useParams();
  useDocumentTitle(`${email} · Feeds · Readmo`);
  const ds = useDataSource();
  const { admin } = useCapabilities();

  const {
    data: feeds = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['admin-user-feeds', email],
    queryFn: () => ds.listUserFeeds(email),
    enabled: admin && email.length > 0,
  });

  if (!admin) {
    return (
      <div className="admin">
        <div className="page-header">
          <h1 className="page-header__title">Feeds</h1>
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
        <h1 className="page-header__title">Feeds</h1>
      </div>

      <section className="settings__section">
        <h2 className="settings__heading">{email}</h2>
        {isLoading ? (
          <p className="admin__empty">Loading…</p>
        ) : isError ? (
          <p className="admin__empty">
            Couldn’t load this user’s feeds.{' '}
            <button
              type="button"
              className="admin__retry"
              onClick={() => void refetch()}
            >
              Retry
            </button>
          </p>
        ) : feeds.length === 0 ? (
          <p className="admin__empty">This user has no subscriptions.</p>
        ) : (
          <ul className="admin__list">
            {feeds.map((feed) => (
              <li key={feed.feedId} className="admin__row">
                <span className="admin__email">
                  {feed.title}
                  {feed.folder ? (
                    <span className="admin__tag">{feed.folder}</span>
                  ) : null}
                  {feed.muted ? (
                    <span className="admin__tag">Muted</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="admin__back">
        <Link to="/admin/users">&larr; Back to Users</Link>
      </p>
    </div>
  );
}
