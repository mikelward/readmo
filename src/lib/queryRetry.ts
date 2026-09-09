// Retry policy for React Query (and anywhere we decide whether to retry a failed
// request). The flood that pinned the DB was failing requests retried without
// discipline; the rules here make sure a retry can never amplify into a loop:
//
//   - NEVER retry a request that returned an HTTP status error. A 4xx won't
//     change on retry — and a 401/403 (expired/invalid token) retried in a hot
//     loop is exactly what melted the backend. A 5xx / timed-out read won't
//     improve on an immediate retry either (matches the prior `shouldRetry`).
//   - Retry only true transient blips (a thrown network/connection error with no
//     status), and only a bounded number of times, with capped exponential
//     backoff + jitter so even those can't tighten into a spin.
//
// Pure + injectable RNG so it unit-tests deterministically.

/** Max automatic retries for a transient (statusless) query failure. */
export const MAX_QUERY_RETRIES = 2;
/** First backoff step; doubles each attempt up to MAX_RETRY_DELAY_MS. */
export const BASE_RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_DELAY_MS = 30_000;

/** Pull a numeric HTTP `status` off a PostgREST/Supabase error, if present. */
export function httpStatusOf(error: unknown): number | undefined {
  if (error != null && typeof error === 'object' && 'status' in error) {
    const s = (error as { status: unknown }).status;
    if (typeof s === 'number' && Number.isFinite(s)) return s;
  }
  return undefined;
}

/** The error's `name`, if it has one. Matches by name rather than constructor
 * because an aborted/timed-out fetch can surface as either a DOMException or a
 * plain Error depending on the runtime (the connectivity tracker does the same). */
function errorName(error: unknown): string | undefined {
  if (error != null && typeof error === 'object' && 'name' in error) {
    const n = (error as { name?: unknown }).name;
    if (typeof n === 'string') return n;
  }
  return undefined;
}

/** Whether the error carries a PostgREST/SQLSTATE `code`. Such an error was
 * processed by the server (a 4xx/5xx the data layer may have unwrapped into a
 * statusless Error), not a transient network blip — so don't retry it. */
function hasErrorCode(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0;
}

/** True when retrying this error could plausibly succeed (a transient network
 * blip). Any HTTP status error, a server-coded error, a timeout, or a
 * circuit-breaker shed is NOT retriable — retrying those is what turns a
 * failure into a flood. */
export function isRetriableError(error: unknown): boolean {
  // supabaseFetch aborts a hung read with TimeoutError; the circuit breaker
  // (and a caller cancel) abort with AbortError. Match by name so a plain-Error
  // shape (some runtimes) is caught too. Neither should be retried.
  const name = errorName(error);
  if (name === 'TimeoutError' || name === 'AbortError') return false;
  const status = httpStatusOf(error);
  if (status != null && status >= 400) return false; // 4xx and 5xx: don't retry
  if (hasErrorCode(error)) return false; // server-processed error, not a blip
  return true; // statusless, codeless → transient network/connection error
}

/** React Query `retry` predicate: bounded retries for transient errors only. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return isRetriableError(error) && failureCount < MAX_QUERY_RETRIES;
}

/** Capped exponential backoff with jitter (testable core; inject `rand`). */
export function computeRetryDelay(
  failureCount: number,
  rand: () => number = Math.random,
): number {
  const exp = BASE_RETRY_DELAY_MS * 2 ** Math.max(0, failureCount);
  const capped = Math.min(MAX_RETRY_DELAY_MS, exp);
  // Jitter across the upper half of the window so retries from many
  // tabs/queries don't synchronize into bursts.
  return Math.round(capped / 2 + (capped / 2) * rand());
}

/** React Query `retryDelay` (signature `(failureCount, error) => number`; the
 * error arg is unused). Kept separate from {@link computeRetryDelay} so the RNG
 * injection point can't collide with React Query's second argument. */
export function retryDelayMs(failureCount: number): number {
  return computeRetryDelay(failureCount);
}
