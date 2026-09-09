// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { AVATAR_COLORS, avatarColorForString } from './avatarColor';

describe('avatarColorForString', () => {
  it('is deterministic — the same string always picks the same color', () => {
    expect(avatarColorForString('alice')).toBe(avatarColorForString('alice'));
  });

  it('always returns a color from the palette', () => {
    for (const s of ['a', 'bob', 'mikel@mikelward.com', 'Δelta', '🦊fox']) {
      expect(AVATAR_COLORS).toContain(avatarColorForString(s));
    }
  });

  it('falls back to the first color for an empty string', () => {
    expect(avatarColorForString('')).toBe(AVATAR_COLORS[0]);
  });

  it('spreads different inputs across more than one color', () => {
    const seen = new Set(
      ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace'].map(
        avatarColorForString,
      ),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});
