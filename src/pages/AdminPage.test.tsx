import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminPage } from './AdminPage';
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

describe('AdminPage', () => {
  // The capability query is gated on a signed-in user.
  beforeEach(() => window.localStorage.setItem('readmo:mock-signed-in', '1'));
  afterEach(() => window.localStorage.clear());

  it('shows a not-authorized message for a non-admin', async () => {
    renderWithProviders(<AdminPage />, {
      source: new CapsSource({ family: false, admin: false, allowlistArmed: false }),
      route: '/admin',
    });
    expect(await screen.findByText(/don.t have access/i)).toBeInTheDocument();
    // No management UI for a non-admin.
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });

  it('lists, adds, and removes allowlist emails for an admin', async () => {
    const user = userEvent.setup();
    // The default MockDataSource reports admin + seeds the demo email.
    renderWithProviders(<AdminPage />, { route: '/admin' });

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
    renderWithProviders(<AdminPage />, { route: '/admin' });

    const users = within(await screen.findByTestId('admin-users'));
    expect(await users.findByText('alex@example.com')).toBeInTheDocument();
    // The admin (demo) carries Admin + Family pills.
    expect(users.getByText('Admin')).toBeInTheDocument();

    // alex is off-list → "Make family"; clicking promotes them (adds to allowlist).
    await user.click(
      users.getByRole('button', { name: 'Make alex@example.com family' }),
    );
    await waitFor(() =>
      expect(
        users.getByRole('button', { name: 'Remove alex@example.com from family' }),
      ).toBeInTheDocument(),
    );
    // …and they now appear on the allowlist section too.
    const allowlist = within(screen.getByTestId('admin-allowlist'));
    expect(await allowlist.findByText('alex@example.com')).toBeInTheDocument();

    // Demote back off family.
    await user.click(
      users.getByRole('button', { name: 'Remove alex@example.com from family' }),
    );
    await waitFor(() =>
      expect(
        users.getByRole('button', { name: 'Make alex@example.com family' }),
      ).toBeInTheDocument(),
    );
  });

  it('sorts the user list by name or signup date, and groups family first', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminPage />, { route: '/admin' });
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

  it('shows an error/retry state when the user list fails to load', async () => {
    class FailingUsers extends MockDataSource {
      async listUsers(): Promise<never> {
        throw new Error('network down');
      }
    }
    renderWithProviders(<AdminPage />, {
      source: new FailingUsers(`test-${Math.random()}`),
      route: '/admin',
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
    renderWithProviders(<AdminPage />, { source, route: '/admin' });

    expect(await screen.findByText(/couldn.t load the allowlist/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The misleading empty-state copy must NOT appear.
    expect(screen.queryByText(/open to everyone/i)).not.toBeInTheDocument();
  });
});
