import { describe, expect, it, vi } from 'vitest';
import { retryWhile } from './retry';

// A sleep that records the backoff delays instead of waiting, so the schedule is
// asserted without real timers.
function recordingSleep() {
  const delays: number[] = [];
  return { delays, sleep: (ms: number) => (delays.push(ms), Promise.resolve()) };
}

describe('retryWhile', () => {
  it('runs once and does not sleep when the first result is not retryable', async () => {
    const { delays, sleep } = recordingSleep();
    const run = vi.fn(async () => 'ok');
    const out = await retryWhile(run, (r) => r === 'unreachable', { sleep });
    expect(out).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('retries while the result is transient, up to `attempts`, and returns the last', async () => {
    const { delays, sleep } = recordingSleep();
    const run = vi.fn(async () => 'unreachable');
    const out = await retryWhile(run, (r) => r === 'unreachable', {
      attempts: 3,
      baseMs: 1000,
      sleep,
    });
    // 3 total attempts (1 + 2 retries); exponential backoff 1s, 2s.
    expect(run).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1000, 2000]);
    expect(out).toBe('unreachable');
  });

  it('stops as soon as a retry succeeds', async () => {
    const { delays, sleep } = recordingSleep();
    const results = ['unreachable', 'ok'];
    const run = vi.fn(async () => results.shift()!);
    const out = await retryWhile(run, (r) => r === 'unreachable', {
      attempts: 3,
      baseMs: 500,
      sleep,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([500]); // one backoff before the successful retry
    expect(out).toBe('ok');
  });

  it('never retries a permanent result even when attempts remain', async () => {
    const { delays, sleep } = recordingSleep();
    const run = vi.fn(async () => 'empty'); // terminal, not classified transient
    const out = await retryWhile(run, (r) => r === 'unreachable', { attempts: 3, sleep });
    expect(run).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
    expect(out).toBe('empty');
  });

  it('honors attempts:1 (no retries)', async () => {
    const { delays, sleep } = recordingSleep();
    const run = vi.fn(async () => 'unreachable');
    await retryWhile(run, () => true, { attempts: 1, sleep });
    expect(run).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});
