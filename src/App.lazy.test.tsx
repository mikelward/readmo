import { lazy, Suspense } from 'react';
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './test/renderWithProviders';

/** Mirrors the lazy wrapper in App.tsx. SettingsPage is a *named* export, so the
 * dynamic import has to be adapted to the `{ default }` shape React.lazy expects
 * — this test guards that interop and the Suspense boundary resolving, which is
 * what would silently break the /settings route if the wrapper regressed. */
const LazySettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

describe('lazy-loaded SettingsPage', () => {
  it('resolves the split chunk and renders the settings UI', async () => {
    renderWithProviders(
      <Suspense fallback={<div>loading-fallback</div>}>
        <LazySettingsPage />
      </Suspense>,
    );

    // The Suspense fallback shows synchronously while the chunk resolves...
    expect(screen.getByText('loading-fallback')).toBeInTheDocument();

    // ...then the real page mounts. The "Add a feed" URL field is unique to it.
    await waitFor(() => {
      expect(screen.getByLabelText('Feed URL')).toBeInTheDocument();
    });
    expect(screen.queryByText('loading-fallback')).not.toBeInTheDocument();
  });
});
