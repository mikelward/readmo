import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_OPEN_MODE_SNAPSHOT,
  subscribeOpenModeSnapshot,
  forgetFeedOpenModes,
  hasStoredOpenModeSnapshot,
  readOpenModeSnapshot,
  rememberFeedOpenModes,
  rememberOpenModes,
  resetOpenModeSnapshotForTest,
} from './openModeSnapshot';
import { OPEN_MODE_SNAPSHOT_KEY } from './userCache';
import type { Subscription } from './types';

function sub(feedId: string, flags: Partial<Subscription> = {}): { subscription: Subscription } {
  return {
    subscription: {
      feedId,
      folder: null,
      titleOverride: null,
      muted: false,
      openOriginal: false,
      openNewshacker: false,
      markDoneOnOpen: false,
      listLayout: null,
      sort: 0,
      ...flags,
    },
  };
}

describe('openModeSnapshot', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetOpenModeSnapshotForTest();
  });

  it('reads back the flags a subscriptions read carried', () => {
    rememberOpenModes(
      [
        sub('feed-hn', { openNewshacker: true, markDoneOnOpen: true }),
        sub('feed-blog', { openOriginal: true }),
        sub('feed-plain'),
      ],
    );
    resetOpenModeSnapshotForTest(); // as if this were the next boot

    const snapshot = readOpenModeSnapshot();
    expect([...snapshot.openNewshacker]).toEqual(['feed-hn']);
    expect([...snapshot.openOriginal]).toEqual(['feed-blog']);
    expect([...snapshot.markDoneOnOpen]).toEqual(['feed-hn']);
  });

  it('starts empty on a device that has never read subscriptions', () => {
    expect(readOpenModeSnapshot()).toBe(EMPTY_OPEN_MODE_SNAPSHOT);
  });

  it('lets a later completed read replace what was remembered', () => {
    rememberOpenModes([sub('feed-hn', { openNewshacker: true })]);
    rememberOpenModes([sub('feed-hn')]);
    expect(readOpenModeSnapshot().openNewshacker.size).toBe(0);
  });

  it('clears the modes when an authoritative read comes back empty', () => {
    // Unsubscribing from the last feed. A stale entry is not inert: a pinned or
    // favorited article outlives its subscription, so its library row would
    // still find the flag. (A read taken WITHOUT a session also comes back
    // empty — that one never reaches here; useOpenModeSnapshotSync holds it.)
    rememberOpenModes([sub('feed-hn', { openNewshacker: true })]);
    rememberOpenModes([]);
    expect(readOpenModeSnapshot().openNewshacker.size).toBe(0);
  });

  it('writes one feed from a settled mutation without touching the others', () => {
    rememberOpenModes(
      [
        sub('feed-hn', { openNewshacker: true }),
        sub('feed-blog', { openOriginal: true, markDoneOnOpen: true }),
      ],
    );
    rememberFeedOpenModes('feed-hn', {
      openOriginal: false,
      openNewshacker: false,
    });
    const snapshot = readOpenModeSnapshot();
    expect(snapshot.openNewshacker.size).toBe(0);
    expect([...snapshot.openOriginal]).toEqual(['feed-blog']);
    expect([...snapshot.markDoneOnOpen]).toEqual(['feed-blog']);
  });

  it('drops one feed on a settled unsubscribe', () => {
    rememberOpenModes(
      [
        sub('feed-hn', { openNewshacker: true, markDoneOnOpen: true }),
        sub('feed-blog', { openOriginal: true }),
      ],
    );
    forgetFeedOpenModes('feed-hn');
    const snapshot = readOpenModeSnapshot();
    expect(snapshot.openNewshacker.size).toBe(0);
    expect(snapshot.markDoneOnOpen.size).toBe(0);
    expect([...snapshot.openOriginal]).toEqual(['feed-blog']);
  });

  it('does not rewrite storage when nothing changed', () => {
    rememberOpenModes([sub('feed-hn', { openNewshacker: true })]);
    const written = window.localStorage.getItem(OPEN_MODE_SNAPSHOT_KEY);
    let writes = 0;
    window.addEventListener('readmo:open-modes-changed', () => {
      writes += 1;
    });
    // A background refetch returning the same flags — a fresh array each time,
    // so identity can't be what shortcuts it.
    rememberOpenModes([sub('feed-hn', { openNewshacker: true })]);
    expect(writes).toBe(0);
    expect(window.localStorage.getItem(OPEN_MODE_SNAPSHOT_KEY)).toBe(written);
  });

  it('falls back to empty on a corrupt or foreign stored value', () => {
    window.localStorage.setItem(OPEN_MODE_SNAPSHOT_KEY, 'not json');
    resetOpenModeSnapshotForTest();
    expect(readOpenModeSnapshot()).toBe(EMPTY_OPEN_MODE_SNAPSHOT);

    window.localStorage.setItem(
      OPEN_MODE_SNAPSHOT_KEY,
      JSON.stringify({ openNewshacker: ['feed-hn', 7, null] }),
    );
    resetOpenModeSnapshotForTest();
    const snapshot = readOpenModeSnapshot();
    expect([...snapshot.openNewshacker]).toEqual(['feed-hn']);
    expect(snapshot.openOriginal.size).toBe(0);
    expect(snapshot.markDoneOnOpen.size).toBe(0);
  });

  it('tells "nothing remembered yet" apart from "remembered, none set"', () => {
    // What the seed in useOpenModeSnapshotSync keys on: both read as an empty
    // snapshot, but only the first is an absence to fill.
    expect(hasStoredOpenModeSnapshot()).toBe(false);
    rememberOpenModes([sub('feed-hn', { openNewshacker: true })]);
    expect(hasStoredOpenModeSnapshot()).toBe(true);
    rememberOpenModes([sub('feed-hn')]);
    expect(readOpenModeSnapshot().openNewshacker.size).toBe(0);
    expect(hasStoredOpenModeSnapshot()).toBe(true);
  });

  it('keeps the modes in memory when storage refuses the write', () => {
    // Private mode or an exhausted quota: createPersistentStore swallows the
    // refused setItem and re-reads storage, so without an in-memory copy the
    // rows would stay in reader mode for the whole session no matter how many
    // reads landed — the bug this store exists to fix, on a device that can't
    // persist.
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
    try {
      rememberOpenModes([sub('feed-hn', { openNewshacker: true })]);
      expect([...readOpenModeSnapshot().openNewshacker]).toEqual(['feed-hn']);
      expect(window.localStorage.getItem(OPEN_MODE_SNAPSHOT_KEY)).toBeNull();

      // And the per-feed writers read that in-memory copy rather than storage,
      // so a settled change still lands on top of what the read left.
      rememberFeedOpenModes('feed-hn', { markDoneOnOpen: true });
      const snapshot = readOpenModeSnapshot();
      expect([...snapshot.openNewshacker]).toEqual(['feed-hn']);
      expect([...snapshot.markDoneOnOpen]).toEqual(['feed-hn']);
    } finally {
      setItem.mockRestore();
    }
  });

  it('persists the in-memory copy once storage recovers, unchanged flags and all', () => {
    // The refetch after a refused write usually carries the SAME flags, so a
    // no-op guard that consulted the in-memory copy would never write again and
    // the modes would be lost on the next launch despite storage recovering.
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementationOnce(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
    try {
      rememberOpenModes([sub('feed-hn', { openNewshacker: true })]);
      expect(window.localStorage.getItem(OPEN_MODE_SNAPSHOT_KEY)).toBeNull();

      // A routine read, carrying exactly what is already remembered.
      rememberOpenModes([sub('feed-hn', { openNewshacker: true })]);
      expect(window.localStorage.getItem(OPEN_MODE_SNAPSHOT_KEY)).not.toBeNull();
    } finally {
      setItem.mockRestore();
    }
    resetOpenModeSnapshotForTest();
    expect([...readOpenModeSnapshot().openNewshacker]).toEqual(['feed-hn']);
  });

  it('notifies subscribers when the in-memory copy moves', () => {
    // The store notifies synchronously from inside `set`, which happens before
    // the in-memory copy is installed — so a mounted row re-reads the OLD value,
    // schedules no render, and keeps opening on the old mode until something
    // unrelated re-renders it. What the subscriber sees is the assertion.
    const seen: Array<readonly string[]> = [];
    const unsubscribe = subscribeOpenModeSnapshot(() => {
      seen.push([...readOpenModeSnapshot().openNewshacker]);
    });
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
    try {
      rememberOpenModes([sub('feed-hn', { openNewshacker: true })]);
      expect(seen.at(-1)).toEqual(['feed-hn']);
    } finally {
      setItem.mockRestore();
      unsubscribe();
    }
  });

  it('drops the in-memory copy once storage takes a write again', () => {
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementationOnce(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
    try {
      rememberOpenModes([sub('feed-hn', { openNewshacker: true })]);
      rememberOpenModes([sub('feed-blog', { openOriginal: true })]);
      expect(window.localStorage.getItem(OPEN_MODE_SNAPSHOT_KEY)).not.toBeNull();
      const snapshot = readOpenModeSnapshot();
      expect(snapshot.openNewshacker.size).toBe(0);
      expect([...snapshot.openOriginal]).toEqual(['feed-blog']);
    } finally {
      setItem.mockRestore();
    }
    // Storage is what answers now, so a fresh parse sees the same thing.
    resetOpenModeSnapshotForTest();
    expect([...readOpenModeSnapshot().openOriginal]).toEqual(['feed-blog']);
  });

  it('leaves nothing stale behind when a write is refused', () => {
    // The in-memory copy dies with the session. If the older snapshot stayed in
    // storage it would read as current on the next boot and beat the restored
    // query cache the seed would otherwise fill from (useOpenModeSnapshotSync).
    rememberOpenModes([sub('feed-hn', { openNewshacker: true })]);
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
    try {
      rememberOpenModes([sub('feed-blog', { openOriginal: true })]);
      expect([...readOpenModeSnapshot().openOriginal]).toEqual(['feed-blog']);
      expect(hasStoredOpenModeSnapshot()).toBe(false);
    } finally {
      setItem.mockRestore();
    }
    // As the next boot sees it: nothing remembered, so the seed may fill it.
    resetOpenModeSnapshotForTest();
    expect(readOpenModeSnapshot()).toBe(EMPTY_OPEN_MODE_SNAPSHOT);
    expect(hasStoredOpenModeSnapshot()).toBe(false);
  });

  it('hands back a stable reference while the stored value is unchanged', () => {
    rememberOpenModes([sub('feed-hn', { openNewshacker: true })]);
    expect(readOpenModeSnapshot()).toBe(readOpenModeSnapshot());
  });
});
