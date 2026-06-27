// A tiny concurrency limiter: run at most `maxConcurrent` async tasks at once,
// queueing the rest FIFO. Used to bound the offline warm-path fan-out
// (useOfflineCacheLock) so saving many items doesn't fire one getItem +
// fetchFullText per item all at once and flood the backend on boot/reconnect.
//
// No dependency, no timers — `run` resolves/rejects with its task's outcome, and
// a slot is freed whether the task fulfills or throws, so one failing task never
// wedges the queue.

export interface ConcurrencyLimiter {
  /**
   * Schedule `task`. It starts immediately if a slot is free, otherwise waits
   * in FIFO order. The returned promise settles with the task's result (or
   * rejects with its error); either way the slot is released afterward.
   */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks currently running (0..maxConcurrent). For tests/telemetry. */
  readonly activeCount: number;
  /** Tasks waiting for a free slot. For tests/telemetry. */
  readonly pendingCount: number;
}

export function createConcurrencyLimiter(maxConcurrent: number): ConcurrencyLimiter {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(`maxConcurrent must be a positive integer, got ${maxConcurrent}`);
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const pump = (): void => {
    if (active >= maxConcurrent) return;
    const start = queue.shift();
    if (!start) return;
    active += 1;
    start();
  };

  function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        // Wrap in Promise.resolve().then so a task that throws synchronously is
        // treated the same as a rejected promise (slot still freed).
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      });
      pump();
    });
  }

  return {
    run,
    get activeCount() {
      return active;
    },
    get pendingCount() {
      return queue.length;
    },
  };
}
