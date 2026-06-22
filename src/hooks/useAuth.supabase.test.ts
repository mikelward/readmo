import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Drive the *configured* branch of useAuth by mocking the client module so
// isSupabaseConfigured() is true and getSupabase() returns a fake auth client.
const h = vi.hoisted(() => {
  const state: { cb: ((e: string, s: unknown) => void) | null } = { cb: null };
  const fakeAuth = {
    getSession: vi.fn(async () => ({ data: { session: null } })),
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
