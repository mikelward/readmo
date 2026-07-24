import { useCallback, useSyncExternalStore } from 'react';
import { AUTH_STORAGE_KEY, getSupabase, isSupabaseConfigured } from '../lib/supabase/client';
import { clearExplicitSignOut, markExplicitSignOut } from '../lib/userCache';

// Auth behind one stable shape: `{ user, signIn, signInWithEmail, signOut }` +
// a synchronous `getActiveUid()` for boot-time cache keying.
//
// When Supabase is configured (VITE_SUPABASE_URL/ANON_KEY present) this is the
// real session — social OAuth (Google/Discord) or a passwordless email magic
// link — otherwise it falls back to the mock path. The mock path starts
// signed-out so unconfigured deployments (e.g. Vercel preview without env vars)
// show the real sign-in page. Clicking a sign-in button (or submitting the email
// form) in mock mode sets a localStorage flag and lands the user in the mock app.

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
// Mock path (unconfigured) — unchanged PR1 behavior.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'readmo:mock-signed-in';
const CHANGE_EVENT = 'readmo:auth-changed';

const DEMO_USER: AuthUser = {
  uid: 'mock:demo@readmo.app',
  name: 'Demo Reader',
  email: 'demo@readmo.app',
  avatarUrl: null,
};

function readSignedIn(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function setSignedIn(next: boolean): void {
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
  return readSignedIn() ? DEMO_USER : null;
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
// Email sign-in helpers
// ---------------------------------------------------------------------------

/** UI bound on the passwordless send (`signInWithEmail` below). `supabaseFetch`
 * deliberately leaves `/auth/v1/` POSTs uncapped (a timed-out auth refresh would
 * spuriously null the session), so a hung OTP send would otherwise strand the
 * sign-in form in its disabled "sending" state forever. */
const EMAIL_SIGN_IN_TIMEOUT_MS = 15_000;

/** Reject if `p` hasn't settled within `ms`. Does NOT cancel `p` — the caller
 * just stops awaiting it, so the underlying send may still complete server-side
 * (harmless: GoTrue rate-limits/dedups repeat sends). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('email sign-in timed out')),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The signed-in user's id, or null when signed out. Synchronous so the boot
 * path (main.tsx) can key caches before first paint, mirroring getStoredTheme(). */
export function getActiveUid(): string | null {
  if (isSupabaseConfigured()) return readPersistedSupabaseUid();
  return readSignedIn() ? DEMO_USER.uid : null;
}

export function useAuth(): {
  user: AuthUser | null;
  /** True while a configured Supabase session is still being detected (first
   * getSession/OAuth-callback parse). Always false on the mock path. Lets gates
   * hold instead of treating "not yet known" as "signed out". */
  initializing: boolean;
  signIn: (provider?: OAuthProvider, redirectPath?: string) => void;
  /** Start a passwordless email sign-in: send a magic link to `email` that
   * lands back on `redirectPath` (default `/`) once clicked. Resolves with
   * `{ error }` — a non-null string when the request was rejected (e.g. rate
   * limited or a malformed address) so the caller can surface it. On the mock
   * (unconfigured) path no email is sent — it signs in the demo user straight
   * away, mirroring the mock OAuth buttons — and always resolves `{ error: null }`. */
  signInWithEmail: (
    email: string,
    redirectPath?: string,
  ) => Promise<{ error: string | null }>;
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
        setSignedIn(true);
      }
    },
    [configured],
  );

  const signInWithEmail = useCallback(
    async (
      email: string,
      redirectPath?: string,
    ): Promise<{ error: string | null }> => {
      if (configured) {
        const origin =
          typeof window !== 'undefined' ? window.location.origin : '';
        try {
          // Passwordless magic link. Same landing mechanism as OAuth: clicking
          // the emailed link returns to `emailRedirectTo` with the session in
          // the URL, which `detectSessionInUrl` completes (see
          // supabase/client.ts). Bounded (see EMAIL_SIGN_IN_TIMEOUT_MS) so a
          // hung send on lie-fi can't leave the form stuck disabled.
          const { error } = await withTimeout(
            getSupabase().auth.signInWithOtp({
              email,
              options: { emailRedirectTo: `${origin}${redirectPath ?? '/'}` },
            }),
            EMAIL_SIGN_IN_TIMEOUT_MS,
          );
          return { error: error ? error.message : null };
        } catch {
          // Timeout or a thrown network error — surface a single retryable
          // message so the caller restores the idle/error state (rather than
          // throwing out of here and leaving the form stuck "sending").
          return {
            error:
              'Could not send the sign-in link. Check your connection and try again.',
          };
        }
      }
      // Mock/demo path: no email is actually sent — flip straight to signed-in.
      setSignedIn(true);
      return { error: null };
    },
    [configured],
  );

  const signOut = useCallback(() => {
    // Mark the sign-out as the reader's own choice BEFORE tearing the session
    // down: useUserCacheScope purges the departing user's on-device caches only
    // for an explicit sign-out (or an account switch), not for a session that
    // dropped on its own (a failed token refresh — routine offline).
    markExplicitSignOut();
    if (configured) {
      void getSupabase()
        .auth.signOut()
        .then(({ error }) => {
          // signOut can fail BEFORE removing the local session (auth-js
          // returns early on a non-401/403/404 revoke failure — offline, an
          // auth 5xx). The reader then STAYS signed in, so the pending marker
          // must not survive to purge their caches on the next boot as if
          // they'd left (Codex P2 on #436, round 7). Clearing here is the
          // sign-out's initiator withdrawing its own not-yet-actioned marker.
          if (error) clearExplicitSignOut();
        })
        .catch(() => clearExplicitSignOut());
    } else {
      setSignedIn(false);
    }
  }, [configured]);

  return { user, initializing, signIn, signInWithEmail, signOut };
}
