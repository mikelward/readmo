import { describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { MockDataSource } from './lib/data/MockDataSource';
import App from './App';
import { renderWithProviders } from './test/renderWithProviders';
import {
  readOpenModeSnapshot,
  resetOpenModeSnapshotForTest,
} from './lib/openModeSnapshot';
import type { Subscription } from './lib/types';

const SUBSCRIPTION: Subscription = {
  feedId: 'feed-hn',
  folder: null,
  titleOverride: null,
  muted: false,
  openOriginal: false,
  openNewshacker: true,
  markDoneOnOpen: false,
  listLayout: null,
  sort: 0,
};

/** App-level wiring whose absence is SILENT — the app renders, nothing throws,
 * and a setting quietly stops applying. A hook that has to be mounted exactly
 * once, app-wide, is the shape that goes missing in a refactor, so it's asserted
 * through App rather than by reading App.tsx. */
describe('App wiring', () => {
  it('mounts the open-mode snapshot sync, so a mode set outside a list is remembered', async () => {
    window.localStorage.clear();
    resetOpenModeSnapshotForTest();
    // Only a signed-in read is remembered (see useOpenModeSnapshotSync); this is
    // what signed-in means on the mock auth path Supabase-less tests take.
    window.localStorage.setItem('readmo:mock-signed-in', '1');

    // App's own subscriptions read — no article list needed for it to land.
    const source = new MockDataSource(`test-${Math.random()}`);
    const real = await source.getSubscriptions();
    vi.spyOn(source, 'getSubscriptions').mockResolvedValue([
      { ...real[0], subscription: SUBSCRIPTION },
    ]);

    renderWithProviders(<App />, { source, route: '/' });

    await waitFor(() =>
      expect([...readOpenModeSnapshot().openNewshacker]).toEqual(['feed-hn']),
    );
  });
});
