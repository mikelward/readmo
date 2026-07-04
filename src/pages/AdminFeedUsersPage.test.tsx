import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { AdminFeedUsersPage } from './AdminFeedUsersPage';
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

function renderPage(feedId: string, source?: MockDataSource) {
  return renderWithProviders(
    <Routes>
      <Route path="/admin/feeds/:feedId/users" element={<AdminFeedUsersPage />} />
    </Routes>,
    { route: `/admin/feeds/${feedId}/users`, source },
  );
}

describe('AdminFeedUsersPage', () => {
  beforeEach(() => window.localStorage.setItem('readmo:mock-signed-in', '1'));
  afterEach(() => window.localStorage.clear());

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
    renderPage(
      'feed-anything',
      new CapsSource({ family: false, admin: false, allowlistArmed: false }),
    );
    expect(await screen.findByText(/don.t have access/i)).toBeInTheDocument();
  });
});
