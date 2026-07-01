import { describe, expect, it } from 'vitest';
import { formatPendingWrites } from './pendingWrites';

describe('formatPendingWrites', () => {
  it('reads N/A when the source has no outbox (mock data)', () => {
    expect(formatPendingWrites(undefined)).toBe('n/a (mock data)');
  });

  it('reads "none" when the outbox is drained', () => {
    expect(formatPendingWrites(0)).toBe('none');
  });

  it('shows the queued count when writes are still pending', () => {
    expect(formatPendingWrites(1)).toBe('1');
    expect(formatPendingWrites(7)).toBe('7');
  });
});
