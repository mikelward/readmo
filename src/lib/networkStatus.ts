import { onlineManager } from '@tanstack/react-query';

// `navigator.onLine` on mobile lags badly behind what users perceive as
// "offline" — stepping into a tunnel can leave it stuck at `true` for
// tens of seconds, because the OS only flips it once the radio has
// fully given up. We can do better: every fetch the app makes is a
// probe for whether we can reach the network right now. Route those
// through this tracker so the offline indicator reacts the instant a
// real request fails, instead of waiting for the OS to notice.
//
// We keep two independent signals and AND them: either one reporting
// offline means offline. That way a successful SW-served fetch while
// the browser says offline doesn't falsely flip the pill back on, and
// a spurious navigator.onLine=true while every real request is failing
// doesn't either. Both have to agree "online" before we consider
// ourselves online.

type Listener = (online: boolean) => void;

// A request failing tells us our backend wasn't reachable on the last try — it
// does NOT tell us the device has no network. Those are different problems with
// different fixes (wait for the server vs. find a connection), so we surface
// them as distinct states instead of one blanket "Offline":
//   - 'online'              — both signals agree we're connected.
//   - 'offline'             — the device itself reports no network
//                             (navigator.onLine === false). The user's problem.
//   - 'backend-unreachable' — the device has a connection but our backend isn't
//                             answering (overloaded / erroring / behind a CDN
//                             returning a CORS-less 5xx, which surfaces as a
//                             TypeError). Readmo's problem, not theirs. Shown as
//                             "Down", not "Offline", so we stop telling users
//                             they're offline when the server is the one that's
//                             struggling.
// Caveat: navigator.onLine lags on mobile (see the header comment), so in the
// brief window after a genuine disconnect where the OS still says online, a
// failed fetch reads as 'backend-unreachable' until the 'offline' event lands.
// We accept blaming the server during that ambiguous window rather than the
// reverse (a server outage mislabeled as the user being offline), which was the
// bug this replaces.
export type ConnectivityStatus = 'online' | 'offline' | 'backend-unreachable';

type StatusListener = (status: ConnectivityStatus) => void;

function initialBrowserOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

let browserOnline: boolean = initialBrowserOnline();
let fetchOnline: boolean = true;

function computeStatus(): ConnectivityStatus {
  if (browserOnline && fetchOnline) return 'online';
  // A device that reports no network is offline regardless of fetch state —
  // the device signal wins, since "find a connection" is the actionable fix.
  if (!browserOnline) return 'offline';
  // Browser says connected, but our last fetch failed: the backend is the
  // problem, not the connection.
  return 'backend-unreachable';
}

let lastStatus: ConnectivityStatus = computeStatus();
// Boolean subscribers (the legacy `online` signal) only care about the
// online/not-online edge; status subscribers see every transition, including
// 'offline' <-> 'backend-unreachable' (where the boolean stays false).
const listeners = new Set<Listener>();
const statusListeners = new Set<StatusListener>();

// A self-imposed read *timeout* (supabaseFetch aborts a hung read after 15s)
// is ambiguous: the device may be offline, or the backend may just be slow —
// e.g. the DB pegged and the feed RPC not answering in time. Rather than guess
// "offline" (the old behavior, which painted a wrong Offline pill whenever the
// DB was overloaded), we probe a lightweight reachability endpoint to decide.
//
// The probe URL is injected by the Supabase client (client.ts) once it knows
// the project URL; GoTrue's `/auth/v1/health` is an in-process liveness check
// that does NOT query Postgres, so it stays responsive even when the DB is
// saturated — exactly the signal that separates "backend slow" from "offline".
// Unset (mock/unconfigured mode) → fall back to the conservative legacy
// behavior and treat a timeout as offline.
let probeUrl: string | null = null;
let probeInFlight = false;
// successSeq is bumped on every reported success. `probeBaselineSeq` captures it
// as of the most recent timeout under adjudication: a probe only flips us
// offline if no success has landed *since that timeout*. A timeout that arrives
// after a success (even while an earlier probe is still running) refreshes this
// baseline, so it is re-adjudicated rather than silently coalesced away.
let successSeq = 0;
let probeBaselineSeq = 0;

