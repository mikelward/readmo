import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminUsersPage } from './AdminUsersPage';
import { MockDataSource } from '../lib/data/MockDataSource';
import { renderWithProviders } from '../test/renderWithProviders';
import type { Capabilities } from '../lib/data/DataSource';

class CapsSource extends MockDataSource {
  constructor(private readonly caps: Capabilities) {
    super(`test-${Math.random()}`);
  }
  async getCapabilities(): Promise<Capabilities> {
    return this.caps;
  }
}

/** Per-user actions live behind the row's "Manage" (⋯) menu now — open it and
 * return a scope over the portal-rendered menu. */
async function openRowMenu(
  user: ReturnType<typeof userEvent.setup>,
  email: string,
) {
  await user.click(
    within(screen.getByTestId('admin-users')).getByRole('button', {
      name: `Manage ${email}`,
    }),
  );
  return within(await screen.findByTestId('item-row-menu'));
}

describe('AdminUsersPage', () => {
  // The capability query is gated on a signed-in user.
  beforeEach(() => window.localStorage.setItem('readmo:mock-signed-in', '1'));
  afterEach(() => window.localStorage.clear());

  it('shows a not-authorized message for a non-admin', async () => {
    renderWithProviders(<AdminUsersPage />, {
      source: new CapsSource({ family: false, admin: false, allowlistArmed: false }),
      route: '/admin/users',
    });
    expect(await screen.findByText(/don.t have access/i)).toBeInTheDocument();
    // No management UI for a non-admin.
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });

  it('lists, adds, and removes allowlist emails for an admin', async () => {
    const user = userEvent.setup();
    // The default MockDataSource reports admin + seeds the demo email.
    renderWithProviders(<AdminUsersPage />, { route: '/admin/users' });

    // Scope to the allowlist section — the demo email also appears in the
    // registered-users list below, so a page-wide query would be ambiguous.
    const allowlist = within(await screen.findByTestId('admin-allowlist'));
    expect(await allowlist.findByText('demo@readmo.app')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Email to allow'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await allowlist.findByText('new@example.com')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove demo@readmo.app' }));
    await waitFor(() =>
      expect(allowlist.queryByText('demo@readmo.app')).not.toBeInTheDocument(),
    );
  });

  it('lists registered users and promotes/demotes them to family', async () => {
    const user = userEvent.setup();
    // Default mock: demo@readmo.app is admin + family; alex/sam are off-list.
    renderWithProviders(<AdminUsersPage />, { route: '/admin/users' });

    const users = within(await screen.findByTestId('admin-users'));
    expect(await users.findByText('alex@example.com')).toBeInTheDocument();
    // The admin (demo) carries Admin + Family pills.
    expect(users.getByText('Admin')).toBeInTheDocument();

    // alex is off-list → the row menu offers "Make family"; clicking promotes
    // them (adds to allowlist).
    let menu = await openRowMenu(user, 'alex@example.com');
    expect(menu.getByTestId('item-row-menu-family')).toHaveTextContent(
      'Make family',
    );
    await user.click(menu.getByTestId('item-row-menu-family'));
    // …and they now appear on the allowlist section too.
    const allowlist = within(screen.getByTestId('admin-allowlist'));
    expect(await allowlist.findByText('alex@example.com')).toBeInTheDocument();

    // Reopen the menu → it now offers demote; clicking removes them.
    menu = await openRowMenu(user, 'alex@example.com');
    expect(menu.getByTestId('item-row-menu-family')).toHaveTextContent(
      'Remove from family',
    );
    await user.click(menu.getByTestId('item-row-menu-family'));
    await waitFor(() =>
      expect(allowlist.queryByText('alex@example.com')).not.toBeInTheDocument(),
    );
  });

  it('offers a "Feeds" drill-down in the row menu when subscription views are available', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminUsersPage />, { route: '/admin/users' });
    await screen.findByText('alex@example.com');
    const menu = await openRowMenu(user, 'alex@example.com');
    expect(menu.getByTestId('item-row-menu-feeds')).toBeInTheDocument();
  });

  it('hides the "Feeds" drill-down on a backend without the 0047 RPCs', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminUsersPage />, {
      source: new CapsSource({
        family: false,
        admin: true,
        allowlistArmed: false,
        canManageUsers: true,
        // canViewSubscriptions absent → the drill-down link is not offered.
      }),
      route: '/admin/users',
    });
    await screen.findByText('alex@example.com');
    const menu = await openRowMenu(user, 'alex@example.com');
    expect(menu.queryByTestId('item-row-menu-feeds')).not.toBeInTheDocument();
  });

  it('sorts the user list by name or signup date, and groups family first', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminUsersPage />, { route: '/admin/users' });
    const section = await screen.findByTestId('admin-users');
    const users = within(section);
    await users.findByText('alex@example.com');

    // Emails in row order, with the Admin/Family pill text stripped off.
    const order = () =>
      within(section)
        .getAllByRole('listitem')
        .map((li) =>
          (li.querySelector('.admin__email')?.textContent ?? '').replace(
            /Admin|Family/g,
            '',
          ),
        );

    // Default: Name A–Z.
    expect(order()).toEqual([
      'alex@example.com',
      'demo@readmo.app',
      'sam@example.com',
    ]);

    // Newest signup first: alex (Mar) → sam (Feb) → demo (Jan).
    await user.selectOptions(users.getByRole('combobox'), 'created');
    expect(order()).toEqual([
      'alex@example.com',
      'sam@example.com',
      'demo@readmo.app',
    ]);

    // Family first lifts the family user (demo) to the top.
    await user.click(users.getByRole('checkbox', { name: /family first/i }));
    expect(order()[0]).toBe('demo@readmo.app');
  });

  it('blocks and unblocks a registered user', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminUsersPage />, { route: '/admin/users' });
    const users = within(await screen.findByTestId('admin-users'));
    await users.findByText('alex@example.com');

    let menu = await openRowMenu(user, 'alex@example.com');
    expect(menu.getByTestId('item-row-menu-block')).toHaveTextContent('Block');
    await user.click(menu.getByTestId('item-row-menu-block'));
    // The row now carries a Blocked pill.
    await waitFor(() => expect(users.getByText('Blocked')).toBeInTheDocument());

    // Reopen → the action flips to Unblock; clicking clears the block.
    menu = await openRowMenu(user, 'alex@example.com');
    expect(menu.getByTestId('item-row-menu-block')).toHaveTextContent('Unblock');
    await user.click(menu.getByTestId('item-row-menu-block'));
    await waitFor(() =>
      expect(users.queryByText('Blocked')).not.toBeInTheDocument(),
    );
  });

  it('opens the Manage menu as a bottom sheet on touch (no hover)', async () => {
    // jsdom default: no matchMedia → not hover-capable → touch. The menu must
    // use the sheet variant (44px rows), not the 36px anchored popover.
    const user = userEvent.setup();
    renderWithProviders(<AdminUsersPage />, { route: '/admin/users' });
    const users = within(await screen.findByTestId('admin-users'));
    await users.findByText('alex@example.com');
    await user.click(users.getByRole('button', { name: 'Manage alex@example.com' }));
    expect(await screen.findByTestId('item-row-menu')).toHaveAttribute(
      'data-variant',
      'sheet',
    );
  });

  it('opens the Manage menu as an anchored popover on hover-capable devices', async () => {
    const user = userEvent.setup();
    window.matchMedia = ((query: string) => ({
      matches: query.includes('hover: hover'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      renderWithProviders(<AdminUsersPage />, { route: '/admin/users' });
      const users = within(await screen.findByTestId('admin-users'));
      await users.findByText('alex@example.com');
      await user.click(
        users.getByRole('button', { name: 'Manage alex@example.com' }),
      );
      expect(await screen.findByTestId('item-row-menu')).toHaveAttribute(
        'data-variant',
        'popover',
      );
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });

  it('deletes a registered user after confirmation', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithProviders(<AdminUsersPage />, { route: '/admin/users' });
    const users = within(await screen.findByTestId('admin-users'));
    await users.findByText('sam@example.com');

    const menu = await openRowMenu(user, 'sam@example.com');
    await user.click(menu.getByTestId('item-row-menu-delete'));
    await waitFor(() =>
      expect(users.queryByText('sam@example.com')).not.toBeInTheDocument(),
    );
    confirm.mockRestore();
  });

  it('does not delete when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithProviders(<AdminUsersPage />, { route: '/admin/users' });
    const users = within(await screen.findByTestId('admin-users'));
    await users.findByText('sam@example.com');

    const menu = await openRowMenu(user, 'sam@example.com');
    await user.click(menu.getByTestId('item-row-menu-delete'));
    // Still present — a dismissed confirm is a no-op.
    expect(users.getByText('sam@example.com')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('hides block/delete on the signed-in admin’s own row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminUsersPage />, { route: '/admin/users' });
    const users = within(await screen.findByTestId('admin-users'));
    await users.findByText('demo@readmo.app');

    // The self row (demo) menu offers only the family action — no self-targeting
    // block/delete (the server refuses those on the caller too).
    const selfMenu = await openRowMenu(user, 'demo@readmo.app');
    expect(selfMenu.getByTestId('item-row-menu-family')).toBeInTheDocument();
    expect(selfMenu.queryByTestId('item-row-menu-block')).not.toBeInTheDocument();
    expect(selfMenu.queryByTestId('item-row-menu-delete')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    // …but a non-self row's menu does carry them.
    const otherMenu = await openRowMenu(user, 'alex@example.com');
    expect(otherMenu.getByTestId('item-row-menu-block')).toBeInTheDocument();
    expect(otherMenu.getByTestId('item-row-menu-delete')).toBeInTheDocument();
  });

  it('toggles the global allow-new-sign-ups switch', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminUsersPage />, { route: '/admin/users' });
    const users = within(await screen.findByTestId('admin-users'));
    const toggle = await users.findByRole('checkbox', { name: /allow new sign-ups/i });
    // Defaults open.
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
  });

  it('shows a retry (not a checked switch) when the sign-up setting fails to load', async () => {
    // A failed get_signups_enabled read must NOT fall through to a checked
    // "on" switch — the real value is unknown and may be off.
    class FailingSignups extends MockDataSource {
      async getSignupsEnabled(): Promise<never> {
        throw new Error('network down');
      }
    }
    renderWithProviders(<AdminUsersPage />, {
      source: new FailingSignups(`test-${Math.random()}`),
      route: '/admin/users',
    });
    const users = within(await screen.findByTestId('admin-users'));
    expect(await users.findByText(/couldn.t load the sign-up setting/i)).toBeInTheDocument();
    expect(
      users.queryByRole('checkbox', { name: /allow new sign-ups/i }),
    ).not.toBeInTheDocument();
  });

  it('hides the 0030 controls (sign-ups switch, block, delete) on a pre-0030 backend', async () => {
    // Admin, but the backend predates migration 0030 → canManageUsers false. The
    // family promote/demote (0028 RPCs) still works; block/delete/sign-ups don't
    // exist yet, so their controls must not render.
    renderWithProviders(<AdminUsersPage />, {
      source: new CapsSource({
        family: false,
        admin: true,
        allowlistArmed: false,
        canManageUsers: false,
      }),
      route: '/admin/users',
    });
    const user = userEvent.setup();
    const users = within(await screen.findByTestId('admin-users'));
    await users.findByText('alex@example.com');
    // No global sign-ups switch on an old backend.
    expect(
      users.queryByRole('checkbox', { name: /allow new sign-ups/i }),
    ).not.toBeInTheDocument();
    // The row menu still offers family (0028) but not block/delete (0030).
    const menu = await openRowMenu(user, 'alex@example.com');
    expect(menu.getByTestId('item-row-menu-family')).toBeInTheDocument();
    expect(menu.queryByTestId('item-row-menu-block')).not.toBeInTheDocument();
    expect(menu.queryByTestId('item-row-menu-delete')).not.toBeInTheDocument();
  });

  it('shows an error/retry state when the user list fails to load', async () => {
    class FailingUsers extends MockDataSource {
      async listUsers(): Promise<never> {
        throw new Error('network down');
      }
    }
    renderWithProviders(<AdminUsersPage />, {
      source: new FailingUsers(`test-${Math.random()}`),
      route: '/admin/users',
    });
    const users = within(await screen.findByTestId('admin-users'));
    expect(await users.findByText(/couldn.t load users/i)).toBeInTheDocument();
    expect(users.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows an error/retry state when the allowlist fails to load', async () => {
    // A failed listAllowlist() must NOT fall through to the empty-state copy —
    // that would falsely tell the operator the gates are open to everyone.
    class FailingList extends MockDataSource {
      async listAllowlist(): Promise<never> {
        throw new Error('network down');
      }
    }
    const source = new FailingList(`test-${Math.random()}`);
    renderWithProviders(<AdminUsersPage />, { source, route: '/admin/users' });

    expect(await screen.findByText(/couldn.t load the allowlist/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The misleading empty-state copy must NOT appear.
    expect(screen.queryByText(/open to everyone/i)).not.toBeInTheDocument();
  });
});

describe('AdminUsersPage — restore window', () => {
  beforeEach(() => window.localStorage.setItem('readmo:mock-signed-in', '1'));
  afterEach(() => window.localStorage.clear());

  // Two claims this page must not make off an unread cache: that the operator
  // has no access (the `admin` default is false), and — once past that — that
  // the allowlist is empty, which reads as "the gates are open to everyone".
  // Nothing may fetch while the persisted cache hydrates, and React Query
  // reports isLoading false throughout it, so both used to render.
  it('neither denies access nor reports the gates open while the persisted cache is restoring', () => {
    renderWithProviders(<AdminUsersPage />, {
      route: '/admin/users',
      isRestoring: true,
    });

    expect(screen.queryByText(/don.t have access/i)).toBeNull();
    expect(screen.queryByText(/no one is on the allowlist/i)).toBeNull();
    expect(screen.queryByText(/no registered users yet/i)).toBeNull();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
