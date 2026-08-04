// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyStableOrder } from './stableOrder';

describe('applyStableOrder', () => {
  it('takes the natural order when nothing is on screen yet', () => {
    expect(applyStableOrder(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('keeps a row where it is when the natural order promotes it (a pin)', () => {
    // `c` was pinned, so the derived order now sorts it into the saved block at
    // the top. On screen it must not move.
    expect(applyStableOrder(['c', 'a', 'b'], ['a', 'b', 'c'])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('keeps a row where it is when the natural order demotes it (an unpin)', () => {
    expect(applyStableOrder(['b', 'c', 'a'], ['a', 'b', 'c'])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('drops rows that are gone', () => {
    expect(applyStableOrder(['a', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  it('inserts a newcomer after its nearest preceding natural neighbor', () => {
    // `d` arrives between `a` and `b` in the freshly-derived order.
    expect(applyStableOrder(['a', 'd', 'b', 'c'], ['a', 'b', 'c'])).toEqual([
      'a',
      'd',
      'b',
      'c',
    ]);
  });

  it('inserts a newcomer with no preceding neighbor at the front', () => {
    expect(applyStableOrder(['d', 'a', 'b'], ['a', 'b'])).toEqual([
      'd',
      'a',
      'b',
    ]);
  });

  it('inserts consecutive newcomers in their natural order', () => {
    expect(applyStableOrder(['a', 'd', 'e', 'b'], ['a', 'b'])).toEqual([
      'a',
      'd',
      'e',
      'b',
    ]);
  });

  it('places a newcomer relative to rows already on screen, not the frozen index', () => {
    // The frozen order disagrees with the natural one (`c` was pinned earlier
    // and held its slot). A newcomer following `c` naturally lands after `c`
    // wherever `c` actually sits.
    expect(applyStableOrder(['a', 'c', 'd', 'b'], ['a', 'b', 'c'])).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('is idempotent — reapplying its own result changes nothing', () => {
    const once = applyStableOrder(['c', 'a', 'd', 'b'], ['a', 'b', 'c']);
    expect(applyStableOrder(['c', 'a', 'd', 'b'], once)).toEqual(once);
  });

  it('ignores a duplicate id rather than repeating the row', () => {
    expect(applyStableOrder(['a', 'b', 'a'], [])).toEqual(['a', 'b']);
  });

  it('handles an empty natural order', () => {
    expect(applyStableOrder([], ['a', 'b'])).toEqual([]);
  });
});
