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

// "Can't reach the backend" and "the backend answered with an error" are
// different problems with different fixes (find a connection vs. wait for the
// server), so we surface three states instead of one blanket "Offline" — and,
// crucially, we label from EVIDENCE, not assumption:
//   - 'online'              — reads are succeeding.
//   - 'offline'             — we can't reach our backend: the device reports no
//                             network (navigator.onLine === false), OR a read
//                             threw with no response (DNS/unreachable/dropped/
//                             CORS-less gateway failure). We can't prove the
//                             device has a connection, so the honest, actionable
//                             label is "Offline" — the user's problem.
//   - 'backend-unreachable' — the backend ANSWERED, but with a 5xx: it's reachable
//                             and erroring (overloaded / failing). Readmo's
//                             problem, not theirs. Shown as "Down".
// The old design *assumed* "Down" on any failed fetch and only fell back to
// "Offline" after two ~30s recovery-probe failures — so a genuinely-offline
// device whose navigator.onLine lags `true` sat on a wrong "Down" for up to a
// minute. Now a throw is "Offline" immediately, and "Down" requires a 5xx we can
// actually see. Both non-online states back off identically: reads pause and a
// 30s recovery probe re-tests, so a struggling backend is never retry-stormed.
export type ConnectivityStatus = 'online' | 'offline' | 'backend-unreachable';

type StatusListener = (status: ConnectivityStatus) => void;

function initialBrowserOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

let browserOnline: boolean = initialBrowserOnline();
let fetchOnline: boolean = true;
// True when the most recent read got an actual HTTP *error response* (5xx) from
// our backend — proof the device reached the server but the server is erroring.
// This, not a bare fetch failure, is what justifies the "Down" label: a request
// that throws (no response) can't tell "our server is down" from "the device has
// no network", so it reads as Offline; a 5xx we can actually see does. Cleared by
// the next response below 500 (a real read recovering).
let backendErroring = false;

function computeStatus(): ConnectivityStatus {
  // A device that reports no network is offline regardless of anything else —
  // the device signal wins, since "find a connection" is the actionable fix.
  if (!browserOnline) return 'offline';
  // We got a 5xx from the backend: the device reached the server, so this is our
  // problem, not the connection's → "Down". Evidence-based: only an actual error
  // response earns this label, never a bare fetch failure.
  if (backendErroring) return 'backend-unreachable';
  // A read is failing with no response at all (a throw). We can't reach our
  // backend and can't prove the device has a connection, so the honest, actionable
  // label is "Offline" — not "Down". (This is the fix: a genuinely offline device
  // whose navigator.onLine lags `true` reads as Offline immediately, instead of
  // sitting on "Down" while a recovery probe slowly concludes otherwise.)
  if (!fetchOnline) return 'offline';
  return 'online';
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
  const prev = lastStatus;
  lastStatus = next;
  // NB: the recovery probe is NOT started/stopped here — its lifecycle keys on
  // `awaitingLiveness` (set in goOffline, cleared by a cache-bypassing success),
  // not on status, so a cache hit flipping us to 'online' can't cancel it while
  // the backend is still down. See updateRecoveryProbe.
  // Status subscribers see every transition (e.g. 'offline' -> 'backend-
  // unreachable'); boolean subscribers + onlineManager only fire on the
  // online/not-online edge.
  for (const fn of statusListeners) fn(next);
  const wasOnline = prev === 'online';
  const isOnline = next === 'online';
  if (wasOnline === isOnline) return;
  for (const fn of listeners) fn(isOnline);
  // Pause React Query whenever we're not fully online — including "Down" (the
  // backend answered 5xx, i.e. it's struggling): backing off the read load is
  // exactly what a saturated backend needs, never a retry storm. The backed-off
  // recovery probe (every 30s) flips us back online to re-test; a healthy (<500)
  // read then sticks. Resume on reconnect, same as before.
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
  // The health endpoint answered, so optimistically clear a "Down" (5xx) flag and
  // let a read re-test: if it 5xxes again we go straight back to Down (one read
  // per probe interval — backed off). Health up doesn't prove reads are up, but
  // re-testing on the interval is how we notice the backend actually recovered.
  backendErroring = false;
  reportFetchSuccess(true);
  // Recovering from "Down" leaves `fetchOnline` already true (a 5xx is a
  // response), so reportFetchSuccess early-returns without emitting — emit here so
  // the Down→online transition notifies subscribers and un-pauses onlineManager.
  // No-op when the status is unchanged (the offline→online path already emitted).
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
  // A failure means we can no longer trust that the backend is reachable — start
  // (or keep) re-probing until a cache-bypassing success proves otherwise.
  awaitingLiveness = true;
  updateRecoveryProbe();
  fetchOnline = false;
  // A throw is the absence of a response, so it is NOT the 5xx "Down" case — clear
  // any prior backend-erroring flag so the status falls through to "Offline".
  backendErroring = false;
  emitIfChanged();
}

