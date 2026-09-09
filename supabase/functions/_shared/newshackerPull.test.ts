import { describe, expect, it } from 'vitest';
import { extractDoneEntries, extractPinnedEntries } from './newshackerPull';

describe('extractDoneEntries', () => {
  it('keeps well-formed done entries and drops malformed ones', () => {
    const body = {
      done: [
        { id: 100, at: 5 },
        { id: 200, at: 9, deleted: true },
        { id: -1, at: 5 }, // non-positive id
        { id: 3.5, at: 5 }, // non-integer id
        { id: 300, at: -1 }, // negative at
        { id: 400 }, // missing at
        { nope: true }, // no id
        'garbage',
        null,
      ],
      // other lists are ignored
      pinned: [{ id: 999, at: 1 }],
    };
    expect(extractDoneEntries(body)).toEqual([
      { id: 200, at: 9, deleted: true },
      { id: 100, at: 5 },
    ]);
  });

  it('returns [] for a body without a done array', () => {
    expect(extractDoneEntries(null)).toEqual([]);
    expect(extractDoneEntries({})).toEqual([]);
    expect(extractDoneEntries({ done: 'nope' })).toEqual([]);
    expect(extractDoneEntries('string')).toEqual([]);
  });

  it('sorts newest-first and caps to max, keeping the most recent', () => {
    const body = {
      done: [
        { id: 1, at: 10 },
        { id: 2, at: 30 },
        { id: 3, at: 20 },
      ],
    };
    expect(extractDoneEntries(body, 2)).toEqual([
      { id: 2, at: 30 },
      { id: 3, at: 20 },
    ]);
  });

  it('does not carry a falsy deleted flag through', () => {
    const [entry] = extractDoneEntries({ done: [{ id: 1, at: 1, deleted: false }] });
    expect(entry).toEqual({ id: 1, at: 1 });
    expect('deleted' in entry).toBe(false);
  });

  it('reads only the done list, never pinned', () => {
    const body = { done: [{ id: 1, at: 1 }], pinned: [{ id: 2, at: 9 }] };
    expect(extractDoneEntries(body)).toEqual([{ id: 1, at: 1 }]);
  });
});

describe('extractPinnedEntries', () => {
  it('keeps well-formed pinned entries (with tombstones) and drops malformed ones', () => {
    const body = {
      pinned: [
        { id: 100, at: 5 },
        { id: 200, at: 9, deleted: true },
        { id: 0, at: 5 }, // non-positive id
        { id: 300, at: -1 }, // negative at
        { nope: true },
        null,
      ],
      done: [{ id: 999, at: 100 }], // ignored
    };
    expect(extractPinnedEntries(body)).toEqual([
      { id: 200, at: 9, deleted: true },
      { id: 100, at: 5 },
    ]);
  });

  it('returns [] for a body without a pinned array', () => {
    expect(extractPinnedEntries(null)).toEqual([]);
    expect(extractPinnedEntries({})).toEqual([]);
    expect(extractPinnedEntries({ pinned: 'nope' })).toEqual([]);
  });

  it('sorts newest-first and caps to max', () => {
    const body = { pinned: [{ id: 1, at: 10 }, { id: 2, at: 30 }, { id: 3, at: 20 }] };
    expect(extractPinnedEntries(body, 2)).toEqual([
      { id: 2, at: 30 },
      { id: 3, at: 20 },
    ]);
  });
});
