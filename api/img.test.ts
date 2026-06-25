// @vitest-environment node
import { afterEach, describe, it, expect, vi } from 'vitest';
import handler, {
  buildAnonHeaders,
  buildUpstreamUrl,
  isServeableImageType,
} from './img.ts';

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

describe('img proxy — buildAnonHeaders', () => {
  it('returns Authorization and apikey headers when a key is provided', () => {
    const headers = buildAnonHeaders('my-anon-key');
    expect(headers).toEqual({
      Authorization: 'Bearer my-anon-key',
      apikey: 'my-anon-key',
    });
  });

  it('returns an empty object when no key is provided', () => {
    expect(buildAnonHeaders(undefined)).toEqual({});
    expect(buildAnonHeaders('')).toEqual({});
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

describe('img proxy — handler caching', () => {
  // Errors must be uncacheable so a shared cache (Cloudflare) can't freeze a
  // transient failure for the image's long TTL; only the 200 bytes path caches.
  const url = 'https://app.example/api/img?url=' +
    encodeURIComponent('https://cdn.example.com/a.png');

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('marks a wrong-method 405 no-store (no env/fetch needed)', async () => {
    const res = await handler(new Request(url, { method: 'POST' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('marks a missing-config 503 no-store', async () => {
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    const res = await handler(new Request(url));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('marks a missing-url 400 no-store', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://proj.supabase.co');
    const res = await handler(new Request('https://app.example/api/img'));
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('does NOT inherit a cacheable header on an upstream 4xx/5xx pass-through', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://proj.supabase.co');
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon');
    // Upstream answers a 502 that (wrongly) carries a long cache-control — the
    // shim must override it with no-store, not pass it through.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('upstream boom', {
        status: 502,
        headers: {
          'content-type': 'text/plain',
          'cache-control': 'public, max-age=604800, immutable',
        },
      }),
    ));
    const res = await handler(new Request(url));
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('preserves the immutable cache-control on a successful image', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://proj.supabase.co');
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon');
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('PNGBYTES', {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=604800, immutable',
        },
      }),
    ));
    const res = await handler(new Request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=604800, immutable',
    );
    expect(res.headers.get('content-type')).toBe('image/png');
  });
});
