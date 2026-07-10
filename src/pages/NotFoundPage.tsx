import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/useDocumentTitle';

export function NotFoundPage() {
  usePageTitle('Not found');
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--rm-meta)' }}>
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to home</Link>
      </p>
    </div>
  );
}