// Short ceiling for the reachability probe — well under the 15s read cap so a
// genuine offline flips the pill promptly rather than waiting a second 15s.
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Register the reachability-probe endpoint (called by the Supabase client at
 * init). Pass `null` to disable probing (mock/unconfigured mode), in which case
 * a read timeout falls back to being treated as offline.
 */
export function setConnectivityProbeUrl(u: string | null) {
  probeUrl = u;
}

function emitIfChanged() {
  const next = computeStatus();
  if (next === lastStatus) return;
  const wasOnline = lastStatus === 'online';
  const isOnline = next === 'online';
  lastStatus = next;
  // Status subscribers see every transition (e.g. 'offline' -> 'backend-
  // unreachable'); boolean subscribers + onlineManager only fire on the
  // online/not-online edge so query pausing/resume behaves exactly as before.
  for (const fn of statusListeners) fn(next);
  if (wasOnline === isOnline) return;
  for (const fn of listeners) fn(isOnline);
  // Keep React Query's own onlineManager in sync so paused queries
  // resume when we reconnect (belt-and-braces with networkMode:
  // 'offlineFirst' — that mode prevents hanging, this keeps
  // refetch-on-reconnect working).
  onlineManager.setOnline(isOnline);
}

export function getOnline(): boolean {
  return computeStatus() === 'online';
}

export function getConnectivityStatus(): ConnectivityStatus {
  return computeStatus();
}

