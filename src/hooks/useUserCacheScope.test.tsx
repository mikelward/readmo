import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { useUserCacheScope } from './useUserCacheScope';
import { itemStateKey, rqCacheKey } from '../lib/userCache';

const DEMO_UID = 'mock:demo@readmo.app';

describe('useUserCacheScope', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('clears the query cache and purges the departing user on sign-out', () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () => {
        useUserCacheScope();
        return useAuth();
      },
      { wrapper },
    );

    // Normalise to a signed-in baseline (prevUid === DEMO_UID, no transition).
    act(() => result.current.signIn());

    // Seed the departing user's in-memory + persisted state.
    queryClient.setQueryData(['feed'], { secret: 1 });
    window.localStorage.setItem(rqCacheKey(DEMO_UID), 'blob');
    window.localStorage.setItem(itemStateKey(DEMO_UID), 'state');
    (caches.delete as ReturnType<typeof vi.fn>).mockClear();

    act(() => result.current.signOut());

    // In-memory cache emptied so nothing paints for the next user.
    expect(queryClient.getQueryData(['feed'])).toBeUndefined();
    // The departing user's persisted stores are purged.
    expect(window.localStorage.getItem(rqCacheKey(DEMO_UID))).toBeNull();
    expect(window.localStorage.getItem(itemStateKey(DEMO_UID))).toBeNull();
    // Named Workbox runtime caches are dropped.
    expect(caches.delete).toHaveBeenCalledWith('readmo-data');
    expect(caches.delete).toHaveBeenCalledWith('readmo-images');
    expect(caches.delete).toHaveBeenCalledWith('readmo-favicons');
  });
});
