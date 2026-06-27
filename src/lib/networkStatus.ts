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
// Disambiguating the two when navigator.onLine lags: a single failed fetch with
// the device still claiming a connection reads as 'backend-unreachable' (we
// don't mislabel a server outage as the user being offline on one data point).
// But we don't wait out navigator.onLine forever — the recovery probe hits the
// always-up `/auth/v1/health` endpoint, so *sustained* probe failure (no HTTP
// response at all) means we can't reach the network and the device is offline.
// After OFFLINE_AFTER_PROBE_FAILURES consecutive probe failures the status
// becomes 'offline' on its own. (A genuinely-down-but-reachable backend answers
// the probe with a 4xx/5xx, which counts as success — so it never trips this.)
export type ConnectivityStatus = 'online' | 'offline' | 'backend-unreachable';

type StatusListener = (status: ConnectivityStatus) => void;

function initialBrowserOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

let browserOnline: boolean = initialBrowserOnline();
let fetchOnline: boolean = true;

// Consecutive *recovery-timer* probe failures (a probe that got NO HTTP response
// — a TypeError, i.e. we couldn't reach the network at all). The probe hits
// `/auth/v1/health`, an in-process GoTrue endpoint that stays up even when the
// DB is saturated, so a *failed* probe is strong evidence the DEVICE has no
// network rather than the backend being down (a real backend outage where the
// server is reachable answers with a 4xx/5xx, which the probe counts as success).
// Only the serial recovery timer advances this (once per interval — it can't
// double-count); opportunistic probes (focus/visibility/empty-read) adjudicate
// the status but don't count. Reset to 0 by any cache-bypassing success. Used to
// conclude 'offline' without waiting on navigator.onLine (which lags badly on
// mobile — the reason this could sit on "Down" and never say "Offline"). The flap
// suppression is separate: it keys on `awaitingLiveness` (see reportFetchSuccess),
// so it takes effect the instant we go down, not after a probe fails.
let probeFailures = 0;
// Two consecutive recovery-timer failures (~one interval apart) is enough
// sustained evidence to conclude the device, not the backend, is the problem and
// surface "Offline".
const OFFLINE_AFTER_PROBE_FAILURES = 2;

function computeStatus(): ConnectivityStatus {
  if (browserOnline && fetchOnline) return 'online';
  // A device that reports no network is offline regardless of fetch state —
  // the device signal wins, since "find a connection" is the actionable fix.
  if (!browserOnline) return 'offline';
  // Browser still claims a connection, but our liveness probe has failed
  // repeatedly. The probe endpoint is effectively always up when reachable, so
  // sustained failure means we can't reach the network — treat it as the device
  // being offline, not the backend down, rather than waiting out navigator.onLine.
  if (probeFailures >= OFFLINE_AFTER_PROBE_FAILURES) return 'offline';
  // Browser says connected and we haven't (yet) proven the network is gone:
  // our last fetch failed, so the backend is the problem, not the connection.
  return 'backend-unreachable';
}

let lastStatus: ConnectivityStatus = computeStatus();
// Boolean subscribers (the legacy `online` signal) only care about the
// online/not-online edge; status subscribers see every transition, including
// 'offline' <-> 'backend-unreachable' (where the boolean stays false).
const listeners = new Set<Listener>();
const statusListeners = new Set<StatusListener>();

// A self-imposed read *timeout* (supabaseFetch aborts a hung read after 8s)
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
// Cache-bypassing successes — genuine proof the backend was reachable. Unlike
// `successSeq` (bumped on ANY resolved fetch), this counts only responses that
// cannot have come from the Workbox NetworkFirst cache, which can lie about
// liveness (the whole reason confirmBackendReachable exists):
//   - every liveness-probe success (hits `/auth/v1/health`, no service worker), and
//   - every non-GET trackedFetch success (Cache API is GET-only, so a POST/
//     PATCH/DELETE — writes, the feed_items read RPC, auth, functions — always
//     reaches the origin).
// confirmBackendReachable's stale-failure guard keys off this counter: a cached
// GET resolving mid-probe must NOT suppress a real failed probe, but a genuine
// live request (e.g. a set_item_state POST) that the backend accepted must.
let livenessSeq = 0;

