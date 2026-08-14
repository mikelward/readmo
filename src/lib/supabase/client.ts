import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  reportFetchSlow,
  setConnectivityProbeUrl,
  trackedFetch,
} from '../networkStatus';
import { buildInfo } from '../buildInfo';
import { RequestCircuitBreaker } from '../data/requestCircuitBreaker';

// Hard ceiling on a single PostgREST GET read. Without it a request that never
// answers (lie-fi, or the service worker's NetworkFirst awaiting a hung network
// on a cache miss) leaves the read pending forever — and because
// SupabaseDataSource memoizes the in-flight item_state hydration, one hung read
// wedges the whole feed on its loading skeletons. Timing out rejects the read
// instead, so React Query can surface the offline/retry UI and retry on
// reconnect. 8s sits just past the SW's 6s cache-fallback window
// (`networkTimeoutSeconds` in vite.config.ts) so a genuinely slow-but-working
// read still gets served from cache first — keep the two in lockstep (cap >
// window) if either moves. A single page fetch hanging now clears in ~8s rather
// than the old 15s, so stuck skeletons / a queued-behind hydration recover
// faster without aborting a read the cache could still answer.
//
// The cap is scoped to reads — GET on /rest/v1/ plus the feed_items read RPC
// (see isBoundedRead) — deliberately NOT applied to writes (the outbox owns
// their durability/retry), auth (a timed-out refresh would null the user →
// spurious sign-out + cache purge), or Edge Functions (legitimately
// long-running). All of those still flow through trackedFetch, so a real failure
// flips the Offline pill.
const REQUEST_TIMEOUT_MS = 8_000;

// Hedged liveness probe for lie-fi. A bounded read still unsettled after this
// long fires `reportFetchSlow`, which runs the reachability probe IN PARALLEL
// with the still-hanging read instead of waiting out the full cap first — so a
// genuine dead zone (bars at zero, radio not yet given up, requests hang
// rather than fail) flips the Offline pill in ~hedge+probe rather than
// cap+probe. A slow-but-working read is unaffected: the probe reaching the
// backend changes nothing, and the read keeps its full 8s. Keep the ordering
// hedge < SW cache-fallback window (6s) < read cap (8s) — the hedge must fire
// while the read is still genuinely undecided. Cost: one health-endpoint GET
// per slow read, coalesced to one probe in flight — negligible.
const HEDGE_PROBE_MS = 3_000;

// Single browser Supabase client for the whole app. The URL + anon key are
// public (RLS-gated); the service-role key never reaches the client. When the
// env vars are absent (tests, backend-less local/mock dev) the app falls back
// to the mock auth + MockDataSource path, so this module never throws at import
// time — only `getSupabase()` throws, and only if actually called unconfigured.

// Accept our own VITE_* names first, then fall back to the public names the
// Supabase↔Vercel integration provisions (NEXT_PUBLIC_*), so deployments wired
// through that integration work without hand-duplicating env vars. Only public
// keys are read here — never the service-role/secret keys.
const env = import.meta.env;
const url = env.VITE_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey =
  env.VITE_SUPABASE_ANON_KEY ??
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Register the reachability probe used to disambiguate a read *timeout* from
// genuine offline (see networkStatus.ts). GoTrue's `/auth/v1/health` is an
// in-process liveness check that doesn't query Postgres, so it stays responsive
// even when the DB is overloaded — the case where a slow `feed_items` read would
// otherwise time out and paint a wrong "Offline" pill. Unconfigured (mock) →
// no probe, and a timeout falls back to being treated as offline.
setConnectivityProbeUrl(supabaseHealthUrl());

/** GoTrue's in-process liveness endpoint for the configured project, or null
 * when unconfigured (mock mode). Same URL registered above as the connectivity
 * probe; `/debug` reuses it to show live backend reachability. `/auth/v1/health`
 * doesn't query Postgres, so a probe reflects "can we reach the backend" without
 * loading the DB. */
