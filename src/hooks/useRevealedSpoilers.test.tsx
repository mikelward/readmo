import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  MAX_REVEALED,
  REVEALED_SPOILERS_KEY,
  clearRevealedSpoilers,
  resetRevealedSpoilersCacheForTest,
  revealKey,
  useRevealedSpoilers,
} from './useRevealedSpoilers';

// The store behind the row's first-tap reveal. ItemRow covers the gesture; this
// covers what a row can't reach — the cap, the headline keying, and the
// storage-refused path. Everything drives the real hook: a local
// re-implementation of `reveal` would go green while the shipped one broke.

const ITEM = { id: 'item-1', title: 'Man Utd beat Arsenal 3-1 to go top' };

function stored(): string[] {
  const raw = window.localStorage.getItem(REVEALED_SPOILERS_KEY);
  return raw ? (JSON.parse(raw) as string[]) : [];
}

describe('useRevealedSpoilers', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetRevealedSpoilersCacheForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    resetRevealedSpoilersCacheForTest();
  });

  it('remembers a reveal in storage, so a reload still has it', () => {
    const { result, unmount } = renderHook(() => useRevealedSpoilers());
    act(() => result.current.reveal(ITEM));
    expect(result.current.isRevealed(ITEM)).toBe(true);
    expect(result.current.isRevealed({ id: 'item-2', title: 'Other' })).toBe(false);

    // A reload is exactly this: every component gone and the module state
    // dropped, with only the key left behind.
    unmount();
    resetRevealedSpoilersCacheForTest();

    const { result: afterReload } = renderHook(() => useRevealedSpoilers());
    expect(afterReload.current.isRevealed(ITEM)).toBe(true);
  });

  it('drops a reveal when the headline changes under the same item', () => {
    // A publisher can update an article in place, and the poller's upsert keeps
    // the row's id while replacing the title and nulling the cached rewrite for
    // re-classification (0045). An id-keyed reveal would then show a result the
    // reader never asked to see — a live-blog row opened up at one headline
    // coming back carrying the final score.
    const { result } = renderHook(() => useRevealedSpoilers());
    act(() => result.current.reveal(ITEM));

    const updated = { id: ITEM.id, title: 'Man Utd beat Arsenal 4-1 to go top' };
    expect(result.current.isRevealed(updated)).toBe(false);
    // …and the one actually revealed is untouched.
    expect(result.current.isRevealed(ITEM)).toBe(true);
  });

  it('holds the reveal for the session when the write is refused', () => {
    // createPersistentStore.set() swallows a quota/denied write and get() keeps
    // returning the old set. For a preference that just means it doesn't stick;
    // here it would leave the row concealed with the tap guard armed, so the
    // body's first tap would keep revealing and never open the article.
    const { result } = renderHook(() => useRevealedSpoilers());
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    act(() => result.current.reveal(ITEM));

    expect(result.current.isRevealed(ITEM)).toBe(true);
    // Nothing was persisted — the session set is what's carrying it.
    expect(stored()).toEqual([]);
  });

  it('still reveals at the fallback ceiling, where a rotation leaves the size alone', () => {
    // Storage refusing every write AND the session at its ceiling: adding a key
    // and evicting the oldest keeps the size the same, so a memo keyed on size
    // would hand back a snapshot without the key just added — the row would stay
    // concealed, and `reveal` would then early-return on a key it can already
    // see, so the row could never be revealed OR opened again. Identity, not
    // size, is what the memo tracks.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    const { result } = renderHook(() => useRevealedSpoilers());
    act(() => {
      for (let i = 0; i < MAX_REVEALED; i += 1) {
        result.current.reveal({ id: `item-${i}`, title: `Headline ${i}` });
      }
    });

    const overflow = { id: 'item-overflow', title: 'One past the ceiling' };
    act(() => result.current.reveal(overflow));

    expect(result.current.isRevealed(overflow)).toBe(true);
    // The oldest made room for it.
    expect(
      result.current.isRevealed({ id: 'item-0', title: 'Headline 0' }),
    ).toBe(false);
  });

  it('drops the oldest reveals once the set is over the cap', () => {
    const { result } = renderHook(() => useRevealedSpoilers());
    act(() => {
      for (let i = 0; i < MAX_REVEALED + 3; i += 1) {
        result.current.reveal({ id: `item-${i}`, title: `Headline ${i}` });
      }
    });

    const kept = stored();
    expect(kept).toHaveLength(MAX_REVEALED);
    // The three oldest fell off the front; the newest is still there. Uncapped
    // this grows for the life of the install and eventually trips the
    // localStorage quota — a write failure that is silent, and that would strand
    // the whole set rather than just the newest entry.
    expect(kept).not.toContain(revealKey({ id: 'item-0', title: 'Headline 0' }));
    expect(kept).not.toContain(revealKey({ id: 'item-2', title: 'Headline 2' }));
    expect(kept[0]).toBe(revealKey({ id: 'item-3', title: 'Headline 3' }));
    expect(kept.at(-1)).toBe(
      revealKey({
        id: `item-${MAX_REVEALED + 2}`,
        title: `Headline ${MAX_REVEALED + 2}`,
      }),
    );
  });

  it('lets the cap actually un-reveal, rather than holding evictions in memory', () => {
    // The session fallback is for refused writes only. Mirroring every reveal
    // there would union the entries `capped()` just evicted straight back into
    // the snapshot — the cap would hold in storage and do nothing in the running
    // app, and the fallback would grow for the life of the session.
    const { result } = renderHook(() => useRevealedSpoilers());
    const oldest = { id: 'item-0', title: 'Headline 0' };
    act(() => {
      for (let i = 0; i < MAX_REVEALED + 1; i += 1) {
        result.current.reveal({ id: `item-${i}`, title: `Headline ${i}` });
      }
    });

    expect(stored()).toHaveLength(MAX_REVEALED);
    // Evicted from storage AND from what the rows read — no reload needed.
    expect(result.current.isRevealed(oldest)).toBe(false);
    expect(
      result.current.isRevealed({
        id: `item-${MAX_REVEALED}`,
        title: `Headline ${MAX_REVEALED}`,
      }),
    ).toBe(true);
  });

  it('does not move an already-revealed item to the back of the queue', () => {
    const second = { id: 'item-2', title: 'Another headline' };
    const { result } = renderHook(() => useRevealedSpoilers());
    act(() => {
      result.current.reveal(ITEM);
      result.current.reveal(second);
      result.current.reveal(ITEM);
    });
    // A revealed row re-rendering must not refresh its place in the eviction
    // order, or a row that merely stays on screen outlives reveals the reader
    // made more recently.
    expect(stored()).toEqual([revealKey(ITEM), revealKey(second)]);
  });

  it('clears every remembered reveal, including ones that never persisted', () => {
    const { result } = renderHook(() => useRevealedSpoilers());
    act(() => result.current.reveal(ITEM));

    const unpersisted = { id: 'item-2', title: 'Another headline' };
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('QuotaExceededError');
      });
    act(() => result.current.reveal(unpersisted));
    setItem.mockRestore();

    act(() => clearRevealedSpoilers());

    expect(result.current.isRevealed(ITEM)).toBe(false);
    expect(result.current.isRevealed(unpersisted)).toBe(false);
    expect(stored()).toEqual([]);
  });
});
