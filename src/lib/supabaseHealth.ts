/** Live reachability of the Supabase backend, for the `/debug` Runtime section.
 *
 * Mirrors newshacker's `/debug` Services line (`reachable · <latency> ms`) but
 * probed client-side against GoTrue's `/auth/v1/health` — the same always-up,
 * in-process liveness endpoint the connectivity tracker uses (networkStatus.ts),
 * which doesn't query Postgres. So the probe reflects "can we reach the backend"
 * without loading the DB, and is $0/negligible: one tiny GET per `/debug` view.
 */

export interface SupabaseHealth {
  /** Any HTTP response (even 4xx/5xx) means reachable — it proves we reached the
   * server. Only a network failure or timeout is "unreachable". */
  reachable: boolean;
  /** Round-trip time of the probe, in whole milliseconds. */
  latencyMs: number;
}

/** Short ceiling so an unreachable backend resolves the row promptly rather than
 * hanging on "checking…". Matches the connectivity probe's cap. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe the Supabase health endpoint once. Uses plain `fetch` (not
 * `trackedFetch`) on purpose: a diagnostic probe must never flip the app's
 * connectivity pill. `now` is injectable so tests can assert latency without a
 * real clock.
 */
export async function probeSupabaseHealth(
  healthUrl: string,
  now: () => number = () => performance.now(),
): Promise<SupabaseHealth> {
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(healthUrl, { method: 'GET', signal: controller.signal });
    return { reachable: true, latencyMs: Math.round(now() - started) };
  } catch {
    return { reachable: false, latencyMs: Math.round(now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

export type SupabaseProbeState =
  | { status: 'checking' }
  | { status: 'done'; health: SupabaseHealth };

/** Glanceable status-badge color for a `/debug` row: `ok` (green), `down`
 * (red), or `idle` (neutral gray, for "no opinion" states like checking or
 * not-configured). Mirrors newshacker's badge states. */
export type StatusBadge = 'ok' | 'down' | 'idle';

/**
 * The `/debug` Supabase row: its detail text and status badge. `null` means the
 * project isn't configured (mock mode) — the row still shows, with a neutral
 * badge, rather than disappearing, so the backend's state is always glanceable.
 */
export function describeSupabase(state: SupabaseProbeState | null): {
  value: string;
  badge: StatusBadge;
} {
  if (state === null) return { value: 'not configured (mock data)', badge: 'idle' };
  if (state.status === 'checking') return { value: 'checking…', badge: 'idle' };
  const { reachable, latencyMs } = state.health;
  return reachable
    ? { value: `reachable · ${latencyMs} ms`, badge: 'ok' }
    : { value: 'unreachable', badge: 'down' };
}
