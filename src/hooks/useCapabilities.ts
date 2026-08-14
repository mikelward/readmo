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

/** How far along the answer to "what may this caller do?" is. The admin pages
 * gate on this because `admin: false` is the *default*, not a verdict — read
 * straight, it puts "You don't have access to this page." in front of an
 * operator who has every right to be there.
 *
 *   - `'checking'` — a signed-in caller's flags are genuinely still coming: the
 *     persisted-cache restore window (React Query pins fetchStatus to 'idle'
 *     and nothing may fetch — see useFeedItems) and the first read after it.
 *   - `'unavailable'` — the read *failed*. Access was never determined, so this
 *     is an operational failure to report and retry, NOT a denial: offline or
 *     with the backend down, every admin page would otherwise accuse the
 *     operator of not having access, with no way to try again.
 *   - `'known'` — an answer is in hand, so {@link useCapabilities} is reporting
 *     a verdict rather than a default. Also covers a caller with no user at
 *     all: their query is disabled and never resolves, so waiting on it would
 *     hold the page on "Loading…" for good, and someone signed out is
 *     definitively not an admin. Nobody reaches that in practice —
 *     `RequireAuth` (App.tsx) sends a signed-out visitor to `/signin` before
 *     any admin page mounts — but a gate that can hang is worse than one that
 *     answers, so this stays total.
 */
export type CapabilitiesPhase = 'checking' | 'unavailable' | 'known';

export function useCapabilitiesPhase(): CapabilitiesPhase {
  const { user } = useAuth();
  const { data, isError } = useCapabilitiesQuery();
  if (!user) return 'known';
  // A cached answer is `known`, even if the refetch over it just failed. Two
  // things make that right, and the second is easy to get backwards (Codex P2
  // on #633 read this ordering as a bug):
  //
  //  1. This gate separates an *answer* from the `admin: false` DEFAULT — not
  //     fresh from stale. An older answer is still an answer, so an admin whose
  //     connection dropped keeps their console instead of a "couldn't check
  //     your access" panel, and a cached denial stays accurate rather than
  //     becoming a shrug. Staleness is bounded by the server, which re-checks
  //     `is_admin()` on every admin RPC (guardrail 7).
  //  2. `isError` can't contradict `data` here anyway. A background refetch
  //     that fails over existing data leaves the QUERY state at status 'error',
  //     but the observer this hook reads keeps reporting status 'success' with
  //     `isError` false — only `query.error` is set (same v5 behavior
  //     useFeedItems' `refreshFailed` relies on). So `isError` is true only
  //     when there is no data at all, which is exactly `unavailable`. The order
  //     below is therefore inert; it is written this way because the *intent*
  //     in (1) should survive a change in that library behavior.
  if (data) return 'known';
  if (isError) return 'unavailable';
  // Everything else is still in flight — including the restore window, where
  // the query is pending with `fetchStatus` held at 'idle'. No `useIsRestoring`
  // needed: "no data and no error" already covers it.
  return 'checking';
}

/** Whether reading-mode full text and AI summaries are *known* to be allowed for
 * the caller — the conservative gate the reader and offline warmer use to decide
 * whether to issue a `fulltext` / `summary` Edge call. Allowed ONLY once we've
 * resolved the caller is allowlisted (or the list is disarmed). "No resolved
 * capabilities → not allowed" covers three cases at once:
 *   - **Signed out** — the capabilities query is disabled (`enabled: !!user`), so
 *     it never resolves. These are per-account, allowlist-gated features and a
 *     signed-out caller can never be allowlisted, so they're closed, not open.
 *   - **Signed in, still loading** — don't fire Edge calls speculatively; wait
 *     until we actually know the gate (the warmer's "zero Edge calls" promise).
 *   - **Signed in, errored** — a transient `get_capabilities` failure ends with
 *     no data, which must not read as open.
 * The value is cached + persisted, so this normally only bites the very first
 * load; the server enforces the gate regardless. */
export function useFullTextAllowed(): boolean {
  const { data } = useCapabilitiesQuery();
  return data ? canUseFullText(data) : false;
}
