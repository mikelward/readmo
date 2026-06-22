import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
import { FeedPage } from './FeedPages';

function renderFeed(source: MockDataSource, feedId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/feed/:feedId" element={<FeedPage />} />
    </Routes>,
    { source, route: `/feed/${feedId}` },
  );
}

describe('FeedPage (parked-feed retry)', () => {
  // `feed-park` is seeded with parked: true (src/lib/data/seed.ts).
  it('clears the retry badge after a successful retry', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderFeed(source, 'feed-park');

    const retry = await screen.findByRole('button', {
      name: /Feed has errors · Retry now/,
    });
    await user.click(retry);

    // The mutation invalidates ['feed-meta', …]; the refetched, un-parked feed
    // removes the badge without any remount.
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Feed has errors · Retry now/ }),
      ).toBeNull();
    });
  });
});
