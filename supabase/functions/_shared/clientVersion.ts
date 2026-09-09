// Minimum-client-version gate for the browser-invoked Edge Functions.
//
// The app stamps every Supabase request with `x-readmo-build: <commitCount>`
// (buildInfo.commitCount — a monotonic build number that increments on each
// merge to main; see src/lib/supabase/client.ts). When a shipped build turns
// out to hammer the backend (e.g. a feed-invalidation refetch loop that pounds
// the `feed_items` read RPC), the operator raises the floor past that build via
// the MIN_CLIENT_BUILD secret and old clients are turned away with 426 Upgrade
// Required — without a redeploy, and without touching well-behaved current
// clients (you are always on the newest build, so the gate never bites you).
//
// Scope: this in-code gate only covers the Edge Functions. The direct PostgREST
// read RPC (`feed_items`) — the heavier path, and the one a refetch loop
// actually pounds — has no Edge Function in front of it. The SAME
// `x-readmo-build` header lets a gateway (Cloudflare) reject old builds on that
// path too, before Postgres, with one header-match rule. See SPEC "Polling".
//
// Cost/reliability (guardrail #5): negligible — a header parse and an integer
// compare, no network, no DB.

export const CLIENT_BUILD_HEADER = 'x-readmo-build';

/** Parse the build number a client claims. Returns null if absent or garbage. */
export function parseClientBuild(header: string | null | undefined): number | null {
  if (header == null) return null;
  const trimmed = String(header).trim();
  if (trimmed === '') return null; // Number('') is 0, not NaN — guard it.
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export interface VersionGateResult {
  allowed: boolean;
  /** The floor the caller failed (set only when blocked), for the 426 body. */
  floor?: number;
}

/**
 * Decide whether a caller's build is allowed.
 *
 * A `floor` of 0 (the default — gate disarmed) allows everything, including
 * clients that send no header, so arming the gate is a deliberate operator
 * action. Once `floor > 0`, a client that omits the header or claims a build
 * below the floor is blocked: a missing header means a build that predates the
 * header entirely, i.e. exactly the old client we want to shed.
 */
export function checkClientBuild(
  header: string | null | undefined,
  floor: number,
): VersionGateResult {
  if (!Number.isFinite(floor) || floor <= 0) return { allowed: true };
  const build = parseClientBuild(header);
  if (build === null || build < floor) return { allowed: false, floor };
  return { allowed: true };
}
