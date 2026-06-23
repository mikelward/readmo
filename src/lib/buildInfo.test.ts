// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildLabel } from './buildInfo';

describe('buildLabel', () => {
  it('uses the commit count as a build number on production', () => {
    expect(buildLabel('production', 'abc1234', '142')).toBe('#142');
  });

  it('uses the short SHA on preview', () => {
    expect(buildLabel('preview', 'abc1234', '142')).toBe('abc1234');
  });

  it('uses the short SHA locally/development', () => {
    expect(buildLabel('development', 'abc1234', '')).toBe('abc1234');
  });

  it('falls back to the short SHA on production when the count is unavailable', () => {
    // Shallow clone → no commit count; still show something identifying.
    expect(buildLabel('production', 'abc1234', '')).toBe('abc1234');
  });

  it('degrades to "dev" when nothing is known', () => {
    expect(buildLabel('development', '', '')).toBe('dev');
  });
});
