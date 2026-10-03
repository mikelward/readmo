// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetSyncDiagnosticsForTests,
  describeSyncError,
  formatSyncChannel,
  getSyncStats,
  isSyncChannelFailing,
  recordSync,
} from './syncDiagnostics';

describe('describeSyncError', () => {
  it('leads with a PostgREST code and keeps the message', () => {
    expect(
      describeSyncError({
        code: '57014',
        message: 'canceling statement due to statement timeout',
        details: 'Key (user_id)=(secret) leaked',
        hint: 'never shown',
      }),
    ).toBe('57014: canceling statement due to statement timeout');
  });

  it('never includes details or hint, which can echo row values', () => {
    const out = describeSyncError({ code: '23505', message: 'dup', details: 'row values', hint: 'x' });
    expect(out).not.toContain('row values');
    expect(out).not.toContain('x');
  });

  it('redacts item uuids, which open the shared-item view', () => {
    const out = describeSyncError({
      code: '42501',
      message: 'item 3f2a9c1e-0b7d-4e5f-9a8b-1c2d3e4f5a6b not visible to caller',
    });
    expect(out).toBe('42501: item <id> not visible to caller');
    expect(describeSyncError('apply 3F2A9C1E-0B7D-4E5F-9A8B-1C2D3E4F5A6B')).toBe('apply <id>');
  });

  it('reads an Edge Function error status from its response context', () => {
    expect(
      describeSyncError({
        name: 'FunctionsHttpError',
        message: 'Edge Function returned a non-2xx status code',
        context: { status: 503 },
      }),
    ).toBe('HTTP 503: Edge Function returned a non-2xx status code');
  });

  it('falls back to the error name for a network failure', () => {
    expect(describeSyncError(new TypeError('Failed to fetch'))).toBe(
      'TypeError: Failed to fetch',
    );
  });

  it('passes a string through and truncates long text', () => {
    expect(describeSyncError('apply 57014')).toBe('apply 57014');
    const long = describeSyncError({ message: 'x'.repeat(500) });
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('…')).toBe(true);
  });

  it('describes something unrecognizable as unknown', () => {
    expect(describeSyncError(undefined)).toBe('unknown error');
    expect(describeSyncError({})).toBe('unknown error');
  });
});

describe('recordSync / formatSyncChannel', () => {
  const NOW = Date.parse('2026-10-03T12:00:00Z');

  beforeEach(() => {
    _resetSyncDiagnosticsForTests();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads "not yet" before anything is recorded', () => {
    const s = getSyncStats('write');
    expect(formatSyncChannel(s, NOW)).toBe('not yet');
    expect(isSyncChannelFailing(s)).toBe(false);
  });

  it('shows the last success', () => {
    recordSync('refresh', true);
    const s = getSyncStats('refresh');
    expect(formatSyncChannel(s, NOW + 60_000)).toMatch(/^ok .*ago$/);
    expect(isSyncChannelFailing(s)).toBe(false);
  });

  it('counts failures and shows the latest one with its detail', () => {
    recordSync('newshackerPull', true);
    vi.setSystemTime(NOW + 1000);
    recordSync('newshackerPull', false, 'fetch HTTP 503');
    vi.setSystemTime(NOW + 2000);
    recordSync('newshackerPull', false, { code: '57014', message: 'timeout' });
    const s = getSyncStats('newshackerPull');
    expect(s.failures).toBe(2);
    expect(isSyncChannelFailing(s)).toBe(true);
    const text = formatSyncChannel(s, NOW + 3000);
    expect(text).toContain('2 failed');
    expect(text).toContain('57014: timeout');
    expect(text).not.toContain('503');
  });

  it('stops reading as failing once a later attempt succeeds', () => {
    recordSync('write', false, 'boom');
    vi.setSystemTime(NOW + 1000);
    recordSync('write', true);
    const s = getSyncStats('write');
    expect(isSyncChannelFailing(s)).toBe(false);
    // The failure stays visible as history.
    expect(formatSyncChannel(s, NOW + 2000)).toContain('1 failed');
  });

  it('keeps channels independent', () => {
    recordSync('write', false, 'boom');
    expect(getSyncStats('refresh').failures).toBe(0);
  });

  it('says so when a channel has only ever failed', () => {
    recordSync('newshackerPush', false, 'boom');
    expect(formatSyncChannel(getSyncStats('newshackerPush'), NOW)).toMatch(
      /^no success yet · 1 failed/,
    );
  });
});
