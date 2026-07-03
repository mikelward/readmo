import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminFeedsPage } from './AdminFeedsPage';
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

function render(source?: MockDataSource) {
  return renderWithProviders(<AdminFeedsPage />, {
    source: source ?? new MockDataSource(`test-${Math.random()}`),
    route: '/admin/feeds',
  });
}

describe('AdminFeedsPage', () => {
  // The capability query is gated on a signed-in user.
  beforeEach(() => window.localStorage.setItem('readmo:mock-signed-in', '1'));
  afterEach(() => window.localStorage.clear());

  it('shows a not-authorized message for a non-admin', async () => {
    renderWithProviders(<AdminFeedsPage />, {
      source: new CapsSource({ family: false, admin: false, allowlistArmed: false }),
      route: '/admin/feeds',
    });
    expect(await screen.findByText(/don.t have access/i)).toBeInTheDocument();
    expect(screen.queryByTestId('admin-feeds')).not.toBeInTheDocument();
  });

  it('flags a feed whose last poll failed', async () => {
    render();
    // The seeded "Occasionally Down Blog" has errorCount 7 + a last error.
    const pill = await screen.findByTestId('feed-status-feed-park');
    expect(pill).toHaveTextContent('Poll failed');
    expect(
      screen.getByText(/Last poll failed: HTTP 503 after 7 attempts/i),
    ).toBeInTheDocument();
  });

  it('surfaces a blocked download with the publisher HTTP status', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    // Record a 403 bot-block for a Verge article.
    source.recordFulltextStatus('item-1', { status: 'auth', httpStatus: 403 });
    render(source);

    const pill = await screen.findByTestId('feed-status-feed-verge');
    expect(pill).toHaveTextContent('Blocked');
    expect(
      screen.getByText(/Publisher blocked the fetch \(HTTP 403\)/i),
    ).toBeInTheDocument();
    // The sampled article's title is shown so the operator knows what failed.
    expect(
      screen.getByText(/A foldable phone that actually folds flat/i),
    ).toBeInTheDocument();
  });

  it('surfaces a robots.txt denial with the matching rule', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.recordFulltextStatus('item-1', {
      status: 'empty',
      error: 'disallowed by robots.txt (User-agent: *)',
      robotsRule: 'Disallow: /news/',
    });
    render(source);

    expect(await screen.findByTestId('feed-status-feed-verge')).toHaveTextContent(
      'Empty',
    );
    expect(
      screen.getByText(/disallowed by robots\.txt.*Disallow: \/news\//i),
    ).toBeInTheDocument();
  });

  it('shows a downloaded article and a not-tried feed distinctly', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    await source.fetchFullText('item-2'); // a NASA item → cached → downloaded
    render(source);

    expect(await screen.findByTestId('feed-status-feed-nasa')).toHaveTextContent(
      'Downloaded',
    );
    // CSS-Tricks has no recorded attempt → nothing to evaluate.
    expect(screen.getByTestId('feed-status-feed-css')).toHaveTextContent(
      'Not tried',
    );
  });

  it('filters to only the unhealthy feeds', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    await source.fetchFullText('item-2'); // NASA → downloaded (healthy)
    render(source);

    // All view: the healthy NASA feed is present.
    expect(await screen.findByTestId('feed-status-feed-nasa')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Unhealthy/ }));

    await waitFor(() =>
      expect(screen.queryByTestId('feed-status-feed-nasa')).not.toBeInTheDocument(),
    );
    // The poll-failed feed is a genuine failure → still shown.
    expect(screen.getByTestId('feed-status-feed-park')).toBeInTheDocument();
    // A not-tried feed is informational, not a failure → hidden.
    expect(screen.queryByTestId('feed-status-feed-css')).not.toBeInTheDocument();
  });

  it('refreshes a feed from its overflow menu, clearing the poll failure', async () => {
    const user = userEvent.setup();
    render(); // default mock: "Occasionally Down Blog" is poll-failed (errorCount 7)

    expect(await screen.findByTestId('feed-status-feed-park')).toHaveTextContent(
      'Poll failed',
    );

    // Open the row's overflow menu → first entry is Refresh.
    await user.click(
      screen.getByRole('button', { name: 'Actions for Occasionally Down Blog' }),
    );
    const menu = within(await screen.findByTestId('item-row-menu'));
    expect(menu.getByTestId('item-row-menu-refresh')).toHaveTextContent('Refresh');

    await user.click(menu.getByTestId('item-row-menu-refresh'));

    // The mock's refresh clears the feed's error → the re-read drops it out of
    // "Poll failed" (no recorded attempt → Not tried).
    await waitFor(() =>
      expect(screen.getByTestId('feed-status-feed-park')).toHaveTextContent(
        'Not tried',
      ),
    );
  });

  it('deletes a feed from its overflow menu after confirmation', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render();

    expect(await screen.findByTestId('feed-status-feed-park')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Actions for Occasionally Down Blog' }),
    );
    const menu = within(await screen.findByTestId('item-row-menu'));
    await user.click(menu.getByTestId('item-row-menu-delete'));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId('feed-status-feed-park')).not.toBeInTheDocument(),
    );
    confirmSpy.mockRestore();
  });

  it('does not delete when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render();

    await screen.findByTestId('feed-status-feed-park');
    await user.click(
      screen.getByRole('button', { name: 'Actions for Occasionally Down Blog' }),
    );
    const menu = within(await screen.findByTestId('item-row-menu'));
    await user.click(menu.getByTestId('item-row-menu-delete'));

    // Cancelled → the feed is still listed.
    expect(screen.getByTestId('feed-status-feed-park')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('links back to the admin page', async () => {
    render();
    const back = await screen.findByRole('link', { name: /Back to Admin/i });
    expect(back).toHaveAttribute('href', '/admin');
  });
});
