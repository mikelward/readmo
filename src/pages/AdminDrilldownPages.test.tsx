import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { AdminFeedUsersPage, AdminUserFeedsPage } from './AdminDrilldownPages';
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

const nonAdmin = () =>
  new CapsSource({ family: false, admin: false, allowlistArmed: false });

beforeEach(() => window.localStorage.setItem('readmo:mock-signed-in', '1'));
afterEach(() => window.localStorage.clear());

describe('AdminFeedUsersPage', () => {
  function renderPage(feedId: string, source?: MockDataSource) {
    return renderWithProviders(
      <Routes>
        <Route path="/admin/feeds/:feedId/users" element={<AdminFeedUsersPage />} />
      </Routes>,
      { route: `/admin/feeds/${feedId}/users`, source },
    );
  }

  it('lists the accounts subscribed to a feed', async () => {
    const source = new MockDataSource('test-subs');
    // A feed the demo (self) account subscribes to → the demo user is a
    // subscriber, so the drill-down shows at least that account.
    const subs = await source.getSubscriptions();
    const feedId = subs[0].feed.id;
    renderPage(feedId, source);
    expect(await screen.findByText('demo@readmo.app')).toBeInTheDocument();
  });

  it('shows a not-authorized message for a non-admin', async () => {
    renderPage('feed-anything', nonAdmin());
    expect(await screen.findByText(/don.t have access/i)).toBeInTheDocument();
  });
});

describe('AdminUserFeedsPage', () => {
  function renderPage(route: string, source?: MockDataSource) {
    return renderWithProviders(
      <Routes>
        <Route path="/admin/users/:email/feeds" element={<AdminUserFeedsPage />} />
      </Routes>,
      { route, source },
    );
  }

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
    renderPage('/admin/users/alex@example.com/feeds', nonAdmin());
    expect(await screen.findByText(/don.t have access/i)).toBeInTheDocument();
  });
});

describe('Admin drill-downs — restore window', () => {
  it('neither denies access nor reports an empty subscriber list while the persisted cache is restoring', () => {
    renderWithProviders(
      <Routes>
        <Route path="/admin/feeds/:feedId/users" element={<AdminFeedUsersPage />} />
      </Routes>,
      { route: '/admin/feeds/feed-1/users', isRestoring: true },
    );

    expect(screen.queryByText(/don.t have access/i)).toBeNull();
    expect(screen.queryByText(/no one is subscribed to this feed/i)).toBeNull();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
