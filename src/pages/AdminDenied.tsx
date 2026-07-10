import { Link } from 'react-router-dom';
import './AdminPage.css';

/** The not-authorized state every admin page renders when the `admin`
 * capability is absent — same copy and layout everywhere, parameterized only
 * by the page heading. (The capability check itself stays in each page; the
 * server independently re-checks admin on every RPC.) */
export function AdminDenied({ title }: { title: string }) {
  return (
    <div className="admin">
      <div className="page-header">
        <h1 className="page-header__title">{title}</h1>
      </div>
      <p className="admin__denied">You don’t have access to this page.</p>
      <p className="admin__back">
        <Link to="/">&larr; Back to Home</Link>
      </p>
    </div>
  );
}