export function supabaseHealthUrl(): string | null {
  return url ? `${url.replace(/\/$/, '')}/auth/v1/health` : null;
}

/** Deterministic localStorage key for the persisted auth session. Fixed (rather
 * than supabase-js's default `sb-<ref>-auth-token`) so the boot path can read
 * the signed-in uid synchronously, before first paint — see getActiveUid. */
export const AUTH_STORAGE_KEY = 'readmo:sb-auth';

/** True when both client env vars are present. Drives the auth + data-source
 * selection: configured → real Supabase; unconfigured → mock. */
export function isSupabaseConfigured(): boolean {
  return Boolean(url && anonKey);
}

/** Feature flag for the passwordless email (magic-link) sign-in form. **Off by
 * default** — a deployment opts in by setting `VITE_EMAIL_AUTH_ENABLED` to
 * `true`/`1` at build time, which it should do only after enabling Supabase's
 * Email provider + sender (SETUP.md §4). OAuth sign-in is unaffected either way.
 * Read at call time (not hoisted into a module const) so tests can flip it via
 * `vi.stubEnv`. */
export function isEmailAuthEnabled(): boolean {
  const v = env.VITE_EMAIL_AUTH_ENABLED;
  return v === '1' || (typeof v === 'string' && v.toLowerCase() === 'true');
}

/** The request URL as a string, across the `Request | string | URL` shapes the
 * global fetch accepts. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The HTTP method, across the `Request | string | URL` + init shapes the
 * global fetch accepts. Defaults to GET (the fetch default). */
function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

// PostgREST sends `rpc()` as a POST, so read-only RPCs can't be recognized by
// method — list them explicitly. These are pure reads (safe to abort + retry
// like any GET) and so get the read timeout AND the read breaker:
//   - feed_items — the primary feed read (home/folder/feed); a hung one strands
//     the view on its skeletons even when item_state is cached.
//   - feed_unread_counts — the grouped-view per-feed unread counts; a failing
//     grouped refetch/invalidation loop hits this, so it must be shed by the
//     breaker too, not just feed_items.
// Write RPCs (set_item_state, subscribe_to_feed, reorder_subscriptions) are
// deliberately ABSENT — see isBoundedRead.
const READ_RPC_PATHS = [
  '/rest/v1/rpc/feed_items',
  '/rest/v1/rpc/feed_unread_counts',
];

/**
 * The item-state write RPC (`set_item_state`) the outbox delivers triage toggles
 * through. Recognized so it can be marked `keepalive` — see supabaseFetch: a
 * mark-done / pin fired just before the tab is closed or backgrounded must still
 * reach the server, not be canceled with the page. The payload is a handful of
 * boolean fields, far under the 64 KB keepalive body cap.
 */
function isItemStateWrite(input: RequestInfo | URL, init?: RequestInit): boolean {
  return (
    requestMethod(input, init) === 'POST' &&
    requestUrl(input).includes('/rest/v1/rpc/set_item_state')
  );
}

/**
 * The requests that get the short cap: **GET reads** on PostgREST (`/rest/v1/`)
 * — the path the service worker mediates (Workbox runtime caching is GET-only),
 * so the cache-miss-hang this targets is a GET — plus the known read-only RPCs
 * (`feed_items`), which are POSTs but idempotent reads. Everything else is left
 * uncapped:
 *   - Write RPCs (POST `rpc/set_item_state`, `rpc/subscribe_to_feed`) and table
 *     writes (DELETE/PATCH on `subscriptions`) share the `/rest/v1/` prefix but
 *     must NOT be aborted mid-commit — the item-state outbox treats an 8s abort
 *     as a transient failure and retries on a stale base version (risking a
 *     permanent conflict / dropped edit), and a subscription edit could surface
 *     an error even though the server committed. The outbox's own
 *     retry/durability is the right bound for writes.
 *   - Auth (`/auth/v1/`) and Edge Function (`/functions/v1/`) requests — see the
 *     constant's note.
 */