// Short ceiling for the reachability probe — under the 8s read cap so a
// genuine offline flips the pill promptly rather than waiting a second read cap.
const PROBE_TIMEOUT_MS = 5_000;

// Once a fetch failure flips us down, nothing in the app re-checks the backend
// on its own: emitIfChanged paused React Query (onlineManager.setOnline(false)),
// so no query refetches → no trackedFetch → no success ever fires to clear the
// pill. Left alone, "Down" sticks on screen long after the backend recovers (and
// a user reading cached content issues no reads that would notice). So we re-
// probe the SW-bypassing liveness endpoint on an interval until liveness is
// confirmed. Cost is negligible: one tiny GET every 30s, only while in doubt.
//
// The lifecycle keys on `awaitingLiveness`, NOT on the connectivity status: a
// Workbox cache hit calls reportFetchSuccess(false), which flips the status to
// 'online' (clearing the pill) without proving the backend is reachable. If the
// probe stopped on that transition, a cache-only "recovery" while the backend is
// still down would cancel the only real liveness check and leave us falsely
// online until some later live request happens to fail. So the doubt is set on
// any goOffline and cleared ONLY by a cache-bypassing success (a probe, or a
// non-GET request the backend accepted); the probe runs the whole time it's set.
const RECOVERY_PROBE_INTERVAL_MS = 30_000;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;
// True while we've seen a failure but not yet re-confirmed genuine liveness. A
// cache hit clearing the pill does not clear this — see the block comment above.
let awaitingLiveness = false;

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
  // NB: the recovery probe is NOT started/stopped here — its lifecycle keys on
  // `awaitingLiveness` (set in goOffline, cleared by a cache-bypassing success),
  // not on status, so a cache hit flipping us to 'online' can't cancel it while
  // the backend is still down. See updateRecoveryProbe.
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

/**
 * Report a successful fetch. `cacheBypassing` marks responses that prove the
 * backend was genuinely reachable — i.e. cannot have been served from the
 * Workbox cache (every non-GET request; see {@link livenessSeq}). Those bump the
 * liveness counter that confirmBackendReachable's stale-failure guard trusts; a
 * plain (possibly cache-served GET) success bumps only the general signal.
 */
export function reportFetchSuccess(cacheBypassing = false) {
  // Bump unconditionally (even when already online) so a probe started before
  // this success can detect it and skip flipping us offline.
  successSeq++;
  if (cacheBypassing) {
    // Genuine proof of reachability: record it and stand down the recovery probe.
    // A cache-ambiguous GET success does NOT clear the doubt (it can't prove the
    // backend is up), so the probe keeps running until something cache-bypassing
    // confirms it.
    livenessSeq++;
    awaitingLiveness = false;
    probeFailures = 0; // network reachable again — clear the offline evidence
    updateRecoveryProbe();
  }
  if (fetchOnline) return;
  // While we're awaiting liveness re-confirmation AND a probe is configured to
  // provide it, a plain GET success may be a Workbox cache hit that proves
  // nothing — don't let it flap us back "online". Only a cache-bypassing success
  // (handled above: probe / non-GET the backend accepted) clears the down state.
  // This is what stops the "Down/Offline ↔ online" flapping while offline, and it
  // takes effect the instant we go down (no window before the first probe). In
  // mock/unconfigured mode (no probe to confirm recovery) we keep the legacy
  // behavior and let a bare success clear it, so we can't get stuck offline.
  if (!cacheBypassing && awaitingLiveness && probeUrl != null) return;
  fetchOnline = true;
  emitIfChanged();
}

/**
 * A liveness-probe success: genuine proof of reachability, because the probe
 * hits `/auth/v1/health` directly (no service worker, so no cache can answer
 * it). Reported as cache-bypassing so it counts toward the liveness counter.
 */
function reportProbeSuccess() {
  reportFetchSuccess(true);
}

