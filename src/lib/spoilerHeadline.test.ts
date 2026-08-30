import { describe, expect, it } from 'vitest';
import { displayTitle } from './spoilerHeadline';

const ORIGINAL = 'Man Utd beat Arsenal 3-1 to go top';
const REWRITE = 'EPL MNU v ARS spoiler';

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

  it('shows the original once this row has been revealed', () => {
    const out = displayTitle(item(REWRITE), {
      hideSpoilers: true,
      allowed: true,
      revealed: true,
    });
    // `rewritten: false` is what tells the row there is nothing left concealed —
    // it drops the marker, and its next tap opens instead of revealing again.
    expect(out).toEqual({ text: ORIGINAL, rewritten: false, original: ORIGINAL });
  });

  it('defaults to concealed when no reveal is passed', () => {
    // Every other caller (the reader, any future one) gets the pre-reveal
    // behavior without opting out of anything.
    const out = displayTitle(item(REWRITE), { hideSpoilers: true, allowed: true });
    expect(out.rewritten).toBe(true);
  });
});