function isBoundedRead(input: RequestInfo | URL, init?: RequestInit): boolean {
  const u = requestUrl(input);
  if (READ_RPC_PATHS.some((path) => u.includes(path))) return true;
  return requestMethod(input, init) === 'GET' && u.includes('/rest/v1/');
}

/**
 * The bounded reads whose **success** is authoritative about backend health: the
 * ones the service worker never answers from cache. Every bounded read now goes
 * through the breaker (a failing loop on any of them is shed), but only these may
 * CLOSE it — a response that didn't reach the backend would close the circuit on
 * a lie. Two kinds qualify:
 *
 *   1. The read-only RPCs (`feed_items`, `feed_unread_counts`) — POSTs, and the
 *      SW's `NetworkFirst` runtime cache is GET-only (`vite.config.ts`), so it
 *      NEVER serves them from cache.
 *   2. The `item_state` hydration GET — served by the SW's **NetworkOnly** route
 *      (`vite.config.ts` `supabaseItemStatePattern`, registered before the
 *      NetworkFirst REST route), so it too always hits the backend. It precedes
 *      every feed read (`ensureHydratedForRead`), so a failing feed loop's
 *      hydration GET must be shed alongside the RPC, not bypass the breaker.
 *
 * Every OTHER GET `/rest/v1/` read (`subscriptions`, `user_settings`, `folders`,
 * `feeds_public`, `items`) is `NetworkFirst`-cached, so a cached `200` the backend
 * never saw is possible. Those reads are still admitted, shed and FAILURE-counted
 * by the breaker — a loop on them is exactly what went uncapped before, and they
 * were the reads failing in the Aug 14 outage — but a success on one settles as
 * *inconclusive* (`settleInconclusive`) so it can neither close the circuit
 * mid-outage nor clear a failure run.
 *
 * The asymmetry is the point: a cache can manufacture a success but it cannot
 * manufacture a failure. A read that FAILED is one the cache could not answer,
 * which is real evidence of backend health and the shape a runaway loop takes.
 *
 * The cost, accepted deliberately: while the circuit is open these reads are shed
 * before reaching the service worker, so they lose their cache fallback for the
 * cooldown. That only bites after six straight failures — by which point the app
 * is already showing its offline/Down state — and capping the loop is worth more
 * than one more cached list mid-outage.
 *
 * (Keep the item_state path in sync with `supabaseItemStatePattern` in
 * vite.config.ts — both encode that item_state is the NetworkOnly read.)
 */
function isNetworkAuthoritativeRead(
  input: RequestInfo | URL,
  init?: RequestInit,
): boolean {
  const u = requestUrl(input);
  if (READ_RPC_PATHS.some((path) => u.includes(path))) return true;
  return requestMethod(input, init) === 'GET' && u.includes('/rest/v1/item_state');
}

/**
 * Connectivity-tracking fetch for the Supabase client. Every request flows
 * through {@link trackedFetch} so a real failure flips the offline indicator.
 * Reads (GET on `/rest/v1/`, plus the `feed_items` read RPC) additionally get a
 * {@link REQUEST_TIMEOUT_MS} ceiling so a hung connection rejects rather than
 * hanging the read forever; writes, auth, and Edge Function invocations are left
 * uncapped (see {@link isBoundedRead}). A caller-supplied signal (e.g. React
 * Query cancelling a superseded query) still aborts; the timeout adds a second
 * abort reason without clobbering it.
 */
// Client-side flood guard for EVERY bounded read — the read RPCs (feed_items,
// feed_unread_counts) and every GET /rest/v1/ read, including the cacheable ones
// (subscriptions, user_settings, folders, feeds_public, items). A failing loop on
// any of them trips the breaker after a burst of failures and is SHED, failing
// fast instead of pinning Postgres. Healthy bursts (e.g. a large offline warmup)
// never trip it — it's failure-based, not rate-based. The additive backstop behind
// the retry discipline (src/lib/queryRetry.ts); the server-side `x-readmo-build`
// gate sheds a known-bad *build*, this caps a failing loop in the live build.
// What the path decides is not whether a read is guarded but whether its SUCCESS
// can close the circuit — only the reads the SW never serves from cache can (see
// isNetworkAuthoritativeRead). Writes (outbox-owned), auth, Edge Functions,
// storage and realtime bypass the breaker entirely — see supabaseFetch for why.
let requestBreaker = new RequestCircuitBreaker();

