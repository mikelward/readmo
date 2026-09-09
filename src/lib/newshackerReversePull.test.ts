import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestReversePull,
  REVERSE_PULL_RETRY_DELAYS_MS,
  _resetReversePullForTests,
} from './newshackerReversePull';
import {
  markReverseSyncPending,
  isReverseSyncPending,
  getReverseSyncPendingIds,
  _resetReverseSyncPendingForTests,
} from './newshackerReverseSyncPending';
import type { ItemStateStore } from './data/itemState';
import type { ItemId, ItemState } from './types';

const BASE: ItemState = {
  pinned: false,
  pinnedAt: null,
  favorite: false,
  favoriteAt: null,
  done: false,
  doneAt: null,
  hidden: false,
  hiddenAt: null,
  opened: false,
  openedAt: null,
};

function makeDs() {
  const states = new Map<ItemId, ItemState>();
  const stateStore = {
    get: (id: ItemId) => states.get(id) ?? BASE,
  } as unknown as ItemStateStore;
  const pull = vi.fn<
    () => Promise<{ linked: boolean; applied: number; ok?: boolean }>
  >(async () => ({ linked: true, applied: 0 }));
  return {
    ds: { stateStore, pullNewshackerState: pull },
    states,
    pull,
  };
}

describe('requestReversePull', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
    _resetReverseSyncPendingForTests();
    _resetReversePullForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.sessionStorage.clear();
    _resetReverseSyncPendingForTests();
    _resetReversePullForTests();
  });

  it('pulls once and schedules no retries when nothing is pending', async () => {
    const { ds, pull } = makeDs();
    await requestReversePull(ds);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('resolves a marker whose item state changed across the pull, without retrying', async () => {
    const { ds, states, pull } = makeDs();
    markReverseSyncPending('a');
    pull.mockImplementationOnce(async () => {
      // The pull's re-hydrate lands the Done that was made on newshacker.
      states.set('a', { ...BASE, done: true, doneAt: 123 });
      return { linked: true, applied: 1 };
    });

    await requestReversePull(ds);
    await vi.advanceTimersByTimeAsync(0);
    expect(isReverseSyncPending('a')).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('race loser heals: an unresolved marker triggers a retry that observes the change', async () => {
    const { ds, states, pull } = makeDs();
    markReverseSyncPending('a');
    // Pull #1 races newshacker's own upload and sees nothing; pull #2 sees it.
    pull
      .mockImplementationOnce(async () => ({ linked: true, applied: 0 }))
      .mockImplementationOnce(async () => {
        states.set('a', { ...BASE, done: true, doneAt: 456 });
        return { linked: true, applied: 1 };
      });

    void requestReversePull(ds);
    await vi.advanceTimersByTimeAsync(0);
    expect(isReverseSyncPending('a')).toBe(true); // not resolved against stale state

    await vi.advanceTimersByTimeAsync(REVERSE_PULL_RETRY_DELAYS_MS[0]);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(isReverseSyncPending('a')).toBe(false);

    // Resolution stops the ladder — no third pull.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('a ladder that completes with no observed change resolves the survivors', async () => {
    const { ds, pull } = makeDs();
    markReverseSyncPending('a');

    void requestReversePull(ds);
    await vi.advanceTimersByTimeAsync(0);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(isReverseSyncPending('a')).toBe(true);

    await vi.advanceTimersByTimeAsync(REVERSE_PULL_RETRY_DELAYS_MS[0]);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(isReverseSyncPending('a')).toBe(true);

    await vi.advanceTimersByTimeAsync(REVERSE_PULL_RETRY_DELAYS_MS[1]);
    expect(pull).toHaveBeenCalledTimes(3);
    // Three clean pulls with nothing observed: "no change" IS the answer.
    expect(isReverseSyncPending('a')).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pull).toHaveBeenCalledTimes(3);
  });

  it('a failed pull resolves nothing and schedules no retries', async () => {
    const { ds, pull } = makeDs();
    markReverseSyncPending('a');
    pull.mockRejectedValueOnce(new Error('offline'));

    await requestReversePull(ds);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(pull).toHaveBeenCalledTimes(1);
    // Marker survives for the next focus/online/PTR trigger.
    expect(isReverseSyncPending('a')).toBe(true);
  });

  it('treats { linked: true, ok: false } (backend reached, newshacker not) as a failed pull', async () => {
    // The Edge Function soft-fails its own outbound fetch of newshacker (or
    // the apply RPC) to a 200 with linked:true, applied:0 — the `ok` flag is
    // what distinguishes that outage from "answered, nothing new".
    const { ds, pull } = makeDs();
    markReverseSyncPending('a');
    pull.mockResolvedValue({ linked: true, applied: 0, ok: false });

    await requestReversePull(ds);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(pull).toHaveBeenCalledTimes(1);
    expect(isReverseSyncPending('a')).toBe(true);
  });

  it('treats a missing ok flag (older backend) as consulted', async () => {
    const { ds, pull } = makeDs();
    markReverseSyncPending('a');
    // No `ok` in the response at all — a not-yet-redeployed Edge Function.
    pull.mockResolvedValue({ linked: true, applied: 0 });

    void requestReversePull(ds);
    await vi.advanceTimersByTimeAsync(0);
    // Ladder advances (pre-flag behavior): retries run and the terminal
    // "no change" resolution still lands.
    await vi.advanceTimersByTimeAsync(REVERSE_PULL_RETRY_DELAYS_MS[0]);
    await vi.advanceTimersByTimeAsync(REVERSE_PULL_RETRY_DELAYS_MS[1]);
    expect(pull).toHaveBeenCalledTimes(3);
    expect(isReverseSyncPending('a')).toBe(false);
  });

  it('treats a best-effort { linked: false } return as a failed pull', async () => {
    // The live source never throws — offline/backend-down comes back as
    // { linked: false, applied: 0 }. That must not advance the ladder or end
    // in the terminal "no change" clear.
    const { ds, pull } = makeDs();
    markReverseSyncPending('a');
    pull.mockResolvedValue({ linked: false, applied: 0 });

    await requestReversePull(ds);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(pull).toHaveBeenCalledTimes(1);
    expect(isReverseSyncPending('a')).toBe(true);
  });

  it('still resolves a marker whose state changed even when the pull failed', async () => {
    // Evidence beats transport: a concurrent item-state resync can deliver
    // the answer while the reverse pull itself errors out.
    const { ds, states, pull } = makeDs();
    markReverseSyncPending('a');
    pull.mockImplementationOnce(async () => {
      states.set('a', { ...BASE, done: true, doneAt: 789 });
      return { linked: false, applied: 0 };
    });

    await requestReversePull(ds);
    await vi.advanceTimersByTimeAsync(0);

    expect(isReverseSyncPending('a')).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('skips the retry when the tab went hidden mid-ladder, keeping the marker', async () => {
    const { ds, pull } = makeDs();
    markReverseSyncPending('a');

    void requestReversePull(ds);
    await vi.advanceTimersByTimeAsync(0);
    expect(pull).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pull).toHaveBeenCalledTimes(1);
      expect(isReverseSyncPending('a')).toBe(true);
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
    }
  });

  it('coalesces overlapping requests onto the in-flight run', async () => {
    const { ds, pull } = makeDs();
    // Hold the first pull open so the second request arrives mid-flight.
    let release!: () => void;
    pull.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ linked: true, applied: 0 });
        }),
    );

    const p1 = requestReversePull(ds);
    const p2 = requestReversePull(ds);
    expect(p2).toBe(p1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('settles the caller after the FIRST pull even while the ladder continues', async () => {
    const { ds, pull } = makeDs();
    markReverseSyncPending('a');

    let settled = false;
    void requestReversePull(ds).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    // First pull done, caller released — but the ladder is still pending.
    expect(settled).toBe(true);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(getReverseSyncPendingIds()).toEqual(['a']);
  });

  it('an unrelated favorite change is not evidence and does not settle the card', async () => {
    // The pull never writes favorites — a cross-device favorite arriving via
    // a concurrent resync says nothing about the handoff question.
    const { ds, states, pull } = makeDs();
    markReverseSyncPending('a');
    pull.mockImplementationOnce(async () => {
      states.set('a', { ...BASE, favorite: true, favoriteAt: 42 });
      return { linked: true, applied: 0 };
    });

    void requestReversePull(ds);
    await vi.advanceTimersByTimeAsync(0);

    expect(isReverseSyncPending('a')).toBe(true); // marker survives
    // The ladder keeps retrying as usual.
    await vi.advanceTimersByTimeAsync(REVERSE_PULL_RETRY_DELAYS_MS[0]);
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('no-ops when the source has no pull capability', async () => {
    const { ds } = makeDs();
    await requestReversePull({ stateStore: ds.stateStore });
    expect(getReverseSyncPendingIds()).toEqual([]);
  });
});
