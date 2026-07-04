import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { AdminUserFeedsPage } from './AdminUserFeedsPage';
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

function renderPage(route: string, source?: MockDataSource) {
  return renderWithProviders(
    <Routes>
      <Route path="/admin/users/:email/feeds" element={<AdminUserFeedsPage />} />
    </Routes>,
    { route, source },
  );
}

describe('AdminUserFeedsPage', () => {
  beforeEach(() => window.localStorage.setItem('readmo:mock-signed-in', '1'));
  afterEach(() => window.localStorage.clear());

  it('lists the feeds a user subscribes to, headed by their email', async () => {
    renderPage('/admin/users/alex@example.com/feeds');
    // The section heading is the target user's email.
    expect(
      await screen.findByRole('heading', { name: 'alex@example.com' }),
    ).toBeInTheDocument();
    // alex's fabricated subscriptions render as rows.
    expect((await screen.findAllByRole('listitem')).length).toBeGreaterThan(0);
  });

  it('shows an empty state for a user with no subscriptions', async () => {
    renderPage('/admin/users/nobody@example.com/feeds');
    expect(
      await screen.findByText(/no subscriptions/i),
    ).toBeInTheDocument();
  });

  it('shows a not-authorized message for a non-admin', async () => {
    renderPage(
      '/admin/users/alex@example.com/feeds',
      new CapsSource({ family: false, admin: false, allowlistArmed: false }),
    );
    expect(await screen.findByText(/don.t have access/i)).toBeInTheDocument();
  });
});
