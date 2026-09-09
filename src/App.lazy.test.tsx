import { lazy, Suspense } from 'react';
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './test/renderWithProviders';

/** Mirrors the lazy wrapper in App.tsx. FeedsPage is a *named* export, so the
 * dynamic import has to be adapted to the `{ default }` shape React.lazy expects
 * — this test guards that interop and the Suspense boundary resolving, which is
 * what would silently break the /feeds route if the wrapper regressed. */
const LazyFeedsPage = lazy(() =>
  import('./pages/FeedsPage').then((m) => ({ default: m.FeedsPage })),
);

describe('lazy-loaded FeedsPage', () => {
  it('resolves the split chunk and renders the feed-management UI', async () => {
    renderWithProviders(
      <Suspense fallback={<div>loading-fallback</div>}>
        <LazyFeedsPage />
      </Suspense>,
    );

    // The Suspense fallback shows synchronously while the chunk resolves...
    expect(screen.getByText('loading-fallback')).toBeInTheDocument();

    // ...then the real page mounts. The "Add a feed" URL field is unique to it.
    await waitFor(() => {
      expect(screen.getByLabelText('Feed name or URL')).toBeInTheDocument();
    });
    expect(screen.queryByText('loading-fallback')).not.toBeInTheDocument();
  });
});
