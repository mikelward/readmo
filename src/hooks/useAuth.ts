import { useCallback, useSyncExternalStore } from 'react';

// PR1 mock auth. The real Supabase OAuth session lands in PR2 behind this
// same hook shape (user | null, signOut). The mock defaults to a signed-in
// demo user so the reading UX is immediately usable; signing out flips to the
// signed-out state that routes to /signin.

export interface AuthUser {
  name: string;
  email: string;
  avatarUrl: string | null;
}

const STORAGE_KEY = 'readmo:mock-signed-out';
const CHANGE_EVENT = 'readmo:auth-changed';

const DEMO_USER: AuthUser = {
  name: 'Demo Reader',
  email: 'demo@readmo.app',
  avatarUrl: null,
};

function readSignedOut(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

let signedOut = readSignedOut();

function subscribe(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}

function setSignedOut(next: boolean): void {
  signedOut = next;
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, '1');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useAuth(): {
  user: AuthUser | null;
  signIn: () => void;
  signOut: () => void;
} {
  const isSignedOut = useSyncExternalStore(
    subscribe,
    () => signedOut,
    () => signedOut,
  );

  const signIn = useCallback(() => setSignedOut(false), []);
  const signOut = useCallback(() => setSignedOut(true), []);

  return { user: isSignedOut ? null : DEMO_USER, signIn, signOut };
}
