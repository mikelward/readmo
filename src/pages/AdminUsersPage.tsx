import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useAuth } from '../hooks/useAuth';
import { useCapabilities, CAPABILITIES_QUERY_KEY } from '../hooks/useCapabilities';
import { useToast } from '../hooks/useToast';
import { usePageTitle } from '../hooks/useDocumentTitle';
import { AdminDenied } from './AdminDenied';
import { ItemRowMenu, type ItemRowMenuItem } from '../components/ItemRowMenu';
import { usePointerDevice } from '../hooks/usePointerDevice';
import './AdminPage.css';

const ALLOWLIST_KEY = ['admin-allowlist'] as const;
const USERS_KEY = ['admin-users'] as const;
const SIGNUPS_KEY = ['admin-signups'] as const;

/** Operator-only user management: the trusted-user allowlist (who gets reading
 * mode + Google News feeds, and the FAMILY chip) and the registered-account
 * roster (family/block/delete + the global sign-up switch). Reached from the
 * `/admin` hub. Gated on the `admin` capability; every write is also enforced
 * server-side by the RPCs. */
export function AdminUsersPage() {
  usePageTitle('Users');
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { admin, canManageUsers, canViewSubscriptions } = useCapabilities();
  const { user } = useAuth();
  const navigate = useNavigate();
  const selfEmail = user?.email?.toLowerCase() ?? null;
  // Pointer devices get the anchored popover; touch gets the bottom sheet (44px
  // rows). ItemRowMenu picks the variant by whether it has an anchor, so we only
  // hand it one on hover-capable devices.
  const pointerDevice = usePointerDevice();
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

  const block = useMutation({
    mutationFn: ({ email: value, blocked }: { email: string; blocked: boolean }) =>
      ds.setUserBlocked(value, blocked),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: USERS_KEY }),
    onError: (err) =>
      showToast({ message: 'Couldn’t update that account.', detail: String(err) }),
  });

  const del = useMutation({
    mutationFn: (value: string) => ds.deleteUser(value),
    // A deleted account also drops off the allowlist → refresh both lists.
    onSuccess: invalidate,
    onError: (err) =>
      showToast({ message: 'Couldn’t delete that account.', detail: String(err) }),
  });

  // Global "allow new sign-ups" switch.
  const {
    data: signupsEnabled,
    isLoading: signupsLoading,
    isError: signupsError,
    refetch: refetchSignups,
  } = useQuery({
    queryKey: SIGNUPS_KEY,
    queryFn: () => ds.getSignupsEnabled(),
    // Only read the switch once 0030 is deployed (its RPC exists).
    enabled: admin && !!canManageUsers,
  });
  const signups = useMutation({
    mutationFn: (enabled: boolean) => ds.setSignupsEnabled(enabled),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: SIGNUPS_KEY }),
    onError: (err) =>
      showToast({ message: 'Couldn’t change sign-ups.', detail: String(err) }),
  });

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

  // Per-user actions live behind a single row-level "Manage" menu (guardrail #2:
  // one tap zone per row, not a row of three buttons). Track which row's menu is
  // open and its trigger element (the menu anchors to it on pointer, falls back
  // to a bottom sheet on touch — shared ItemRowMenu).
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const closeMenu = () => {
    setMenuFor(null);
    setMenuAnchor(null);
  };
  const menuUser = menuFor
    ? sortedUsers.find((u) => u.email === menuFor) ?? null
    : null;
  const menuItems: ItemRowMenuItem[] = [];
  if (menuUser) {
    const isSelf = selfEmail != null && menuUser.email === selfEmail;
    menuItems.push({
      key: 'family',
      label: menuUser.family ? 'Remove from family' : 'Make family',
      onSelect: () =>
        menuUser.family
          ? remove.mutate(menuUser.email)
          : add.mutate(menuUser.email),
    });
    // Drill down to this user's subscription list. Gated on the 0047 RPC being
    // deployed (guardrail #11) — hidden on an older backend rather than linking
    // to a page that would only error.
    if (canViewSubscriptions) {
      menuItems.push({
        key: 'feeds',
        label: 'Feeds',
        onSelect: () =>
          navigate(`/admin/users/${encodeURIComponent(menuUser.email)}/feeds`),
      });
    }
    // Block/Delete only exist once 0030 is deployed, and the server refuses to
    // target the calling admin — so omit them off an old backend or on self.
    if (canManageUsers && !isSelf) {
      menuItems.push({
        key: 'block',
        label: menuUser.blocked ? 'Unblock' : 'Block',
        onSelect: () =>
          block.mutate({ email: menuUser.email, blocked: !menuUser.blocked }),
      });
      menuItems.push({
        key: 'delete',
        label: 'Delete…',
        onSelect: () => {
          if (
            window.confirm(
              `Delete ${menuUser.email}? This removes their account and all their data. This can’t be undone.`,
            )
          ) {
            del.mutate(menuUser.email);
          }
        },
      });
    }
  }

  if (!admin) return <AdminDenied title="Users" />;

  return (
    <div className="admin">
      <div className="page-header">
        <h1 className="page-header__title">Users</h1>
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
        {/* The sign-up switch and the per-row Block/Delete actions ride on
            migration 0030's RPCs. The client auto-deploys ahead of migrations,
            so hide them until `canManageUsers` confirms 0030 is live rather than
            offer controls whose RPCs would 404. */}
        {canManageUsers &&
          (signupsLoading ? (
            <p className="admin__empty">Loading…</p>
          ) : signupsError ? (
            // Don't paint a checked "on" switch when the read failed — the real
            // value is unknown and may be off. Show a retry instead.
            <p className="admin__empty">
              Couldn’t load the sign-up setting.{' '}
              <button
                type="button"
                className="admin__retry"
                onClick={() => void refetchSignups()}
              >
                Retry
              </button>
            </p>
          ) : (
            <label className="admin__control admin__signups">
              <input
                type="checkbox"
                checked={signupsEnabled ?? true}
                disabled={signups.isPending}
                onChange={(e) => signups.mutate(e.target.checked)}
              />
              Allow new sign-ups
            </label>
          ))}
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
                <li key={u.email} className="admin__row admin__row--user">
                  <span className="admin__email">
                    {u.email}
                    {u.admin && <span className="admin__tag">Admin</span>}
                    {u.family && (
                      <span className="admin__tag admin__tag--family">Family</span>
                    )}
                    {u.blocked && (
                      <span className="admin__tag admin__tag--blocked">Blocked</span>
                    )}
                  </span>
                  {/* One row action — a Manage menu holding family / block /
                      delete — keeps the row at a single tap zone (guardrail #2). */}
                  <button
                    type="button"
                    className="admin__manage"
                    aria-haspopup="menu"
                    aria-expanded={menuFor === u.email}
                    aria-label={`Manage ${u.email}`}
                    disabled={familyBusy || block.isPending || del.isPending}
                    onClick={(e) => {
                      if (menuFor === u.email) {
                        closeMenu();
                      } else {
                        // Anchor only on pointer devices → touch falls back to
                        // the 44px bottom sheet.
                        setMenuAnchor(pointerDevice ? e.currentTarget : null);
                        setMenuFor(u.email);
                      }
                    }}
                  >
                    ⋮
                  </button>
                </li>
              ))}
            </ul>
            <ItemRowMenu
              open={menuFor !== null}
              title={menuFor ?? ''}
              items={menuItems}
              anchorEl={menuAnchor}
              onClose={closeMenu}
            />
          </>
        )}
      </section>

      <p className="admin__back">
        <Link to="/admin">&larr; Back to Admin</Link>
      </p>
    </div>
  );
}