/** Test-only: reset the module-level breaker between cases (it's a singleton). */
export function _resetRequestBreakerForTests(): void {
  requestBreaker = new RequestCircuitBreaker();
}

/** A caller/cancellation abort — surfaced as an AbortError (DOMException OR a
 * plain Error named 'AbortError', runtime dependent), distinct from a
 * TimeoutError. Not a backend-health signal. */
function isAbortError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

// Only 2xx/3xx is healthy. On the authoritative reads (see
// isNetworkAuthoritativeRead) a 4xx is NOT a benign app response — they return
// 2xx in normal use, so a PostgREST 404 (the feed_items/feed_unread_counts
// function missing on a stale or schema-mismatched backend), 400, or 422 is a
// genuinely failed read that a refetch loop would repeat forever without ever
// tripping the circuit. 5xx counts everywhere; which 4xx counts on a cacheable
// table read is decided at the settle site below.
/** The statuses PostgREST answers a missing table/column/function with. A cheap
 *  pre-filter only — the status alone never earns the exemption, it just decides
 *  whether the body is worth reading (see isSchemaMismatchResponse). */
function isSchemaMismatchStatus(status: number): boolean {
  return status === 400 || status === 404;
}

/** PostgREST/SQLSTATE codes for "the deployed schema doesn't have what this
 *  client named": missing table (PGRST205 / 42P01), missing column
 *  (PGRST204 / 42703), missing function (PGRST202). Kept in step with
 *  isMissingTableError / isMissingColumnError in data/supabaseMappers.ts, which
 *  is what the callers themselves use to detect the same skew.
 *
 *  42501 (insufficient_privilege) is deliberately NOT here even though
 *  isMissingTableError accepts it: a permission denial is a real failed read,
 *  and a loop on one is exactly what the breaker exists to cap. */
const SCHEMA_MISMATCH_CODES = new Set([
  'PGRST202',
  'PGRST204',
  'PGRST205',
  '42P01',
  '42703',
]);

/** How long the schema-code check will wait for a 4xx body. A PostgREST error
 *  envelope is a few hundred bytes and its headers have already arrived, so this
 *  is generous; its real job is to bound the wait, not to time anything. */
const SCHEMA_BODY_READ_TIMEOUT_MS = 1_000;

/**
 * Whether a 4xx on a cacheable table read is a deliberate capability probe
 * rather than backend failure — decided by the PostgREST error CODE, not the
 * status. Status alone is far too broad: a malformed-query `400` on any table
 * (or a `404` unrelated to the settings projection ladder) would be waved
 * through, leaving a refetch loop on it uncounted.
 *
 * The exemption has to be EARNED: anything unreadable, non-JSON, uncoded or
 * SLOW counts as a failure, which is the direction that can only over-protect
 * the backend.
 *
 * The wait is bounded because the read cap is already gone by the time we get
 * here — `boundedReadFetch` resolves on HEADERS and clears its 8s timer, so a
 * response that stalls mid-body would leave this awaiting forever, and with it
 * the breaker ticket: an unsettled half-open or probationary ticket parks every
 * later bounded read behind it permanently. The clone's body is cancelled on
 * that path so the stalled stream isn't left open (cancelling one tee branch
 * leaves the caller's copy intact).
 */
