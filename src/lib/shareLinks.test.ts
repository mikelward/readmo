import { describe, expect, it } from 'vitest';
import { readmoItemUrl } from './shareLinks';

describe('readmoItemUrl', () => {
  it('builds a hosted /item/:id URL from an explicit origin', () => {
    expect(readmoItemUrl('abc-123', 'https://readmo.example')).toBe(
      'https://readmo.example/item/abc-123',
    );
  });

  it('encodes the id so an odd character cannot break out of the path', () => {
    expect(readmoItemUrl('a/b?c', 'https://readmo.example')).toBe(
      'https://readmo.example/item/a%2Fb%3Fc',
    );
  });

  it('falls back to the document origin when none is passed (jsdom)', () => {
    // The test environment is jsdom, so window.location.origin is defined.
    expect(readmoItemUrl('x1')).toBe(`${window.location.origin}/item/x1`);
  });
});
