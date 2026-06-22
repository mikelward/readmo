import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { clearUserCaches } from '../lib/userCache';

/**
 * Per-user cache scoping (AGENTS guardrail #8). On any auth transition — sign
 * out, or sign in as a different subject — drop the in-memory query cache and
 * purge the departing user's persisted caches, so the next user on a shared
 * device never sees the previous user's content. Boot-time cache keying lives
 * in main.tsx; this handles live transitions.
 */
export function useUserCacheScope(): void {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const prevUid = useRef<string | null>(user?.uid ?? null);

  useEffect(() => {
    const uid = user?.uid ?? null;
    if (uid === prevUid.current) return;
    const departing = prevUid.current;
    prevUid.current = uid;
    // Empty the in-memory cache immediately so nothing paints for the next
    // user, then purge the departing user's on-device data.
    queryClient.clear();
    void clearUserCaches(departing);
  }, [user?.uid, queryClient]);
}
