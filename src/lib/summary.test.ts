import { describe, expect, it } from 'vitest';
import { summaryStaleTime, type SummaryResult } from './summary';

function q(data?: SummaryResult) {
  return { state: { data } };
}

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
