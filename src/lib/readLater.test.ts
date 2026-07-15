import { describe, expect, it } from 'vitest';
import { readLaterTargets, type ReadLaterService } from './readLater';

const href = (targets: ReturnType<typeof readLaterTargets>, s: ReadLaterService) =>
  targets.find((t) => t.service === s)?.href ?? null;

describe('readLaterTargets', () => {
  it('offers Instapaper and Readwise Reader for a safe https article', () => {
    const targets = readLaterTargets('https://example.com/story', 'A Story');
    expect(targets.map((t) => t.service)).toEqual(['instapaper', 'readwise']);
    expect(targets.map((t) => t.label)).toEqual([
      'Save to Instapaper',
      'Save to Readwise Reader',
    ]);
  });

  it('builds the Instapaper save URL with an encoded url and title', () => {
    const url = href(
      readLaterTargets('https://example.com/a b?x=1&y=2', 'Hello & Goodbye'),
      'instapaper',
    );
    expect(url).toBe(
      'https://www.instapaper.com/hello2' +
        '?url=https%3A%2F%2Fexample.com%2Fa%20b%3Fx%3D1%26y%3D2' +
        '&title=Hello%20%26%20Goodbye',
    );
  });

  it('omits the Instapaper title param when there is no title', () => {
    const url = href(readLaterTargets('https://example.com/x'), 'instapaper');
    expect(url).toBe('https://www.instapaper.com/hello2?url=https%3A%2F%2Fexample.com%2Fx');
  });

  it('builds the Readwise Reader save URL (no title param)', () => {
    const url = href(
      readLaterTargets('https://example.com/x', 'Some title'),
      'readwise',
    );
    expect(url).toBe('https://wise.readwise.io/save?url=https%3A%2F%2Fexample.com%2Fx');
  });

  it('allows plain http URLs too', () => {
    expect(href(readLaterTargets('http://example.com/x'), 'instapaper')).toContain(
      'url=http%3A%2F%2Fexample.com%2Fx',
    );
  });

  it('returns null hrefs for a non-http(s) URL so callers omit the targets', () => {
    for (const bad of [
      'javascript:alert(1)',
      'mailto:a@b.com',
      '/relative/path',
      'not a url',
    ]) {
      const targets = readLaterTargets(bad, 'T');
      expect(targets.every((t) => t.href === null)).toBe(true);
    }
  });

  it('returns null hrefs for a missing URL', () => {
    for (const empty of [null, undefined, '']) {
      const targets = readLaterTargets(empty, 'T');
      expect(targets.every((t) => t.href === null)).toBe(true);
    }
  });

  it('trims a whitespace-only title to nothing (no title param)', () => {
    const url = href(readLaterTargets('https://example.com/x', '   '), 'instapaper');
    expect(url).toBe('https://www.instapaper.com/hello2?url=https%3A%2F%2Fexample.com%2Fx');
  });
});
