import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useCapabilities, CAPABILITIES_QUERY_KEY } from '../hooks/useCapabilities';
import { useToast } from '../hooks/useToast';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import './AdminPage.css';

const ALLOWLIST_KEY = ['admin-allowlist'] as const;
const USERS_KEY = ['admin-users'] as const;

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

  const {
    data: users = [],
    isLoading: usersLoading,
    isError: usersError,
    refetch: refetchUsers,
  } = useQuery({
    queryKey: USERS_KEY,
    queryFn: () => ds.listUsers(),
    enabled: admin,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ALLOWLIST_KEY });
    // The user list shows each account's family status → refresh it too.
    void queryClient.invalidateQueries({ queryKey: USERS_KEY });
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

  // Promote/demote a registered user to/from family = add/remove their email on
  // the allowlist (the same admin RPCs back both the list and the user toggle).
  const familyBusy = add.isPending || remove.isPending;

  // Client-side sort/group of the registered-user list (per-device, ephemeral).
  const [sortBy, setSortBy] = useState<'email' | 'created'>('email');
  const [familyFirst, setFamilyFirst] = useState(false);
  const sortedUsers = useMemo(() => {
    const sorted = [...users].sort((a, b) =>
      sortBy === 'email'
        ? a.email.localeCompare(b.email)
        : // ISO timestamps compare chronologically; newest signup first.
          b.createdAt.localeCompare(a.createdAt),
    );
    if (!familyFirst) return sorted;
    // Array.sort is stable, so this lifts family above non-family while keeping
    // the chosen order within each group.
    return sorted.sort((a, b) => Number(b.family) - Number(a.family));
  }, [users, sortBy, familyFirst]);

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

      <section className="settings__section" data-testid="admin-allowlist">
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

      <section className="settings__section" data-testid="admin-users">
        <h2 className="settings__heading">Registered users</h2>
        {usersLoading ? (
          <p className="admin__empty">Loading…</p>
        ) : usersError ? (
          <p className="admin__empty">
            Couldn’t load users.{' '}
            <button
              type="button"
              className="admin__retry"
              onClick={() => void refetchUsers()}
            >
              Retry
            </button>
          </p>
        ) : users.length === 0 ? (
          <p className="admin__empty">No registered users yet.</p>
        ) : (
          <>
            <div className="admin__controls">
              <label className="admin__control">
                Sort
                <select
                  className="admin__select"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as 'email' | 'created')}
                >
                  <option value="email">Name (A–Z)</option>
                  <option value="created">Newest signup</option>
                </select>
              </label>
              <label className="admin__control">
                <input
                  type="checkbox"
                  checked={familyFirst}
                  onChange={(e) => setFamilyFirst(e.target.checked)}
                />
                Family first
              </label>
            </div>
            <ul className="admin__list">
              {sortedUsers.map((u) => (
              <li key={u.email} className="admin__row">
                <span className="admin__email">
                  {u.email}
                  {u.admin && <span className="admin__tag">Admin</span>}
                  {u.family && (
                    <span className="admin__tag admin__tag--family">Family</span>
                  )}
                </span>
                <button
                  type="button"
                  className="admin__family-toggle"
                  aria-label={
                    u.family
                      ? `Remove ${u.email} from family`
                      : `Make ${u.email} family`
                  }
                  disabled={familyBusy}
                  onClick={() =>
                    u.family ? remove.mutate(u.email) : add.mutate(u.email)
                  }
                >
                  {u.family ? 'Remove family' : 'Make family'}
                </button>
              </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <p className="admin__back">
        <Link to="/">&larr; Back to Home</Link>
      </p>
    </div>
  );
}
