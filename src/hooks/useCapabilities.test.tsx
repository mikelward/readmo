import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DataSourceProvider } from '../lib/data/context';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { Capabilities } from '../lib/data/DataSource';
import { CAPABILITIES_QUERY_KEY, useCapabilitiesPhase } from './useCapabilities';

/** The gate the admin pages read. Its three phases are the difference between
 * "we know" and "we're guessing", so each is pinned here rather than only
 * through a page — a page can mask a phase change behind its own state. */
function renderPhase(source: MockDataSource, queryClient: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <DataSourceProvider source={source}>
        <MemoryRouter>{children}</MemoryRouter>
      </DataSourceProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useCapabilitiesPhase(), { wrapper });
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useCapabilitiesPhase', () => {
  // The query is gated on a signed-in user.
  beforeEach(() => window.localStorage.setItem('readmo:mock-signed-in', '1'));
  afterEach(() => window.localStorage.clear());

  it('is "checking" until the first read lands, then "known"', async () => {
    const { result } = renderPhase(new MockDataSource(`t-${Math.random()}`), client());
    expect(result.current).toBe('checking');
    await waitFor(() => expect(result.current).toBe('known'));
  });

  it('is "unavailable" when the first read fails — never a denial', async () => {
    class DownSource extends MockDataSource {
      override async getCapabilities(): Promise<Capabilities> {
        throw new Error('capabilities unreachable');
      }
    }
    const { result } = renderPhase(new DownSource(`t-${Math.random()}`), client());
    await waitFor(() => expect(result.current).toBe('unavailable'));
  });

  it('is "known" when a refetch fails over a cached answer', async () => {
    // A cached answer wins: the gate separates an answer from the
    // `admin: false` DEFAULT, not fresh from stale, so an admin whose
    // connection dropped keeps their console rather than being handed
    // "couldn't check your access".
    //
    // The assertions below also pin the divergence that makes this subtle: the
    // QUERY state really does go to status 'error' with the data retained, but
    // the observer the hook reads keeps reporting success (only `query.error`
    // is set). Reading the raw state instead — the natural "fix" — is what
    // would turn this into the denial-on-a-dropped-connection bug.
    let attempt = 0;
    class FlakySource extends MockDataSource {
      override async getCapabilities(): Promise<Capabilities> {
        attempt += 1;
        if (attempt === 1) return { family: true, admin: true, allowlistArmed: true };
        throw new Error('capabilities unreachable');
      }
    }
    const queryClient = client();
    const { result } = renderPhase(new FlakySource(`t-${Math.random()}`), queryClient);
    await waitFor(() => expect(result.current).toBe('known'));

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: CAPABILITIES_QUERY_KEY });
    });

    // Both set — the state really is the contested one, not a no-op refetch.
    const state = queryClient.getQueryState(CAPABILITIES_QUERY_KEY);
    expect(state?.status).toBe('error');
    expect(state?.data).toBeTruthy();

    expect(result.current).toBe('known');
  });
});
