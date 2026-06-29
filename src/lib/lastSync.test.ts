// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatLastSync } from './lastSync';

describe('formatLastSync', () => {
  const now = Date.parse('2026-06-29T12:00:00Z');

  it('reports N/A when the source has no server to sync (mock data)', () => {
    expect(formatLastSync(undefined, now)).toBe('n/a (mock data)');
  });

  it('reports "not yet" when configured but no pull has completed', () => {
    expect(formatLastSync(null, now)).toBe('not yet');
  });

  it('renders a recent sync relatively', () => {
    expect(formatLastSync(now - 1_000, now)).toBe('just now');
    expect(formatLastSync(now - 3 * 60_000, now)).toBe('3 minutes ago');
    expect(formatLastSync(now - 2 * 60 * 60_000, now)).toBe('2 hours ago');
  });
});
