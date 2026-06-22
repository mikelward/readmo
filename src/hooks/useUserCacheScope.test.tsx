import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { useUserCacheScope } from './useUserCacheScope';
import { itemStateKey, rqCacheKey } from '../lib/userCache';
import { reloadApp } from '../lib/reload';

// Mock the reload wrapper so we don't have to touch jsdom's non-configurable
// window.location.
vi.mock('../lib/reload', () => ({ reloadApp: vi.fn() }));

const DEMO_UID = 'mock:demo@readmo.app';

describe('useUserCacheScope', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
    vi.mocked(reloadApp).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gates rendering, purges the departing user, and reloads on sign-out', async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({ transitioning: useUserCacheScope(), auth: useAuth() }),
      { wrapper },
    );

    // Signed-in baseline: no transition in flight.
    expect(result.current.transitioning).toBe(false);

    // Seed the departing user's in-memory + persisted state.
    queryClient.setQueryData(['feed'], { secret: 1 });
    window.localStorage.setItem(rqCacheKey(DEMO_UID), 'blob');
    window.localStorage.setItem(itemStateKey(DEMO_UID), 'state');

    act(() => result.current.auth.signOut());

    // Gate flips on so the caller renders nothing during the transition.
    expect(result.current.transitioning).toBe(true);
    // In-memory cache emptied so nothing paints for the next user.
    expect(queryClient.getQueryData(['feed'])).toBeUndefined();
    // The departing user's persisted stores are purged.
    expect(window.localStorage.getItem(rqCacheKey(DEMO_UID))).toBeNull();
    expect(window.localStorage.getItem(itemStateKey(DEMO_UID))).toBeNull();
    // Named Workbox runtime caches are dropped.
    expect(caches.delete).toHaveBeenCalledWith('readmo-data');
    expect(caches.delete).toHaveBeenCalledWith('readmo-images');
    expect(caches.delete).toHaveBeenCalledWith('readmo-favicons');
    // ...then the app reloads to re-key the data source/persister.
    await waitFor(() => expect(reloadApp).toHaveBeenCalledTimes(1));
  });
});
