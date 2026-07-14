// Generic transient-failure retry with exponential backoff — shared, pure logic.
//
// Runs `run`, and while `shouldRetry(result)` is true, waits (baseMs, then
// doubling) and re-runs, up to `attempts` total invocations. Returns the last
// result. The caller decides what "transient" means via `shouldRetry`, so a
// permanent outcome (a paywall `empty`, an unconfigured `unavailable`, an
// allowlist denial) is never retried — only the results the caller classifies as
// worth another attempt.
//
// The clock (`sleep`) is injected so the same code runs under Deno and vitest,
// and tests can advance a virtual clock instead of waiting on real timers.

export interface RetryConfig {
  /** Total attempts including the first (default 3 = 1 initial + 2 retries). */
  attempts?: number;
  /** First backoff delay in ms; doubles each retry (default 1000 → 1s, 2s, …). */
  baseMs?: number;
  /** Sleep `ms`. Injected for testability. */
  sleep: (ms: number) => Promise<void>;
}

/**
 * Retry `run` while `shouldRetry` says its result is a transient failure, with
 * exponential backoff between attempts. Returns the last result (success, or the
 * final failure once attempts are exhausted).
 */
export async function retryWhile<T>(
  run: () => Promise<T>,
  shouldRetry: (result: T) => boolean,
  cfg: RetryConfig,
): Promise<T> {
  const attempts = Math.max(1, cfg.attempts ?? 3);
  const baseMs = cfg.baseMs ?? 1_000;
  let result = await run();
  for (let attempt = 1; attempt < attempts && shouldRetry(result); attempt++) {
    await cfg.sleep(baseMs * 2 ** (attempt - 1));
    result = await run();
  }
  return result;
}
