import { describe, expect, it } from 'vitest';
import {
  consumeDoneMirrorSuppression,
  suppressNextDoneMirror,
} from './newshackerMirrorSuppress';

describe('newshacker mirror suppression', () => {
  it('consumes a registered suppression exactly once', () => {
    suppressNextDoneMirror('item-1');
    expect(consumeDoneMirrorSuppression('item-1')).toBe(true);
    // One-shot: a second consume finds nothing.
    expect(consumeDoneMirrorSuppression('item-1')).toBe(false);
  });

  it('returns false for an id that was never suppressed', () => {
    expect(consumeDoneMirrorSuppression('never')).toBe(false);
  });

  it('tracks ids independently', () => {
    suppressNextDoneMirror('a');
    expect(consumeDoneMirrorSuppression('b')).toBe(false);
    expect(consumeDoneMirrorSuppression('a')).toBe(true);
  });
});
