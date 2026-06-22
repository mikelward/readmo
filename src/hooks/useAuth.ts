import { useCallback, useSyncExternalStore } from 'react';
import { AUTH_STORAGE_KEY, getSupabase, isSupabaseConfigured } from '../lib/supabase/client';

// Auth behind one stable shape: `{ user, signIn, signOut }` + a synchronous
// `getActiveUid()` for boot-time cache keying.
//
// When Supabase is configured (VITE_SUPABASE_URL/ANON_KEY present) this is the
// real OAuth session; otherwise it falls back to the PR1 mock demo user, so
// existing tests and backend-less local/mock dev keep working and the app is
// never stranded at /signin.

export type OAuthProvider = 'google' | 'discord';

export interface AuthUser {
  /** Stable subject id used to scope on-device caches (guardrail #8). Supabase
   * `auth.uid()` when configured; a fixed mock id otherwise. */
  uid: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

// ---------------------------------------------------------------------------
// Mock path (unconfigured) — unchanged PR1 behaviour.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'readmo:mock-signed-out';
const CHANGE_EVENT = 'readmo:auth-changed';

const DEMO_USER: AuthUser = {
  uid: 'mock:demo@readmo.app',
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

function setSignedOut(next: boolean): void {
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, '1');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribeMock(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}

// getSnapshot must return referentially-stable values; DEMO_USER and null are
// both constants, so React never sees a spurious snapshot change.
function getMockUser(): AuthUser | null {
  return readSignedOut() ? null : DEMO_USER;
}

// ---------------------------------------------------------------------------
// Supabase path (configured) — real OAuth session.
// ---------------------------------------------------------------------------

interface SessionUserLike {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

function mapSessionUser(u: SessionUserLike | null | undefined): AuthUser | null {
  if (!u) return null;
  const meta = u.user_metadata ?? {};
  const str = (k: string): string | null =>
    typeof meta[k] === 'string' ? (meta[k] as string) : null;
  return {
    uid: u.id,
    name: str('full_name') ?? str('name') ?? u.email ?? 'Reader',
    email: u.email ?? '',
    avatarUrl: str('avatar_url') ?? str('picture'),
  };
}

let supabaseUser: AuthUser | null = null;
let supabaseUserSeeded = false;
// True once the first getSession()/onAuthStateChange has resolved. Drives the
// `initializing` flag so RequireAuth can hold a protected route while a fresh
// OAuth callback session is still being detected (rather than bouncing to
// /signin before it lands).
let supabaseInitialized = false;
const supabaseListeners = new Set<() => void>();
let subscribedToSupabase = false;

function notifySupabase(): void {
  for (const l of supabaseListeners) l();
}

function sameUser(a: AuthUser | null, b: AuthUser | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.uid === b.uid &&
    a.name === b.name &&
    a.email === b.email &&
    a.avatarUrl === b.avatarUrl
  );
}

function setSupabaseUser(next: AuthUser | null): void {
  // An authoritative value from getSession()/onAuthStateChange also satisfies
  // the seed, so a later first getSnapshot won't re-read (and clobber) it.
  supabaseUserSeeded = true;
  const initFlip = !supabaseInitialized;
  supabaseInitialized = true;
  // Keep the reference stable when nothing material changed so a token refresh
  // (which re-fires onAuthStateChange) doesn't churn the useSyncExternalStore
  // snapshot. Still notify if `initialized` just flipped (e.g. getSession
  // resolved to no session: user stays null but `initializing` must update).
  if (sameUser(supabaseUser, next)) {
    if (initFlip) notifySupabase();
    return;
  }
  supabaseUser = next;
  notifySupabase();
}

function ensureSupabaseSubscription(): void {
  if (subscribedToSupabase) return;
  subscribedToSupabase = true;
  const supabase = getSupabase();
  // Initial load: pick up a persisted session and any OAuth redirect hash.
  void supabase.auth
    .getSession()
    .then(({ data }) =>
      setSupabaseUser(mapSessionUser(data.session?.user ?? null)),
    )
    .catch(() => setSupabaseUser(null));
  supabase.auth.onAuthStateChange((_event, session) =>
    setSupabaseUser(mapSessionUser(session?.user ?? null)),
  );
}

function subscribeSupabase(cb: () => void): () => void {
  ensureSupabaseSubscription();
  supabaseListeners.add(cb);
  return () => {
    supabaseListeners.delete(cb);
  };
}

function getSupabaseUser(): AuthUser | null {
  // Seed synchronously from the persisted session on the very first snapshot, so
  // a returning signed-in user's first render is already signed-in. Without this
  // the first snapshot is null until the async getSession() resolves, and
  // RequireAuth would bounce to /signin while useUserCacheScope sees a null->uid
  // transition and reloads — which resets module state to null and loops.
  if (!supabaseUserSeeded) {
    supabaseUserSeeded = true;
    supabaseUser = readPersistedSupabaseUser();
  }
  return supabaseUser;
}

function getSupabaseInitialized(): boolean {
  return supabaseInitialized;
}

/** Synchronously parse the persisted Supabase session. Defensive about the
 * stored shape (supabase-js has stored the session both directly and under
 * `currentSession`). */
function readPersistedSession(): SessionUserLike | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      user?: SessionUserLike;
      currentSession?: { user?: SessionUserLike };
    };
    const user = parsed.user ?? parsed.currentSession?.user;
    return user && typeof user.id === 'string' ? user : null;
  } catch {
    return null;
  }
}

function readPersistedSupabaseUid(): string | null {
  return readPersistedSession()?.id ?? null;
}

function readPersistedSupabaseUser(): AuthUser | null {
  return mapSessionUser(readPersistedSession());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The signed-in user's id, or null when signed out. Synchronous so the boot
 * path (main.tsx) can key caches before first paint, mirroring getStoredTheme(). */
export function getActiveUid(): string | null {
  if (isSupabaseConfigured()) return readPersistedSupabaseUid();
  return readSignedOut() ? null : DEMO_USER.uid;
}

export function useAuth(): {
  user: AuthUser | null;
  /** True while a configured Supabase session is still being detected (first
   * getSession/OAuth-callback parse). Always false on the mock path. Lets gates
   * hold instead of treating "not yet known" as "signed out". */
  initializing: boolean;
  signIn: (provider?: OAuthProvider, redirectPath?: string) => void;
  signOut: () => void;
} {
  const configured = isSupabaseConfigured();

  const user = useSyncExternalStore(
    configured ? subscribeSupabase : subscribeMock,
    configured ? getSupabaseUser : getMockUser,
    () => null,
  );

  // Reactive init flag (configured path only); the same subscription drives it.
  const initialized = useSyncExternalStore(
    configured ? subscribeSupabase : subscribeMock,
    configured ? getSupabaseInitialized : () => true,
    () => true,
  );
  const initializing = configured && !initialized;

  const signIn = useCallback(
    (provider: OAuthProvider = 'google', redirectPath?: string) => {
      if (configured) {
        const origin =
          typeof window !== 'undefined' ? window.location.origin : '';
        void getSupabase().auth.signInWithOAuth({
          provider,
          options: { redirectTo: `${origin}${redirectPath ?? '/'}` },
        });
      } else {
        setSignedOut(false);
      }
    },
    [configured],
  );

  const signOut = useCallback(() => {
    if (configured) void getSupabase().auth.signOut();
    else setSignedOut(true);
  }, [configured]);

  return { user, initializing, signIn, signOut };
}
