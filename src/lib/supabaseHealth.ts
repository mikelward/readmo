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

/** The `/debug` row value for the current probe state. */
export function formatSupabaseStatus(state: SupabaseProbeState): string {
  if (state.status === 'checking') return 'checking…';
  const { reachable, latencyMs } = state.health;
  return reachable ? `reachable · ${latencyMs} ms` : 'unreachable';
}