/**
 * The backend answered, but with a 5xx — it's reachable yet erroring ("Down").
 * Back off exactly like a connection failure: pause reads (emitIfChanged flips
 * onlineManager off below the 'online' edge) and arm the recovery probe, which
 * re-tests on the interval. `fetchOnline` stays true (a 5xx is a response, not a
 * throw), so once `backendErroring` clears the status returns to 'online'.
 */
function goBackendDown() {
  backendErroring = true;
  fetchOnline = true;
  // The origin answered, so it's reachable — bump BOTH stale-probe guards so an
  // in-flight probe that started before this 5xx can't relatch us to 'offline'
  // and wipe the fresh Down evidence: `livenessSeq` (confirmBackendReachable) and
  // `successSeq` (maybeProbeAfterTimeout, which keys its baseline off successSeq).
  livenessSeq++;
  successSeq++;
  awaitingLiveness = true;
  updateRecoveryProbe();
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
    // A core 5xx may have landed while this probe was airborne — including from
    // the very read whose slowness hedged it (reportFetchSlow): a slow-500
    // backend answers AFTER the 3s hedge fires. That Down evidence is NEWER
    // than this probe's information, and health-up ≠ reads-up (the health
    // endpoint is in-process and stays up while the DB is failing). Clearing
    // Down here would unpause React Query per slow-500 read and defeat the
    // paused-reads backoff — so leave Down for the backed-off recovery probe
    // (one re-test per 30s interval), which deliberately DOES clear it. This
    // mirrors the failure path's stale-guard just below (a 5xx mid-probe blocks
    // the Down→Offline relatch via successSeq).
    if (backendErroring) return;
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
 * Report a bounded read that has been in flight for a while without settling
 * (supabaseFetch hedges at HEDGE_PROBE_MS — see client.ts). Lie-fi — signal
 * bars at zero but the radio not yet given up — makes reads HANG rather than
 * fail fast, so the first offline evidence would otherwise wait out the full
 * 8s read cap *plus* the post-timeout probe. Kick the same reachability
 * adjudication a timeout does, in parallel with the still-running read: the
 * probe reaching the backend changes nothing (slow backend — the read may yet
 * succeed), while a failed probe flips Offline now, a read-cap earlier than
 * waiting it out. Reuses the timeout probe's coalescing (one in flight at a
 * time) and its stale-success guard (any success landing after this hedge —
 * including the SW's 6s cache fallback answering the very read being hedged —
 * suppresses the probe failure), so hedging can't flap a slow-but-working
 * connection offline.
 *
 * No-op when no probe is configured: the post-timeout path treats a TIMEOUT
 * as offline conservatively in mock mode, but a merely-slow read that may
 * still succeed proves nothing on its own. Also skipped while the browser
 * already reports offline — the pill is already on and there's nothing to
 * adjudicate.
 */