export function subscribeOnline(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function subscribeConnectivityStatus(fn: StatusListener): () => void {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

export function reportFetchSuccess() {
  // Bump unconditionally (even when already online) so a probe started before
  // this success can detect it and skip flipping us offline.
  successSeq++;
  if (fetchOnline) return;
  fetchOnline = true;
  emitIfChanged();
}

export function reportFetchFailure(err: unknown): Promise<void> | void {
  // A read timeout is ambiguous (offline vs. slow/overloaded backend). Don't
  // flip the pill on the timeout alone — probe reachability and decide there.
  if (isTimeout(err)) return maybeProbeAfterTimeout();
  if (!isHardNetworkError(err)) return;
  goOffline();
}

function goOffline() {
  if (!fetchOnline) return;
  fetchOnline = false;
  emitIfChanged();
}

/**
 * Resolve the ambiguity of a read timeout. If a lightweight probe reaches the
 * backend, the device is online and the read just timed out on a slow/overloaded
 * server — stay (or come back) online; the feed view shows its own "Couldn't
 * load" / Retry. If the probe also fails, we're genuinely unreachable — flip to
 * offline. Runs even when already offline, since a timeout whose probe succeeds
 * is how we recover a stuck Offline pill on reconnect-while-the-DB-is-slow (no
 * real read succeeds to fire reportFetchSuccess in that window).
 */
async function maybeProbeAfterTimeout(): Promise<void> {
  // No probe target (mock/unconfigured): conservative legacy behavior.
  if (probeUrl == null) return void goOffline();
  // Rebase adjudication on THIS timeout's view of connectivity, so a probe
  // already in flight re-judges against the latest timeout rather than the one
  // that started it (a post-success timeout must not be coalesced into — and
  // then suppressed by — a probe started before that success).
  probeBaselineSeq = successSeq;
  if (probeInFlight) return;
  probeInFlight = true;
  try {
    // Any HTTP response — even a 4xx/5xx — proves we reached the server, so the
    // device is online and the backend is merely slow. Plain `fetch` (not
    // trackedFetch) to avoid a recursive probe loop on the probe's own timeout.
    await fetch(probeUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Reaching the backend is positive evidence of connectivity: keep us online,
    // and clear the pill if a prior hard failure had flipped it off.
    reportFetchSuccess();
  } catch {
    // Probe failed too → genuinely unreachable, unless a real success landed
    // since the latest timeout (then we're online and this probe is stale).
    if (probeBaselineSeq === successSeq) goOffline();
  } finally {
    probeInFlight = false;
  }
}

/**
 * Actively confirm the backend is reachable *right now*, bypassing the service
 * worker. The probe hits the same liveness endpoint as the timeout adjudicator
 * (`/auth/v1/health`), which lives on `/auth/v1/` — outside the SW's
 * `/rest/v1/` NetworkFirst route — so Workbox never answers it from cache. A
 * feed read, by contrast, the SW *can* answer from a stale empty `200` while the
 * backend is down (the read's 15s cap deliberately sits past the SW's 10s
 * cache-fallback window), which `trackedFetch` then reads as success → `online`.
 * Callers use this to verify an *empty* feed read came from a live server before
 * trusting it as "all caught up": a cache-served empty page would otherwise lie.
 *
 * The outcome is reported into the tracker so the connectivity status reflects
 * it — a failed probe flips us to backend-unreachable (or offline). Returns true
 * iff the backend answered. Unconfigured (no probe URL — mock/local dev with no
 * remote backend to be down) returns true: the mock source is authoritative.
 */
export async function confirmBackendReachable(): Promise<boolean> {
  if (probeUrl == null) return true;
  // Manual controller + clearTimeout (rather than AbortSignal.timeout) so the
  // timer is released the instant the probe settles — an AbortSignal.timeout
  // keeps its timer running until it fires, which leaks a pending macrotask past
  // the caller (and across test files).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // Plain `fetch` (not trackedFetch) — this IS the probe, so don't recurse;
    // any HTTP response proves we reached the server.
    await fetch(probeUrl, { method: 'GET', signal: controller.signal });
    reportFetchSuccess();
    return true;
  } catch {
    // Couldn't reach the backend → the empty read was a stale cache hit (or the
    // server is down). Flip the pill; the caller surfaces the miss-state.
    goOffline();
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'TimeoutError';
}

function isHardNetworkError(err: unknown): boolean {
  // AbortError is a caller cancelling the request (React Query does
  // this when a query is superseded), not a signal about connectivity.
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  if (err instanceof Error && err.name === 'AbortError') return false;
  if (err instanceof DOMException && err.name === 'NetworkError') return true;
  // fetch throws TypeError for all network-layer failures: DNS,
  // unreachable host, dropped connection, CORS preflight fail. Some
  // runtimes surface the same failures as DOMException/Error names or
  // messages instead, so match the common cross-browser strings too.
  // Any of those reasonably mean "not online right now".
  if (err instanceof TypeError) return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('failed to fetch') ||
      msg.includes('fetch failed') ||
      msg.includes('load failed') ||
      msg.includes('networkerror') ||
      msg.includes('network request failed') ||
      msg.includes('network connection was lost') ||
      msg.includes('internet connection appears to be offline')
    ) {
      return true;
    }
  }
  return false;
}

export async function trackedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    const res = await fetch(input, init);
    // Any HTTP response — even a 500 — proves we reached a server, so
    // treat it as evidence the fetch side is healthy. The browser may
    // still disagree (e.g. just after firing an 'offline' event while
    // the SW served a cache hit), and in that case we stay offline
    // until both signals line up.
    reportFetchSuccess();
    return res;
  } catch (err) {
    reportFetchFailure(err);
    throw err;
  }
}

function handleBrowserOnline() {
  if (browserOnline) return;
  browserOnline = true;
  emitIfChanged();
}

function handleBrowserOffline() {
  if (!browserOnline) return;
  browserOnline = false;
  emitIfChanged();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', handleBrowserOnline);
  window.addEventListener('offline', handleBrowserOffline);
}

// Tests need to rehydrate module state after overriding
// navigator.onLine or clearing listeners between cases.
export function _resetNetworkStatusForTests() {
  listeners.clear();
  statusListeners.clear();
  browserOnline = initialBrowserOnline();
  fetchOnline = true;
  lastStatus = computeStatus();
  probeUrl = null;
  probeInFlight = false;
  successSeq = 0;
  probeBaselineSeq = 0;
  // Re-sync React Query's singleton onlineManager to the reset state — a test
  // that drove us offline (pausing queries) would otherwise leak that into the
  // next test, stranding its queries paused.
  onlineManager.setOnline(lastStatus === 'online');
}
