import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { clearUserCaches, consumeExplicitSignOut } from '../lib/userCache';
import { reloadApp } from '../lib/reload';

/**
 * Per-user cache scoping (AGENTS guardrail #8). Returns `true` while an auth
 * transition is in flight so the caller can gate rendering — this stops the next
 * user's first paint from reading the previous user's in-memory React-Query data
 * on a direct uid→uid switch (e.g. a Supabase session replacement with no
 * intermediate signed-out render).
 *
 * On a transition we drop the in-memory cache, purge the departing user's
 * persisted stores + named Workbox caches, and then reload. The reload re-keys
 * the singleton data source and persister (created once at boot from the boot
 * uid): without it, signing in from a signed-out boot would keep writing the
 * unscoped base store, which a later sign-out wouldn't purge.
 *
 * The persisted purge runs on an EXPLICIT sign-out and on a direct uid→uid
 * account switch — not on a session that merely dropped. supabase-js clears
 * the session when a token refresh fails, which happens routinely OFFLINE, and
 * purging then destroyed the offline cache (pinned bodies included) exactly
 * when the reader needed it, even though the same account signs right back in.
 * The kept stores are uid-scoped, so nothing leaks to another account: a
 * different user signing in later is a uid mismatch that purges via the boot
 * reconcile (the sentinel keeps pointing at the departed user).
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
    // Whether a uid→null transition is the reader signing out (purge) or the
    // session dropping on its own (keep the stores for their next sign-in).
    const explicit = uid === null && consumeExplicitSignOut();
    // Empty the in-memory cache, then reload so the new session boots with
    // correctly-scoped keys (and the boot reconcile migrates/purges as needed).
    queryClient.clear();
    // Only purge a real departing USER's persisted scope, and only when they
    // actually left (explicit sign-out, or replaced by another uid). The
    // anonymous (null) scope holds no other user's private data, and on an
    // upgrade-while-signed-out it still holds the legacy unscoped stores that
    // the post-reload boot migrates into the signed-in user's keys — purging it
    // here would delete that data before migration. The boot reconcile handles
    // the anonymous Workbox purge.
    const purge =
      departing !== null && (uid !== null || explicit)
        ? clearUserCaches(departing)
        : Promise.resolve();
    void purge.finally(reloadApp);
  }, [uid, queryClient]);

  return transitioning;
}