export function reportFetchSlow(): Promise<void> | void {
  if (probeUrl == null || !browserOnline) return;
  return maybeProbeAfterTimeout();
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
 * it — a failed probe flips us to offline. Returns true iff the backend answered.
 * Unconfigured (no probe URL — mock/local dev with no remote backend to be down)
 * returns true: the mock source is authoritative.
 */
export async function confirmBackendReachable(): Promise<boolean> {
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
      // Couldn't reach the always-up health endpoint → we can't reach our backend
      // at all, so this is "Offline", not "Down".
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
  // Run while in doubt — offline (awaiting liveness) OR Down (backendErroring) —
  // so a non-core cache-bypassing success that clears `awaitingLiveness` can't
  // stop the probe while core reads are still erroring.
  if (inDoubt() && browserOnline && probeUrl != null) startRecoveryProbe();
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
    // The backed-off, once-per-interval re-test: reaches the backend → online
    // (a read re-evaluates); still unreachable → stays offline.
    void confirmBackendReachable();
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
  if (!inDoubt() || !browserOnline) return;
  void confirmBackendReachable();
}

/**
 * Network Information API trigger. `navigator.connection` fires `change` when
 * the OS's view of the connection shifts — entering a tunnel, wifi↔cellular,
 * the effective type dropping — often long before `navigator.onLine` flips
 * (which can lag by tens of seconds, or never fire, or flap). The event is
 * treated ONLY as a trigger for an immediate liveness probe, never as truth:
 * labeling stays evidence-based, so a change that broke nothing is a no-op
 * costing one tiny GET. This closes the no-traffic detection gap — with
 * nothing in flight, a signal loss otherwise goes unnoticed until the user's
 * next fetch eats the full timeout+probe window at the worst moment. A change
 * while latched OFFLINE probes too (same stale-guards), which speeds recovery
 * when the signal returns. Supported on Android Chrome — exactly where
 * `navigator.onLine` lags worst; absent on iOS Safari, where the listener is
 * simply never registered.
 */
let connectionProbeInFlight = false;
async function handleConnectionChange(): Promise<void> {
  // Device says it has no network at all → the pill is already on and the
  // probe could only fail; the `online` event / recovery probe own that path.
  // Unconfigured (mock) → no backend to probe. Coalesce bursts of change
  // events into one probe at a time.
  if (probeUrl == null || !browserOnline || connectionProbeInFlight) return;
  // "Down" (a core 5xx) means the backend is already REACHABLE — reachability
  // is not the open question, and a probe success would optimistically clear
  // Down (reportProbeSuccess) and unpause reads. That clear is deliberately
  // rate-owned by the backed-off 30s recovery probe and the (rare, user-
  // salient) focus probe; connection-change events are machine-driven and can
  // be chatty (Chrome fires them on downlink/RTT estimate shifts), so letting
  // them re-test would defeat the paused-reads backoff during a DB outage.
  if (backendErroring) return;
  connectionProbeInFlight = true;
  try {
    await confirmBackendReachable();
  } finally {
    connectionProbeInFlight = false;
  }
}

/** Test-only: drive the `navigator.connection` change handler directly —
 * registration happens at module load, when jsdom exposes no `connection`. */
export function _handleConnectionChangeForTests(): Promise<void> {
  return handleConnectionChange();
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

/** The request URL across the `Request | string | URL` shapes fetch accepts. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return '';
}

/**
 * Whether this is a **core data-plane** request — Supabase REST/RPC (`/rest/v1/`:
 * table reads, the `feed_items`/`feed_unread_counts` read RPCs, item-state
 * writes). Only these drive the "Down" (backend-unreachable) state: a 5xx from a
 * progressive Edge Function (`/functions/v1/`) or auth (`/auth/v1/`) is the
 * caller's to handle and must not pause reads app-wide.
 */
function isCoreReadUrl(input: RequestInfo | URL): boolean {
  return urlOf(input).includes('/rest/v1/');
}

/**
 * In doubt about backend reachability: either we can't reach it (a throw →
 * `awaitingLiveness`) or core reads are erroring (a 5xx → `backendErroring`).
 * Drives the recovery probe and the cache-hit flap suppression so that a non-core
 * success clearing `awaitingLiveness` can't strand the probe while still "Down".
 */
function inDoubt(): boolean {
  return awaitingLiveness || backendErroring;
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
    //
    // A 5xx is the one response that's also bad news: the server answered but is
    // erroring, which is exactly the "Down" (backend-unreachable) case — but only
    // for the **core data plane** (`/rest/v1/`: table reads + the feed RPCs).
    // `trackedFetch` is the fetch impl for *every* Supabase request, so a 5xx from
    // a progressive Edge Function (`fulltext`/`summary`/`discover`/`refresh`) or
    // auth must NOT shed the whole app — those callers degrade locally. A status
    // below 500 (2xx/3xx/4xx — incl. auth's own 401/403) is the backend serving.
    const cacheBypassing = methodOf(input, init) !== 'GET';
    const coreRead = isCoreReadUrl(input);
    if (res.status >= 500 && coreRead) {
      goBackendDown();
    } else {
      // The origin answered, so it's reachable. Clear a "Down" flag only on a
      // genuine sub-500 CORE read recovering: a stale Workbox cache hit (a GET we
      // can't trust while in doubt), a non-core response, or a non-core 5xx must
      // not flap us out of Down — only a cache-bypassing core success or the
      // health probe may. Mirrors reportFetchSuccess's own flap suppression.
      const suppressedCacheHit = !cacheBypassing && inDoubt() && probeUrl != null;
      if (coreRead && res.status < 500 && !suppressedCacheHit) {
        backendErroring = false;
      }
      reportFetchSuccess(cacheBypassing);
      // reportFetchSuccess early-returns when fetchOnline was already true, so a
      // read recovering a prior "Down" wouldn't emit on its own — surface it.
      emitIfChanged();
    }
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
  // …and probe NOW, not at the interval's first tick 30s out. The reconnect
  // event is rare and user-salient — the same trigger class as regained focus,
  // so it may clear a latched Down/Offline immediately (unlike machine-chatty
  // connection-change events, which must not touch Down). Without this, a
  // backend that recovered while the device was disconnected keeps the Down
  // pill (and paused reads) for up to a full recovery interval after
  // connectivity returns: nothing else is guaranteed to re-test — the resync
  // read the `online` event triggers is a cache-ambiguous GET whose success is
  // deliberately suppressed while in doubt, and the outbox/refetch POSTs only
  // fire if something happens to be queued or stale.
  if (inDoubt()) void confirmBackendReachable();
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
if (typeof navigator !== 'undefined') {
  // See handleConnectionChange. Optional-chained throughout: the API is absent
  // on iOS Safari/jsdom, and older shapes may lack addEventListener.
  const connection = (
    navigator as Navigator & {
      connection?: {
        addEventListener?: (type: 'change', listener: () => void) => void;
      };
    }
  ).connection;
  connection?.addEventListener?.('change', () => void handleConnectionChange());
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
  backendErroring = false;
  lastStatus = computeStatus();
  probeUrl = null;
  probeInFlight = false;
  connectionProbeInFlight = false;
  successSeq = 0;
  probeBaselineSeq = 0;
  livenessSeq = 0;
  awaitingLiveness = false;
  // Re-sync React Query's singleton onlineManager to the reset state — a test
  // that drove us offline (pausing queries) would otherwise leak that into the
  // next test, stranding its queries paused.
  onlineManager.setOnline(lastStatus === 'online');
}
