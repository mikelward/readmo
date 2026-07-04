import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
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

describe('AdminPage (hub)', () => {
  // The capability query is gated on a signed-in user.
  beforeEach(() => window.localStorage.setItem('readmo:mock-signed-in', '1'));
  afterEach(() => window.localStorage.clear());

  it('shows a not-authorized message for a non-admin', async () => {
    renderWithProviders(<AdminPage />, {
      source: new CapsSource({ family: false, admin: false, allowlistArmed: false }),
      route: '/admin',
    });
    expect(await screen.findByText(/don.t have access/i)).toBeInTheDocument();
    // No management links for a non-admin.
    expect(
      screen.queryByRole('link', { name: /manage users/i }),
    ).not.toBeInTheDocument();
  });

  it('links to the Users and Feeds sub-pages for an admin', async () => {
    // The default MockDataSource reports admin.
    renderWithProviders(<AdminPage />, { route: '/admin' });

    const usersLink = await screen.findByRole('link', { name: /manage users/i });
    expect(usersLink).toHaveAttribute('href', '/admin/users');

    const feedsLink = screen.getByRole('link', { name: /manage feeds/i });
    expect(feedsLink).toHaveAttribute('href', '/admin/feeds');
  });
});
