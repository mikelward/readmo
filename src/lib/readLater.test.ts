import { describe, expect, it } from 'vitest';
import {
  READ_LATER_SERVICES,
  isReadLaterService,
  readLaterTarget,
  type ReadLaterService,
} from './readLater';

const hrefFor = (
  service: ReadLaterService,
  url: string | null | undefined,
  title?: string | null,
) => readLaterTarget(service, url, title)?.href ?? null;

describe('readLaterTarget', () => {
  it('builds the Instapaper save URL with an encoded url and title', () => {
    expect(hrefFor('instapaper', 'https://example.com/a b?x=1&y=2', 'Hello & Goodbye')).toBe(
      'https://www.instapaper.com/hello2' +
        '?url=https%3A%2F%2Fexample.com%2Fa%20b%3Fx%3D1%26y%3D2' +
        '&title=Hello%20%26%20Goodbye',
    );
  });

  it('omits the Instapaper title param when there is no title', () => {
    expect(hrefFor('instapaper', 'https://example.com/x')).toBe(
      'https://www.instapaper.com/hello2?url=https%3A%2F%2Fexample.com%2Fx',
    );
  });

  it('builds the Raindrop save URL with an encoded url and title', () => {
    expect(hrefFor('raindrop', 'https://example.com/a b?x=1&y=2', 'Hello & Goodbye')).toBe(
      'https://app.raindrop.io/add' +
        '?link=https%3A%2F%2Fexample.com%2Fa%20b%3Fx%3D1%26y%3D2' +
        '&title=Hello%20%26%20Goodbye',
    );
  });

  it('omits the Raindrop title param when there is no title', () => {
    expect(hrefFor('raindrop', 'https://example.com/x')).toBe(
      'https://app.raindrop.io/add?link=https%3A%2F%2Fexample.com%2Fx',
    );
  });

  it('builds the Readwise Reader save URL (no title param)', () => {
    expect(hrefFor('readwise', 'https://example.com/x', 'Some title')).toBe(
      'https://wise.readwise.io/save?url=https%3A%2F%2Fexample.com%2Fx',
    );
  });

  it('carries the service id and menu label', () => {
    expect(readLaterTarget('raindrop', 'https://example.com/x', 'T')).toEqual({
      service: 'raindrop',
      label: 'Save to Raindrop',
      href: 'https://app.raindrop.io/add?link=https%3A%2F%2Fexample.com%2Fx&title=T',
    });
  });

  it('allows plain http URLs too', () => {
    expect(hrefFor('instapaper', 'http://example.com/x')).toContain(
      'url=http%3A%2F%2Fexample.com%2Fx',
    );
  });

  it('returns null for a non-http(s) URL so callers show no save option', () => {
    for (const bad of [
      'javascript:alert(1)',
      'mailto:a@b.com',
      '/relative/path',
      'not a url',
    ]) {
      expect(readLaterTarget('raindrop', bad, 'T')).toBeNull();
    }
  });

  it('returns null for a missing URL', () => {
    for (const empty of [null, undefined, '']) {
      expect(readLaterTarget('instapaper', empty, 'T')).toBeNull();
    }
  });

  it('trims a whitespace-only title to nothing (no title param)', () => {
    expect(hrefFor('instapaper', 'https://example.com/x', '   ')).toBe(
      'https://www.instapaper.com/hello2?url=https%3A%2F%2Fexample.com%2Fx',
    );
  });
});

describe('READ_LATER_SERVICES catalog', () => {
  it('lists every service in menu order with its label', () => {
    expect(READ_LATER_SERVICES).toEqual([
      { service: 'instapaper', label: 'Save to Instapaper' },
      { service: 'raindrop', label: 'Save to Raindrop' },
      { service: 'readwise', label: 'Save to Readwise Reader' },
    ]);
  });
});

describe('isReadLaterService', () => {
  it('accepts known service ids and rejects everything else', () => {
    for (const s of READ_LATER_SERVICES) {
      expect(isReadLaterService(s.service)).toBe(true);
    }
    for (const bad of ['pocket', '', 'INSTAPAPER', null, undefined, 3, {}]) {
      expect(isReadLaterService(bad)).toBe(false);
    }
  });
});