async function isSchemaMismatchResponse(res: Response): Promise<boolean> {
  const copy = res.clone();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body: unknown = await Promise.race([
      copy.json(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('schema-code body read timed out')),
          SCHEMA_BODY_READ_TIMEOUT_MS,
        );
      }),
    ]);
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === 'string' && SCHEMA_MISMATCH_CODES.has(code);
  } catch (err) {
    // Non-JSON, unreadable or stalled body — can't positively identify a probe,
    // so this stays a failure. Debug-level: a 4xx with no PostgREST envelope is
    // normal enough (a gateway error page) that warning on it would be noise.
    console.debug(
      '[readmo] breaker: 4xx body not readable as PostgREST error, counting as failure:',
      err instanceof Error ? err.message : String(err),
    );
    void copy.body?.cancel().catch(() => {});
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function isHealthyResponse(status: number): boolean {
  return status < 400;
}

function boundedReadFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init?.signal ?? undefined;
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException('Supabase request timed out', 'TimeoutError'),
      ),
    REQUEST_TIMEOUT_MS,
  );
  // Lie-fi hedge: adjudicate reachability while the read is still in flight
  // (see HEDGE_PROBE_MS). Cleared with the cap timer when the read settles.
  const hedgeTimer = setTimeout(() => reportFetchSlow(), HEDGE_PROBE_MS);
  return trackedFetch(input, { ...init, signal: controller.signal }).finally(
    () => {
      clearTimeout(timer);
      clearTimeout(hedgeTimer);
      callerSignal?.removeEventListener('abort', forwardAbort);
    },
  );
}

