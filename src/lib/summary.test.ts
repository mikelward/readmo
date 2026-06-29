import { describe, expect, it } from 'vitest';
import { isSummarySettled, summaryStaleTime, type SummaryResult } from './summary';

function q(data?: SummaryResult) {
  return { state: { data } };
}

describe('isSummarySettled', () => {
  it('treats terminal ok/empty as settled', () => {
    expect(isSummarySettled({ status: 'ok', summary: 'x' })).toBe(true);
    expect(isSummarySettled({ status: 'empty', summary: null })).toBe(true);
  });

  it('treats transient unreachable/unavailable as unsettled', () => {
    expect(isSummarySettled({ status: 'unreachable', summary: null })).toBe(false);
    expect(isSummarySettled({ status: 'unavailable', summary: null })).toBe(false);
  });

  it('treats a retryable-flagged result as unsettled (e.g. allowlist denial)', () => {
    expect(isSummarySettled({ status: 'empty', summary: null, retryable: true })).toBe(false);
  });
});

describe('summaryStaleTime', () => {
  it('is 0 with no data yet (so the first fetch runs)', () => {
    expect(summaryStaleTime(q(undefined))).toBe(0);
  });

  it('caches terminal ok/empty forever', () => {
    expect(summaryStaleTime(q({ status: 'ok', summary: 'x' }))).toBe(Infinity);
    expect(summaryStaleTime(q({ status: 'empty', summary: null }))).toBe(Infinity);
  });

  it('keeps transient unreachable/unavailable stale for retry', () => {
    expect(summaryStaleTime(q({ status: 'unreachable', summary: null }))).toBe(0);
    expect(summaryStaleTime(q({ status: 'unavailable', summary: null }))).toBe(0);
  });

  it('keeps a retryable-flagged result stale (e.g. an allowlist denial)', () => {
    expect(
      summaryStaleTime(q({ status: 'empty', summary: null, retryable: true })),
    ).toBe(0);
  });
});
