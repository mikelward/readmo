// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { arrayMove, orderForPointer } from './arrayMove';

describe('arrayMove', () => {
  it('moves an element forward', () => {
    expect(arrayMove(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an element backward', () => {
    expect(arrayMove(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op when from === to', () => {
    expect(arrayMove(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('clamps out-of-range indices to the nearest end (never drops the element)', () => {
    expect(arrayMove(['a', 'b', 'c'], 0, 99)).toEqual(['b', 'c', 'a']);
    expect(arrayMove(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the input', () => {
    const input = ['a', 'b', 'c'];
    arrayMove(input, 0, 2);
    expect(input).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array unchanged', () => {
    expect(arrayMove([], 0, 1)).toEqual([]);
  });
});

describe('orderForPointer', () => {
  // Three stacked rows, each 40px tall: a [0,40), b [40,80), c [80,120).
  const rects = new Map([
    ['a', { top: 0, height: 40 }],
    ['b', { top: 40, height: 40 }],
    ['c', { top: 80, height: 40 }],
  ]);

  it('keeps order when the pointer is over the dragged row', () => {
    // Dragging a, pointer near the top — stays first.
    expect(orderForPointer(['a', 'b', 'c'], 'a', 5, rects)).toEqual(['a', 'b', 'c']);
  });

  it('drops the dragged row past a neighbor whose midpoint was crossed', () => {
    // Dragging a downward past b's midpoint (60) lands it after b.
    expect(orderForPointer(['a', 'b', 'c'], 'a', 65, rects)).toEqual(['b', 'a', 'c']);
  });

  it('moves a row to the very end when dragged below every midpoint', () => {
    expect(orderForPointer(['a', 'b', 'c'], 'a', 200, rects)).toEqual(['b', 'c', 'a']);
  });

  it('moves a row to the top when dragged above every midpoint', () => {
    expect(orderForPointer(['a', 'b', 'c'], 'c', 0, rects)).toEqual(['c', 'a', 'b']);
  });
});
