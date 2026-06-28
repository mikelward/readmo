import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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

    expect(await screen.findByText('demo@readmo.app')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Email to allow'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('new@example.com')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove demo@readmo.app' }));
    await waitFor(() =>
      expect(screen.queryByText('demo@readmo.app')).not.toBeInTheDocument(),
    );
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