export function reportFetchFailure(err: unknown): Promise<void> | void {
  // A read timeout is ambiguous (offline vs. slow/overloaded backend). Don't
  // flip the pill on the timeout alone — probe reachability and decide there.
  if (isTimeout(err)) return maybeProbeAfterTimeout();
  if (!isHardNetworkError(err)) return;
  goOffline();
}

function goOffline() {
  // A failure means we can no longer trust that the backend is reachable — start
  // (or keep) re-probing until a cache-bypassing success proves otherwise.
  awaitingLiveness = true;
  updateRecoveryProbe();
  fetchOnline = false;
  // Always re-emit (not just on the fetchOnline edge): a probe failure that lands
  // while we're already down can still tip the *status* from backend-unreachable
  // to offline as `probeFailures` crosses the threshold. emitIfChanged is guarded
  // by an unchanged-status check, so a true no-op stays a no-op.
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
    // and clear the pill if a prior hard failure had flipped it off. A genuine
    // probe success (not a cache hit), so it counts toward probeSuccessSeq too.
    reportProbeSuccess();
  } catch {
    // Probe failed too → genuinely unreachable, unless a real success landed
    // since the latest timeout (then we're online and this probe is stale). This
    // is an opportunistic, one-off probe (triggered by a read timeout), so it
    // adjudicates the status but does NOT advance the consecutive-failure counter
    // — only the serial recovery-timer probe does (see startRecoveryProbe).
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
 * backend is down (the read's 8s cap deliberately sits past the SW's 6s
 * cache-fallback window), which `trackedFetch` then reads as success → `online`.
 * Callers use this to verify an *empty* feed read came from a live server before
 * trusting it as "all caught up": a cache-served empty page would otherwise lie.
 *
 * The outcome is reported into the tracker so the connectivity status reflects
 * it — a failed probe flips us to backend-unreachable (or offline). Returns true
 * iff the backend answered. Unconfigured (no probe URL — mock/local dev with no
 * remote backend to be down) returns true: the mock source is authoritative.
 *
 * `countTowardOffline` advances the consecutive-failure counter that decides when
 * to surface "Offline" (Part B). Only the **serial** recovery-timer probe passes
 * `true`: it fires once per interval, so it can't double-count. Opportunistic
 * callers (empty-read confirmation, focus/visibility re-checks) pass `false` —
 * several can overlap on a single tab return, and counting each toward the
 * threshold would falsely declare "Offline" off one instant rather than sustained
 * evidence. They still adjudicate the status (goOffline / reportProbeSuccess).
 */
export async function confirmBackendReachable(
  countTowardOffline = false,
): Promise<boolean> {
  if (probeUrl == null) return true;
  // Snapshot the liveness counter before probing so a *stale* failure can't
  // relatch us offline. Probes can overlap (the 30s interval racing a focus/
  // visibility probe — and `focus` + `visibilitychange` can both fire on one tab
  // switch) and settle out of order: a probe opened while the backend was down
  // can reject *after* newer evidence proved it reachable. Only flip offline if
  // no cache-bypassing success has landed since this probe started. Keying on
  // livenessSeq (not successSeq) means a Workbox GET cache hit resolving
  // mid-probe — which can lie about liveness — can't suppress a real failed
  // probe, while a genuine live request (another probe, or a non-GET like a
  // set_item_state POST that the backend accepted) correctly does.
  const baselineSeq = livenessSeq;
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
    reportProbeSuccess();
    return true;
  } catch {
    // Couldn't reach the backend → the empty read was a stale cache hit (or the
    // server is down). Flip the pill — unless a cache-bypassing success landed
    // since we started, which makes this failure stale: relatching then would
    // falsely re-show "Down" over a backend already proven reachable.
    if (livenessSeq === baselineSeq) {
      // Couldn't reach the always-up health endpoint → device-offline evidence.
      // Only the serial recovery-timer probe advances the counter (see above).
      if (countTowardOffline) probeFailures++;
      goOffline();
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reconcile the recovery timer with the current need for it: it runs exactly
 * while we're awaiting liveness re-confirmation, the device itself is online
 * (no point probing a backend when the radio is down — that's the user's fix),
 * and a probe endpoint is configured (mock mode has no backend to be down).
 * Called wherever those inputs change. Idempotent.
 */
function updateRecoveryProbe() {
  if (awaitingLiveness && browserOnline && probeUrl != null) startRecoveryProbe();
  else stopRecoveryProbe();
}

/**
 * Re-probe the backend on an interval until liveness is re-confirmed. Idempotent
 * — a timer already running is left alone. Each tick delegates to
 * {@link confirmBackendReachable}: a success reports cache-bypassing liveness
 * (clearing `awaitingLiveness`, which stops this timer via updateRecoveryProbe);
 * a failure leaves the doubt set and the next tick tries again. The probe
 * bypasses the service worker, so it reflects the live backend, never a cache hit.
 */
function startRecoveryProbe() {
  if (recoveryTimer != null) return;
  recoveryTimer = setInterval(() => {
    // The serial, once-per-interval probe — its failures are the sustained
    // evidence that advances the consecutive-failure counter toward "Offline".
    void confirmBackendReachable(/* countTowardOffline */ true);
  }, RECOVERY_PROBE_INTERVAL_MS);
}

function stopRecoveryProbe() {
  if (recoveryTimer == null) return;
  clearInterval(recoveryTimer);
  recoveryTimer = null;
}

/**
 * A user returning focus to a tab is the moment to re-check — probe immediately
 * rather than waiting out the recovery interval. Keys on `awaitingLiveness` (not
 * status) so it also re-confirms a cache-only "recovery" that cleared the pill
 * while the backend was still down; a no-op once liveness is confirmed (so a
 * focus while genuinely online fires no needless probe).
 */
function handleRegainedFocus() {
  if (!awaitingLiveness || !browserOnline) return;
  void confirmBackendReachable();
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

/**
 * The request method, across the `Request | string | URL` + init shapes fetch
 * accepts. Used only to tell cache-eligible GETs from cache-bypassing requests.
 */
function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
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
    // until both signals line up. A non-GET response additionally counts as
    // cache-bypassing liveness proof (Workbox runtime caching is GET-only, so a
    // POST/PATCH/DELETE always reached the origin); a GET might be a cache hit,
    // so it isn't trusted as liveness evidence — that's what the probe is for.
    reportFetchSuccess(methodOf(input, init) !== 'GET');
    return res;
  } catch (err) {
    reportFetchFailure(err);
    throw err;
  }
}

function handleBrowserOnline() {
  if (browserOnline) return;
  browserOnline = true;
  // Reconnecting while still awaiting liveness resumes the probe (it was idle
  // while the device was offline).
  updateRecoveryProbe();
  emitIfChanged();
}

function handleBrowserOffline() {
  if (!browserOnline) return;
  browserOnline = false;
  // Device offline → "find a connection" is the user's fix; stand down the probe
  // until the radio is back (handleBrowserOnline resumes it if still in doubt).
  updateRecoveryProbe();
  emitIfChanged();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', handleBrowserOnline);
  window.addEventListener('offline', handleBrowserOffline);
  // Returning to a tab that's showing "Down" re-checks the backend at once.
  window.addEventListener('focus', handleRegainedFocus);
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') handleRegainedFocus();
  });
}

// Tests need to rehydrate module state after overriding
// navigator.onLine or clearing listeners between cases.
export function _resetNetworkStatusForTests() {
  listeners.clear();
  statusListeners.clear();
  stopRecoveryProbe();
  browserOnline = initialBrowserOnline();
  fetchOnline = true;
  lastStatus = computeStatus();
  probeUrl = null;
  probeInFlight = false;
  successSeq = 0;
  probeBaselineSeq = 0;
  livenessSeq = 0;
  probeFailures = 0;
  awaitingLiveness = false;
  // Re-sync React Query's singleton onlineManager to the reset state — a test
  // that drove us offline (pausing queries) would otherwise leak that into the
  // next test, stranding its queries paused.
  onlineManager.setOnline(lastStatus === 'online');
}
