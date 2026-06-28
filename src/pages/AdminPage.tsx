import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useCapabilities, CAPABILITIES_QUERY_KEY } from '../hooks/useCapabilities';
import { useToast } from '../hooks/useToast';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import './AdminPage.css';

const ALLOWLIST_KEY = ['admin-allowlist'] as const;

/** Operator-only page to manage the trusted-user allowlist (who gets reading
 * mode + Google News feeds, and the FAMILY chip). Gated on the `admin`
 * capability; every write is also enforced server-side by the RPCs. */
export function AdminPage() {
  useDocumentTitle('Admin · Readmo');
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { admin } = useCapabilities();
  const [email, setEmail] = useState('');

  const {
    data: entries = [],
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ALLOWLIST_KEY,
    queryFn: () => ds.listAllowlist(),
    enabled: admin,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ALLOWLIST_KEY });
    // Membership may now include/exclude the current user → refresh the chip.
    void queryClient.invalidateQueries({ queryKey: CAPABILITIES_QUERY_KEY });
  };

  const add = useMutation({
    mutationFn: (value: string) => ds.addToAllowlist(value),
    onSuccess: invalidate,
    onError: (err) =>
      showToast({ message: 'Couldn’t add that email.', detail: String(err) }),
  });

  const remove = useMutation({
    mutationFn: (value: string) => ds.removeFromAllowlist(value),
    onSuccess: invalidate,
    onError: (err) =>
      showToast({ message: 'Couldn’t remove that email.', detail: String(err) }),
  });

  if (!admin) {
    return (
      <div className="admin">
        <div className="page-header">
          <h1 className="page-header__title">Admin</h1>
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
        <h1 className="page-header__title">Admin</h1>
      </div>

      <section className="settings__section">
        <h2 className="settings__heading">Trusted-user allowlist</h2>
        <form
          className="settings__add"
          onSubmit={(e) => {
            e.preventDefault();
            const value = email.trim();
            if (!value || add.isPending) return;
            add.mutate(value, { onSuccess: () => setEmail('') });
          }}
        >
          <div className="settings__add-wrap">
            <input
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="search-input"
              placeholder="family@example.com"
              aria-label="Email to allow"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="settings__btn"
            disabled={add.isPending || email.trim().length === 0}
          >
            Add
          </button>
        </form>

        {isLoading ? (
          <p className="admin__empty">Loading…</p>
        ) : isError ? (
          // Don't fall through to the empty-state copy on a load failure — that
          // would falsely tell the operator the allowlist is empty (gates open).
          <p className="admin__empty">
            Couldn’t load the allowlist.{' '}
            <button
              type="button"
              className="admin__retry"
              onClick={() => void refetch()}
            >
              Retry
            </button>
          </p>
        ) : entries.length === 0 ? (
          <p className="admin__empty">
            No one is on the allowlist yet — reading mode and Google News feeds are
            open to everyone.
          </p>
        ) : (
          <ul className="admin__list">
            {entries.map((entry) => (
              <li key={entry.email} className="admin__row">
                <span className="admin__email">{entry.email}</span>
                <button
                  type="button"
                  className="admin__remove"
                  aria-label={`Remove ${entry.email}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(entry.email)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="admin__back">
        <Link to="/">&larr; Back to Home</Link>
      </p>
    </div>
  );
}
