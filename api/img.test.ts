// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildUpstreamUrl, isServeableImageType } from './img.ts';

describe('img proxy — buildUpstreamUrl', () => {
  const base = 'https://abcd1234.supabase.co';

  it('forwards the target to the Supabase img function, url-encoded', () => {
    expect(
      buildUpstreamUrl(base, 'https://cdn.example.com/a b.png?w=2&h=3'),
    ).toBe(
      'https://abcd1234.supabase.co/functions/v1/img' +
        '?url=https%3A%2F%2Fcdn.example.com%2Fa%20b.png%3Fw%3D2%26h%3D3',
    );
  });

  it('trims a trailing slash on the base so the path has no double slash', () => {
    expect(buildUpstreamUrl(`${base}/`, 'https://x.test/i.jpg')).toBe(
      'https://abcd1234.supabase.co/functions/v1/img?url=https%3A%2F%2Fx.test%2Fi.jpg',
    );
  });

  it('returns null when there is no target to proxy', () => {
    expect(buildUpstreamUrl(base, null)).toBeNull();
    expect(buildUpstreamUrl(base, '')).toBeNull();
  });

  it('encodes a data: URI target intact (the img function decides what to do)', () => {
    const data = 'data:image/png;base64,AAAA';
    expect(buildUpstreamUrl(base, data)).toBe(
      `https://abcd1234.supabase.co/functions/v1/img?url=${encodeURIComponent(data)}`,
    );
  });
});

describe('img proxy — isServeableImageType', () => {
  it('accepts raster image types (case- and parameter-insensitive)', () => {
    expect(isServeableImageType('image/png')).toBe(true);
    expect(isServeableImageType('image/jpeg')).toBe(true);
    expect(isServeableImageType('image/webp')).toBe(true);
    expect(isServeableImageType('IMAGE/PNG')).toBe(true);
    expect(isServeableImageType('image/avif; charset=binary')).toBe(true);
  });

  it('rejects SVG — the same-origin script-execution vector', () => {
    expect(isServeableImageType('image/svg+xml')).toBe(false);
    expect(isServeableImageType('image/svg+xml; charset=utf-8')).toBe(false);
    expect(isServeableImageType('IMAGE/SVG+XML')).toBe(false);
    expect(isServeableImageType(' image/svg ')).toBe(false);
  });

  it('rejects non-image types and missing content-type', () => {
    expect(isServeableImageType('text/html')).toBe(false);
    expect(isServeableImageType('application/xml')).toBe(false);
    expect(isServeableImageType('')).toBe(false);
    expect(isServeableImageType(null)).toBe(false);
  });
});
