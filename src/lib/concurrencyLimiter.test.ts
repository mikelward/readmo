// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createConcurrencyLimiter } from './concurrencyLimiter';

/** A task whose resolution the test controls via the returned `release`. */
function deferred() {
  let resolve!: (v?: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res as () => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain enough microtask hops for the limiter's internal then/finally chain to
 *  settle and admit the next queued task. */
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('createConcurrencyLimiter', () => {
  it('rejects a non-positive or non-integer limit', () => {
    expect(() => createConcurrencyLimiter(0)).toThrow();
    expect(() => createConcurrencyLimiter(-1)).toThrow();
    expect(() => createConcurrencyLimiter(1.5)).toThrow();
  });

  it('runs at most `maxConcurrent` tasks at once and queues the rest', async () => {
    const limiter = createConcurrencyLimiter(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let started = 0;

    const results = gates.map((g) =>
      limiter.run(async () => {
        started += 1;
        await g.promise;
        return started;
      }),
    );

    // Only 2 start immediately; the other 2 wait for a free slot.
    await flush();
    expect(started).toBe(2);
    expect(limiter.activeCount).toBe(2);
    expect(limiter.pendingCount).toBe(2);

    // Free one slot → exactly one queued task starts.
    gates[0].resolve();
    await flush();
    expect(started).toBe(3);
    expect(limiter.activeCount).toBe(2);
    expect(limiter.pendingCount).toBe(1);

    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    await Promise.all(results);
    expect(started).toBe(4);
    expect(limiter.activeCount).toBe(0);
    expect(limiter.pendingCount).toBe(0);
  });

  it('frees the slot when a task rejects, so the queue keeps draining', async () => {
    const limiter = createConcurrencyLimiter(1);
    const first = limiter.run(async () => {
      throw new Error('boom');
    });
    const second = limiter.run(async () => 'ok');

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
    expect(limiter.activeCount).toBe(0);
    expect(limiter.pendingCount).toBe(0);
  });

  it('frees the slot when a task throws synchronously', async () => {
    const limiter = createConcurrencyLimiter(1);
    const first = limiter.run(() => {
      throw new Error('sync boom');
    });
    const second = limiter.run(async () => 'after');

    await expect(first).rejects.toThrow('sync boom');
    await expect(second).resolves.toBe('after');
  });

  it('preserves FIFO order of queued tasks', async () => {
    const limiter = createConcurrencyLimiter(1);
    const order: number[] = [];
    const runs = [0, 1, 2, 3].map((n) =>
      limiter.run(async () => {
        order.push(n);
      }),
    );
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('returns each task’s own result', async () => {
    const limiter = createConcurrencyLimiter(3);
    const results = await Promise.all([
      limiter.run(async () => 'a'),
      limiter.run(async () => 'b'),
      limiter.run(async () => 'c'),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
  });
});
