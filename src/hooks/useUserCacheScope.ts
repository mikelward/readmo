import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { clearUserCaches } from '../lib/userCache';

/** Full reload so the app re-boots with the new user's scoped cache keys
 * (main.tsx keys the persister + data source from the boot uid). Guarded for
 * test/SSR environments where navigation isn't available. */
function reloadApp(): void {
  try {
    if (typeof window !== 'undefined') window.location.reload();
  } catch {
    /* navigation unavailable (jsdom/SSR) */
  }
}

/**
 * Per-user cache scoping (AGENTS guardrail #8). Returns `true` while an auth
 * transition is in flight so the caller can gate rendering — this stops the next
 * user's first paint from reading the previous user's in-memory React-Query data
 * on a direct uid→uid switch (e.g. a Supabase session replacement with no
 * intermediate signed-out render).
 *
 * On any transition (sign out, sign in, or account switch) we drop the in-memory
 * cache, purge the departing user's persisted stores + named Workbox caches, and
 * then reload. The reload re-keys the singleton data source and persister
 * (created once at boot from the boot uid): without it, signing in from a
 * signed-out boot would keep writing the unscoped base store, which a later
 * sign-out wouldn't purge.
 */
export function useUserCacheScope(): boolean {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const prevUid = useRef<string | null>(user?.uid ?? null);
  const uid = user?.uid ?? null;
  const transitioning = uid !== prevUid.current;

  useEffect(() => {
    if (uid === prevUid.current) return;
    const departing = prevUid.current;
    prevUid.current = uid;
    // Empty the in-memory cache, then purge the departing user's on-device data
    // and reload so the new session boots with correctly-scoped keys.
    queryClient.clear();
    void clearUserCaches(departing).finally(reloadApp);
  }, [uid, queryClient]);

  return transitioning;
}
