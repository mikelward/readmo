import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { NEWSHACKER_LINK_QUERY_KEY } from './useNewshackerSync';
import { clearAllReverseSyncPending } from '../lib/newshackerReverseSyncPending';

/**
 * The newshacker link for the signed-in account — used by the Settings
 * *newshacker* section to connect (store a token), disconnect, and show status.
 * Shares {@link NEWSHACKER_LINK_QUERY_KEY} with the dismissal-mirror hook, so
 * connecting/disconnecting immediately flips the mirror on/off. `supported` is
 * false against a data source (or backend) without the link methods, so the
 * section can hide rather than offer a control that no-ops.
 */
export function useNewshackerLink() {
  const ds = useDataSource();
  const client = useQueryClient();

  const query = useQuery({
    queryKey: NEWSHACKER_LINK_QUERY_KEY,
    queryFn: () =>
      ds.getNewshackerLink?.() ??
      Promise.resolve({ linked: false, supported: false }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    enabled: typeof ds.getNewshackerLink === 'function',
  });
  // `supported` comes from the backend's own answer (true only on a successful
  // `newshacker_link_status` RPC), so the section stays hidden until the backend
  // confirms 0049 is live — not merely because the client method exists. That
  // keeps a frontend-ahead-of-migration deploy from showing a dead control.
  const supported = query.data?.supported ?? false;

  const connect = useCallback(
    async (token: string): Promise<void> => {
      await ds.setNewshackerToken?.(token);
      await client.invalidateQueries({ queryKey: NEWSHACKER_LINK_QUERY_KEY });
    },
    [ds, client],
  );

  const disconnect = useCallback(async (): Promise<void> => {
    await ds.clearNewshackerLink?.();
    // No pull will run once unlinked, so drop any open-on-newshacker "syncing"
    // markers — otherwise a spinner would sit until the failsafe.
    clearAllReverseSyncPending();
    await client.invalidateQueries({ queryKey: NEWSHACKER_LINK_QUERY_KEY });
  }, [ds, client]);

  return useMemo(
    () => ({
      supported,
      linked: query.data?.linked ?? false,
      isLoading: query.isLoading,
      connect,
      disconnect,
    }),
    [supported, query.data?.linked, query.isLoading, connect, disconnect],
  );
}
