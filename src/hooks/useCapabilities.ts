import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useAuth } from './useAuth';
import type { Capabilities } from '../lib/data/DataSource';

/** React Query key for the signed-in user's capability flags. Persisted +
 * user-scoped by the main.tsx persister (keyed by bootUid) and purged on any
 * auth change by useUserCacheScope (guardrail #8), so one user's flags never
 * leak to the next on a shared device. The offline warmer reads it directly via
 * `queryClient.getQueryData(CAPABILITIES_QUERY_KEY)`. */
export const CAPABILITIES_QUERY_KEY = ['capabilities'] as const;

/** Safe default before the first resolve / while signed out: no chip, no admin,
 * and (since allowlistArmed is false) full text is allowed — the gate is open
 * until we learn otherwise, and the server enforces it regardless. */
export const DEFAULT_CAPABILITIES: Capabilities = {
  family: false,
  admin: false,
  allowlistArmed: false,
};

/** Whether the caller may use reading-mode full text: when the allowlist is
 * disarmed everyone can; when armed, only family. Lets the reader and the
 * offline warmer skip the gated `fulltext` call entirely for off-list users
 * (no request amplification) — the `retryable` denial stays the backstop for
 * the moment capabilities flip. */
export function canUseFullText(caps: Capabilities): boolean {
  return !caps.allowlistArmed || caps.family;
}

/** The capability query itself (shared key → React Query dedupes). Cached for
 * 5 min and refetched on reconnect, since membership only changes by a rare
 * operator/admin action. Enabled only for a signed-in user. */
export function useCapabilitiesQuery() {
  const ds = useDataSource();
  const { user } = useAuth();
  return useQuery({
    queryKey: CAPABILITIES_QUERY_KEY,
    queryFn: () => ds.getCapabilities(),
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    refetchOnReconnect: true,
  });
}

/** The signed-in user's capability flags. Returns the safe default until the
 * query resolves (or while signed out). */
export function useCapabilities(): Capabilities {
  return useCapabilitiesQuery().data ?? DEFAULT_CAPABILITIES;
}

/** Whether reading-mode full text is *known* to be allowed for the caller — the
 * conservative gate the reader and offline warmer use to decide whether to issue
 * a `fulltext` Edge call. Unlike `canUseFullText(useCapabilities())`, this does
 * NOT treat an unresolved gate as open: while a signed-in user's capabilities
 * are still loading — or have errored without resolving — we return `false`, so
 * an off-list user on an armed allowlist doesn't fire `fulltext` calls before we
 * know the gate (the warmer's "zero Edge calls" promise). The value is cached +
 * persisted, so this normally only bites the very first load; the server
 * enforces the gate regardless. A disabled query (signed out, or not yet
 * enabled) has no gate to wait on, so it defaults open — matching today's
 * behavior, incl. against an old backend. */
export function useFullTextAllowed(): boolean {
  const { user } = useAuth();
  const { data } = useCapabilitiesQuery();
  if (data) return canUseFullText(data);
  // No resolved capabilities yet. For a SIGNED-IN user the query is enabled and
  // we're in a loading OR errored state — either way stay closed (don't resume
  // Edge calls until we actually know the gate; a transient `get_capabilities`
  // failure ends 'idle' with no data, which must not read as open). Signed out →
  // the query is disabled, there's no gate to wait on, so default open (matches
  // today, incl. against an old backend).
  return !user;
}
