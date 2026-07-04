import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useCapabilities } from '../hooks/useCapabilities';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import './AdminPage.css';

/** Admin drill-down: the accounts subscribed to a given feed. Reached from the
 * `/admin/feeds` row menu's **Users** item. Admin-gated (the server re-checks on
 * the RPC); the menu link is only offered when `canViewSubscriptions` confirms
 * the 0047 RPC is deployed. The feed's title rides in on router state from the
 * link (nice heading), falling back to a generic one on a direct hit. */
export function AdminFeedUsersPage() {
  const { feedId = '' } = useParams();
  const location = useLocation();
  const feedTitle = (location.state as { feedTitle?: string } | null)?.feedTitle;
  useDocumentTitle(`${feedTitle ?? 'Feed'} · Subscribers · Readmo`);
  const ds = useDataSource();
  const { admin } = useCapabilities();

  const {
    data: subscribers = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['admin-feed-subscribers', feedId],
    queryFn: () => ds.listFeedSubscribers(feedId),
    enabled: admin && feedId.length > 0,
  });

  if (!admin) {
    return (
      <div className="admin">
        <div className="page-header">
          <h1 className="page-header__title">Subscribers</h1>
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
        <h1 className="page-header__title">Subscribers</h1>
      </div>

      <section className="settings__section">
        {feedTitle ? <h2 className="settings__heading">{feedTitle}</h2> : null}
        {isLoading ? (
          <p className="admin__empty">Loading…</p>
        ) : isError ? (
          <p className="admin__empty">
            Couldn’t load this feed’s subscribers.{' '}
            <button
              type="button"
              className="admin__retry"
              onClick={() => void refetch()}
            >
              Retry
            </button>
          </p>
        ) : subscribers.length === 0 ? (
          <p className="admin__empty">No one is subscribed to this feed.</p>
        ) : (
          <ul className="admin__list">
            {subscribers.map((sub) => (
              <li key={sub.email} className="admin__row">
                <span className="admin__email">
                  {sub.email}
                  {sub.family ? (
                    <span className="admin__tag admin__tag--family">Family</span>
                  ) : null}
                  {sub.blocked ? (
                    <span className="admin__tag admin__tag--blocked">Blocked</span>
                  ) : null}
                  {sub.muted ? <span className="admin__tag">Muted</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="admin__back">
        <Link to="/admin/feeds">&larr; Back to Feeds</Link>
      </p>
    </div>
  );
}
