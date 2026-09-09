import { describe, expect, it } from 'vitest';
import {
  recallHackerNewsItemId,
  rememberHackerNewsItemId,
} from './newshackerItemIds';

describe('newshacker item-id cache', () => {
  it('recalls a remembered mapping', () => {
    rememberHackerNewsItemId('item-r1', 42);
    expect(recallHackerNewsItemId('item-r1')).toBe(42);
  });

  it('returns null for an unknown item', () => {
    expect(recallHackerNewsItemId('never-seen')).toBeNull();
  });

  it('overwrites an existing mapping', () => {
    rememberHackerNewsItemId('item-r2', 1);
    rememberHackerNewsItemId('item-r2', 2);
    expect(recallHackerNewsItemId('item-r2')).toBe(2);
  });
});
