import { Link } from 'react-router-dom';
import { useCapabilities } from '../hooks/useCapabilities';
import { usePageTitle } from '../hooks/useDocumentTitle';
import { AdminDenied } from './AdminDenied';
import './AdminPage.css';

/** Operator console hub. Gated on the `admin` capability; it only links to the
 * management sub-pages (Users, Feeds), each of which re-checks admin and is
 * enforced server-side by its RPCs. */
export function AdminPage() {
  usePageTitle('Admin');
  const { admin } = useCapabilities();

  if (!admin) return <AdminDenied title="Admin" />;

  return (
    <div className="admin">
      <div className="page-header">
        <h1 className="page-header__title">Admin</h1>
      </div>

      <section className="settings__section">
        <h2 className="settings__heading">Users</h2>
        <div className="settings__actions">
          <Link className="settings__btn" to="/admin/users">
            Manage users
          </Link>
        </div>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Feeds</h2>
        <div className="settings__actions">
          <Link className="settings__btn" to="/admin/feeds">
            Manage feeds
          </Link>
        </div>
      </section>

      <p className="admin__back">
        <Link to="/">&larr; Back to Home</Link>
      </p>
    </div>
  );
}
