import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { getActiveUid, useAuth } from './useAuth';

const DEMO_UID = 'mock:demo@readmo.app';

describe('getActiveUid', () => {
  beforeEach(() => window.localStorage.clear());

  it('returns null when signed out and the demo uid when signed in', () => {
    expect(getActiveUid()).toBeNull();
    window.localStorage.setItem('readmo:mock-signed-in', '1');
    expect(getActiveUid()).toBe(DEMO_UID);
  });
});

describe('useAuth', () => {
  beforeEach(() => window.localStorage.clear());

  it('exposes a stable uid across sign-out / sign-in', () => {
    const { result } = renderHook(() => useAuth());
    expect(result.current.user).toBeNull();
    act(() => result.current.signIn());

    const uid = result.current.user?.uid;
    expect(uid).toBe(DEMO_UID);

    act(() => result.current.signOut());
    expect(result.current.user).toBeNull();

    act(() => result.current.signIn());
    expect(result.current.user?.uid).toBe(uid);
  });
});
