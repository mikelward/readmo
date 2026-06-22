import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Drive the *configured* branch of useAuth by mocking the client module so
// isSupabaseConfigured() is true and getSupabase() returns a fake auth client.
const h = vi.hoisted(() => {
  const state: { cb: ((e: string, s: unknown) => void) | null } = { cb: null };
  const fakeAuth = {
    getSession: vi.fn(
      async (): Promise<{ data: { session: { user: unknown } | null } }> => ({
        data: { session: null },
      }),
    ),
    onAuthStateChange: (fn: (e: string, s: unknown) => void) => {
      state.cb = fn;
      return { data: { subscription: { unsubscribe() {} } } };
    },
    signInWithOAuth: vi.fn(async () => ({ data: {}, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
  };
  return { state, fakeAuth };
});

vi.mock('../lib/supabase/client', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: () => ({ auth: h.fakeAuth }),
  AUTH_STORAGE_KEY: 'readmo:sb-auth',
}));

import { getActiveUid, useAuth } from './useAuth';

describe('getActiveUid (Supabase configured)', () => {
  beforeEach(() => window.localStorage.clear());

  it('reads the uid synchronously from the persisted session', () => {
    expect(getActiveUid()).toBeNull();
    window.localStorage.setItem(
      'readmo:sb-auth',
      JSON.stringify({ user: { id: 'u-xyz' } }),
    );
    expect(getActiveUid()).toBe('u-xyz');
  });

  it('tolerates the legacy currentSession shape and garbage', () => {
    window.localStorage.setItem(
      'readmo:sb-auth',
      JSON.stringify({ currentSession: { user: { id: 'u-legacy' } } }),
    );
    expect(getActiveUid()).toBe('u-legacy');
    window.localStorage.setItem('readmo:sb-auth', 'not json');
    expect(getActiveUid()).toBeNull();
  });

  it('seeds the first useAuth() snapshot from the persisted session (no null flash)', async () => {
    // A returning signed-in user: session already in localStorage before boot.
    window.localStorage.setItem(
      'readmo:sb-auth',
      JSON.stringify({
        user: { id: 'u-boot', email: 'boot@example.com', user_metadata: { name: 'Boot' } },
      }),
    );
    // getSession() confirms the same user, so the async resolve is a no-op on
    // the snapshot (sameUser guard) — the assertion is about the seeded first
    // render either way.
    h.fakeAuth.getSession.mockResolvedValueOnce({
      data: {
        session: {
          user: { id: 'u-boot', email: 'boot@example.com', user_metadata: { name: 'Boot' } },
        },
      },
    });
    // Fresh module instance so the one-time lazy seed runs against this storage.
    vi.resetModules();
    const { useAuth: freshUseAuth } = await import('./useAuth');
    const { result } = renderHook(() => freshUseAuth());
    // The very first committed snapshot is already signed-in — not null.
    expect(result.current.user).toEqual({
      uid: 'u-boot',
      name: 'Boot',
      email: 'boot@example.com',
      avatarUrl: null,
    });
  });
});

describe('useAuth (Supabase configured)', () => {
  afterEach(() => vi.clearAllMocks());

  it('maps the session user and wires signIn/signOut to OAuth', () => {
    const { result } = renderHook(() => useAuth());

    act(() => {
      h.state.cb?.('SIGNED_IN', {
        user: {
          id: 'u1',
          email: 'ann@example.com',
          user_metadata: { full_name: 'Ann', avatar_url: 'https://a/x.png' },
        },
      });
    });

    expect(result.current.user).toEqual({
      uid: 'u1',
      name: 'Ann',
      email: 'ann@example.com',
      avatarUrl: 'https://a/x.png',
    });

    act(() => result.current.signIn('github', '/pinned'));
    expect(h.fakeAuth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'github',
      options: { redirectTo: `${window.location.origin}/pinned` },
    });

    act(() => result.current.signOut());
    expect(h.fakeAuth.signOut).toHaveBeenCalled();

    act(() => h.state.cb?.('SIGNED_OUT', null));
    expect(result.current.user).toBeNull();
  });
});
