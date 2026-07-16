import { describe, expect, it } from 'vitest';
import { isSummarySettled, summaryStaleTime, type SummaryResult } from './summary';

function q(data?: SummaryResult) {
  return { state: { data } };
}

describe('isSummarySettled', () => {
  it('treats terminal ok/empty/blocked as settled', () => {
    expect(isSummarySettled({ status: 'ok', summary: 'x' })).toBe(true);
    expect(isSummarySettled({ status: 'empty', summary: null })).toBe(true);
    // A blocked page won't become readable on a retry — terminal, no polling.
    expect(isSummarySettled({ status: 'blocked', summary: null, site: 'reddit.com' })).toBe(true);
  });

  it('treats transient unreachable as unsettled', () => {
    expect(isSummarySettled({ status: 'unreachable', summary: null })).toBe(false);
  });

  it('treats an unflagged `unavailable` (key unset) as settled — polling cannot set an API key', () => {
    expect(isSummarySettled({ status: 'unavailable', summary: null })).toBe(true);
  });

  it('treats a retryable-flagged `unavailable` (older backend) as unsettled', () => {
    expect(
      isSummarySettled({ status: 'unavailable', summary: null, retryable: true }),
    ).toBe(false);
  });

  it('treats a retryable-flagged result as unsettled (e.g. allowlist denial)', () => {
    expect(isSummarySettled({ status: 'empty', summary: null, retryable: true })).toBe(false);
  });

  it('treats a viaRow seed as unsettled (provisional — the real fetch is still wanted)', () => {
    expect(isSummarySettled({ status: 'ok', summary: 'x', viaRow: true })).toBe(false);
  });
});

describe('summaryStaleTime', () => {
  it('is 0 with no data yet (so the first fetch runs)', () => {
    expect(summaryStaleTime(q(undefined))).toBe(0);
  });

  it('caches terminal ok/empty/blocked forever', () => {
    expect(summaryStaleTime(q({ status: 'ok', summary: 'x' }))).toBe(Infinity);
    expect(summaryStaleTime(q({ status: 'empty', summary: null }))).toBe(Infinity);
    expect(
      summaryStaleTime(q({ status: 'blocked', summary: null, site: 'reddit.com' })),
    ).toBe(Infinity);
  });

  it('keeps transient unreachable stale for retry', () => {
    expect(summaryStaleTime(q({ status: 'unreachable', summary: null }))).toBe(0);
  });

  it('keeps `unavailable` stale (flagged or not) so explicit triggers can recover it', () => {
    // Settled (no polling loop) but stale: an Infinity-fresh `unavailable` on a
    // pinned item would be GC-locked forever and never re-check after the
    // operator sets the key. Stale means a boot warm / pinned open / Generate
    // click re-checks once and recovers.
    expect(summaryStaleTime(q({ status: 'unavailable', summary: null }))).toBe(0);
    expect(
      summaryStaleTime(q({ status: 'unavailable', summary: null, retryable: true })),
    ).toBe(0);
  });

  it('keeps a retryable-flagged result stale (e.g. an allowlist denial)', () => {
    expect(
      summaryStaleTime(q({ status: 'empty', summary: null, retryable: true })),
    ).toBe(0);
  });

  it('keeps a viaRow seed stale so it revalidates when the query runs', () => {
    expect(summaryStaleTime(q({ status: 'ok', summary: 'x', viaRow: true }))).toBe(0);
  });
});
