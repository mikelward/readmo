import { describe, it, expect } from 'vitest';
import {
  BASE_RETRY_DELAY_MS,
  MAX_QUERY_RETRIES,
  MAX_RETRY_DELAY_MS,
  computeRetryDelay,
  httpStatusOf,
  isRetriableError,
  retryDelayMs,
  shouldRetryQuery,
} from './queryRetry';

describe('httpStatusOf', () => {
  it('extracts a numeric status', () => {
    expect(httpStatusOf({ status: 401 })).toBe(401);
  });
  it('returns undefined for a statusless / non-numeric error', () => {
    expect(httpStatusOf(new Error('network'))).toBeUndefined();
    expect(httpStatusOf({ status: 'oops' })).toBeUndefined();
    expect(httpStatusOf(null)).toBeUndefined();
  });
});

describe('isRetriableError', () => {
  it('never retries a 4xx (the loop class — esp. 401/403)', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(isRetriableError({ status })).toBe(false);
    }
  });

  it('never retries a 5xx', () => {
    expect(isRetriableError({ status: 500 })).toBe(false);
    expect(isRetriableError({ status: 503 })).toBe(false);
  });

  it('never retries a timeout or a circuit-breaker shed (DOMException or Error shape)', () => {
    expect(isRetriableError(new DOMException('timed out', 'TimeoutError'))).toBe(false);
    expect(isRetriableError(new DOMException('shed', 'AbortError'))).toBe(false);
    // Some runtimes surface an aborted fetch as a plain Error named AbortError.
    expect(isRetriableError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
    expect(isRetriableError(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toBe(false);
  });

  it('retries a statusless transient (network) error', () => {
    expect(isRetriableError(new Error('Failed to fetch'))).toBe(true);
    expect(isRetriableError(new TypeError('NetworkError'))).toBe(true);
  });

  it('does not retry a server-coded error even when the status was dropped', () => {
    // SupabaseDataSource.unwrap may surface a PostgREST error as a statusless
    // Error carrying only a `code` — that's a server-processed error, not a blip.
    const coded = Object.assign(new Error('permission denied'), { code: '42501' });
    expect(isRetriableError(coded)).toBe(false);
    // PGRST string codes too.
    expect(isRetriableError({ code: 'PGRST301', message: 'JWT expired' })).toBe(false);
  });
});

describe('shouldRetryQuery', () => {
  it('retries transient errors up to the cap, then stops', () => {
    const err = new Error('network');
    expect(shouldRetryQuery(0, err)).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES - 1, err)).toBe(true);
    expect(shouldRetryQuery(MAX_QUERY_RETRIES, err)).toBe(false);
  });

  it('never retries a 401, regardless of count', () => {
    expect(shouldRetryQuery(0, { status: 401 })).toBe(false);
  });
});

describe('computeRetryDelay', () => {
  it('grows exponentially and is capped', () => {
    // rand=1 → top of the jitter window (the full capped value).
    const top = (n: number) => computeRetryDelay(n, () => 1);
    expect(top(0)).toBe(BASE_RETRY_DELAY_MS);
    expect(top(1)).toBe(BASE_RETRY_DELAY_MS * 2);
    expect(top(2)).toBe(BASE_RETRY_DELAY_MS * 4);
    // Far-out attempt is clamped to the ceiling.
    expect(top(100)).toBe(MAX_RETRY_DELAY_MS);
  });

  it('jitters within the upper half of the window', () => {
    // rand=0 → bottom of the jitter window (half the capped value).
    expect(computeRetryDelay(0, () => 0)).toBe(BASE_RETRY_DELAY_MS / 2);
    expect(computeRetryDelay(0, () => 1)).toBe(BASE_RETRY_DELAY_MS);
  });

  it('never exceeds the cap even with max jitter', () => {
    expect(computeRetryDelay(100, () => 1)).toBeLessThanOrEqual(MAX_RETRY_DELAY_MS);
  });

  it('retryDelayMs (React Query wrapper) ignores the unused error arg', () => {
    // RQ calls it as (failureCount, error); the wrapper takes only failureCount.
    expect(retryDelayMs(0)).toBeGreaterThanOrEqual(BASE_RETRY_DELAY_MS / 2);
    expect(retryDelayMs(0)).toBeLessThanOrEqual(BASE_RETRY_DELAY_MS);
  });
});
