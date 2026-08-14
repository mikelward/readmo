import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, screen } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { AdminPage } from './AdminPage';
import { MockDataSource } from '../lib/data/MockDataSource';
import { renderWithProviders } from '../test/renderWithProviders';
import { CAPABILITIES_QUERY_KEY } from '../hooks/useCapabilities';
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

describe('AdminPage — capability window', () => {
  beforeEach(() => window.localStorage.setItem('readmo:mock-signed-in', '1'));
  afterEach(() => window.localStorage.clear());

  // `admin` defaults to false until get_capabilities resolves, so the denial
  // panel used to render first on every admin page — an operator hard-loading
  // /admin was told they'd been locked out, then the page appeared. During the
  // persisted-cache restore nothing may even fetch, so that window is not
  // short. Say nothing about access until we know.
  it('does not deny access while the persisted cache is restoring', () => {
    renderWithProviders(<AdminPage />, { route: '/admin', isRestoring: true });

    expect(screen.queryByText(/don.t have access/i)).toBeNull();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('settles rather than waiting forever when there is no signed-in user', () => {
    // The capability query is disabled without a user, so it never resolves —
    // a gate that waited on it would hold "Loading…" for good. This pins that
    // the gate is total, not a user-facing route: on the real `/admin` a
    // signed-out visitor is redirected to /signin by RequireAuth (App.tsx) and
    // never reaches the page, so SPEC makes no promise about what they'd see.
    window.localStorage.clear();
    renderWithProviders(<AdminPage />, { route: '/admin' });

    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByText(/don.t have access/i)).toBeInTheDocument();
  });

  // A check that couldn't RUN is not a denial (Codex P2 on #633). With the
  // backend down, `useCapabilities` is still sitting on its `admin: false`
  // default — reading that as a verdict tells an operator they've lost access
  // because their connection dropped, and offers no way to try again.
  it('reports a failed access check as a failure with a Retry, not as a denial', async () => {
    class DownSource extends MockDataSource {
      override async getCapabilities(): Promise<Capabilities> {
        throw new Error('capabilities unreachable');
      }
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderWithProviders(<AdminPage />, {
      source: new DownSource(`test-${Math.random()}`),
      route: '/admin',
      queryClient,
    });

    expect(
      await screen.findByRole('button', { name: 'Retry' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/don.t have access/i)).toBeNull();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  // The other half of that: a refetch failing OVER a cached result leaves both
  // `data` and `isError` set, and there the cached answer wins. The gate tells
  // an answer from the `admin: false` default — not fresh from stale — so an
  // admin whose connection dropped keeps their console rather than being handed
  // a "couldn't check your access" panel. (The server re-checks `is_admin()` on
  // every admin RPC, so a stale-open console can't actually do anything.)
  it('keeps a cached answer when a later access check fails', async () => {
    let attempt = 0;
    class FlakySource extends MockDataSource {
      override async getCapabilities(): Promise<Capabilities> {
        attempt += 1;
        if (attempt === 1) {
          return { family: true, admin: true, allowlistArmed: true };
        }
        throw new Error('capabilities unreachable');
      }
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderWithProviders(<AdminPage />, {
      source: new FlakySource(`test-${Math.random()}`),
      route: '/admin',
      queryClient,
    });

    // First read lands: the console renders.
    await screen.findByRole('link', { name: /manage users/i });

    // A later check fails over that cached result.
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: CAPABILITIES_QUERY_KEY });
    });

    expect(screen.getByRole('link', { name: /manage users/i })).toBeInTheDocument();
    expect(screen.queryByText(/don.t have access/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