export function supabaseFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Everything that isn't a bounded read is uncapped exactly as before — no read
  // timeout, no breaker:
  //   - WRITES (rpc/set_item_state, rpc/subscribe_to_feed, subscription
  //     PATCH/DELETE) are owned by the item-state outbox (its own backoff +
  //     durability); shedding one would surface a spurious local failure on a
  //     subscription edit and just delay outbox delivery.
  //   - AUTH (/auth/v1/) must stay reachable to refresh/sign-out and recover an
  //     expired-token storm — exactly when the breaker is open — as must the
  //     /auth/v1/health connectivity probe. Edge Functions/storage/realtime too.
  if (!isBoundedRead(input, init)) {
    // Item-state writes get `keepalive` so a triage toggle (mark done / pin)
    // issued in the moments before the tab is closed or backgrounded still
    // reaches the server, rather than being canceled with the page and left to
    // replay only on the next boot. The outbox also flushes on
    // `visibilitychange`→hidden (SupabaseDataSource), so an in-flight write is
    // already started when the page begins to unload; keepalive lets it finish.
    if (isItemStateWrite(input, init)) {
      return trackedFetch(input, { ...init, keepalive: true });
    }
    return trackedFetch(input, init);
  }

  // A bounded read: the 8s timeout AND the breaker, whatever the path. Whether a
  // *success* counts as evidence the backend recovered depends on the path (see
  // isNetworkAuthoritativeRead) — a NetworkFirst-cached read can be answered from
  // the SW cache, so its success settles as inconclusive. Failures count either
  // way: the cache can fake a 200, never a failure.
  const authoritative = isNetworkAuthoritativeRead(input, init);

  const ticket = requestBreaker.shouldAllow();
  if (ticket === null) {
    // Not admitted. Two cases:
    const probeWait = requestBreaker.probeWait();
    if (probeWait) {
      // Half-open: a single probe is in flight. HOLD this peer read until the
      // probe settles, then re-decide — rather than failing it now and relying
      // on its (short) retry budget to outlast a healthy-but-slow probe. The
      // wait is bounded by the probe's own 8s read cap, and on re-entry it's
      // admitted (probe closed the circuit) or shed (probe re-opened it).
      return probeWait.then(() => supabaseFetch(input, init));
    }
    // Open + cooling down: shed with a RETRIABLE statusless error (queryRetry
    // treats it as a transient blip — NOT an AbortError) so a real outage fails
    // fast but recovers on the next refetch. Sheds never reach the network, so
    // retrying them adds no DB load.
    return Promise.reject(
      new Error('Supabase request shed: backend circuit open'),
    );
  }
  return boundedReadFetch(input, init).then(
    async (res) => {
      if (isHealthyResponse(res.status)) {
        // On a cacheable read this may be the service worker's NetworkFirst
        // fallback — a `200` the backend never saw — so it proves nothing about
        // backend health and settles as inconclusive. Only a read the SW never
        // serves from cache can close the circuit.
        if (authoritative) requestBreaker.settle(ticket, true);
        else requestBreaker.settleInconclusive(ticket);
      } else if (
        authoritative ||
        res.status >= 500 ||
        !isSchemaMismatchStatus(res.status)
      ) {
        // Includes 401/403 on a cacheable table: an expired-token loop is the
        // exact failure class that melted the backend, and it must still trip.
        requestBreaker.settle(ticket, false);
      } else if (await isSchemaMismatchResponse(res)) {
        // A schema-mismatch 4xx on a cacheable table read is not backend-failure
        // evidence — it's a disagreement about the schema, and this app generates
        // those on purpose. `getSyncedSettings` walks a projection ladder against
        // `user_settings`, taking an expected coded 4xx per rung until it finds
        // one the deployed backend can serve (guardrail 11 feature detection).
        // Counting those would let a backend that is merely OLDER than the client
        // trip a breaker meant for one that is FAILING, and shed reads for it.
        //
        // The 4xx-counts-as-failure rule survives where it was argued for: the
        // authoritative reads, where a PostgREST 404 means the feed_items RPC
        // itself is missing and a refetch loop would repeat forever. Nothing
        // capability-probes those — the ladder only ever runs against tables.
        //
        // Not silently discarded either: a 4xx cannot come from the Workbox
        // cache (it serves 200s), so the backend demonstrably answered. That is
        // liveness evidence, which is exactly what `settleInconclusive` records.
        requestBreaker.settleInconclusive(ticket);
      } else {
        // Same status, no schema code: an ordinary failed read (a malformed
        // query, a 404 on something that should exist). A loop on one is what
        // the breaker is for.
        requestBreaker.settle(ticket, false);
      }
      return res;
    },
    (err) => {
      // A caller/cancellation abort (e.g. React Query superseding a query via
      // the forwarded signal) is neither a failure nor a success; settleCanceled
      // records it as such and re-arms a canceled half-open probe so the breaker
      // can't get stuck. Our own shed returns before the fetch and the read
      // timeout aborts with TimeoutError (a real failure), so AbortError here is
      // always a caller cancel.
      if (isAbortError(err)) requestBreaker.settleCanceled(ticket);
      else requestBreaker.settle(ticket, false);
      throw err;
    },
  );
}

let client: SupabaseClient | null = null;

/** The shared client. Throws if called while unconfigured — callers gate on
 * `isSupabaseConfigured()` first. */
export function getSupabase(): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured: set VITE_SUPABASE_URL and ' +
        'VITE_SUPABASE_ANON_KEY (see .env.example).',
    );
  }
  if (!client) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Complete the OAuth redirect: parse the session from the URL on the
        // landing load.
        detectSessionInUrl: true,
        storageKey: AUTH_STORAGE_KEY,
      },
      // Connectivity-track every request and bound reads (GET + feed_items RPC)
      // so a hung network can't strand a read on its loading skeletons forever
      // (writes/auth/functions stay uncapped — see supabaseFetch).
      //
      // Stamp the build number on every request so the backend can shed an old
      // client shipped with a runaway-refetch bug: the Edge functions gate on
      // it (supabase/functions/_shared/clientVersion.ts) and a gateway can gate
      // the read RPC the same way. Header name is duplicated as a literal here
      // because src/ and supabase/functions/ build separately — keep it in sync
      // with CLIENT_BUILD_HEADER ('x-readmo-build').
      global: {
        fetch: supabaseFetch,
        headers: { 'x-readmo-build': String(buildInfo.commitCount) },
      },
    });
  }
  return client;
}
