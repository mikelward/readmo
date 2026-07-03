import { describe, expect, it } from 'vitest';
import { displayTitle } from './spoilerHeadline';

const ORIGINAL = 'Man Utd beat Arsenal 3-1 to go top';
const REWRITE = 'EPL MNU vs ARS result';

const item = (spoilerFreeTitle: string | null) => ({
  title: ORIGINAL,
  spoilerFreeTitle,
});

describe('displayTitle', () => {
  it('shows the rewrite (marked rewritten) when allowed, setting on, and a rewrite exists', () => {
    const out = displayTitle(item(REWRITE), { hideSpoilers: true, allowed: true });
    expect(out).toEqual({ text: REWRITE, rewritten: true, original: ORIGINAL });
  });

  it('shows the original when the setting is off', () => {
    const out = displayTitle(item(REWRITE), { hideSpoilers: false, allowed: true });
    expect(out).toEqual({ text: ORIGINAL, rewritten: false, original: ORIGINAL });
  });

  it('shows the original when the caller is not allowed', () => {
    const out = displayTitle(item(REWRITE), { hideSpoilers: true, allowed: false });
    expect(out).toEqual({ text: ORIGINAL, rewritten: false, original: ORIGINAL });
  });

  it('shows the original when no rewrite is cached', () => {
    const out = displayTitle(item(null), { hideSpoilers: true, allowed: true });
    expect(out).toEqual({ text: ORIGINAL, rewritten: false, original: ORIGINAL });
  });

  it('treats a blank/whitespace rewrite as absent (never blanks the row)', () => {
    const out = displayTitle(item('   '), { hideSpoilers: true, allowed: true });
    expect(out.text).toBe(ORIGINAL);
    expect(out.rewritten).toBe(false);
  });

  it('trims a cached rewrite before showing it', () => {
    const out = displayTitle(item(`  ${REWRITE}  `), { hideSpoilers: true, allowed: true });
    expect(out.text).toBe(REWRITE);
    expect(out.rewritten).toBe(true);
  });
});
