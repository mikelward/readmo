// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchViaJinaHtml } from './jina.ts';

/** Stub a Deno.env that yields the given JINA_API_KEY (or none). */
function stubDeno(key?: string) {
  vi.stubGlobal('Deno', {
    env: { get: (k: string) => (k === 'JINA_API_KEY' ? key : undefined) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchViaJinaHtml', () => {
  it('returns null (and never fetches) when JINA_API_KEY is unset', async () => {
    // vitest's node env has no `Deno`, mirroring an unconfigured/self-hosted key.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchViaJinaHtml('https://ft.com/')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches r.jina.ai with the key and returns the HTML for a homepage', async () => {
    stubDeno('key-123');
    const fetchSpy = vi.fn(
      () => Promise.resolve(new Response('<head><link rel="icon" href="/x.png"></head>', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const html = await fetchViaJinaHtml('https://ft.com/');
    expect(html).toContain('rel="icon"');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://r.jina.ai/https://ft.com/');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key-123');
    expect((init.headers as Record<string, string>)['X-Return-Format']).toBe('html');
  });

  it('screens out URLs with a query string (possible ?token=…)', async () => {
    stubDeno('key-123');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchViaJinaHtml('https://ft.com/?token=abc')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('screens out URLs with embedded credentials (user:pass@)', async () => {
    stubDeno('key-123');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchViaJinaHtml('https://user:pass@example.com/')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('screens out URLs with a high-entropy/tokenized path segment', async () => {
    stubDeno('key-123');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchViaJinaHtml('https://example.com/a1b2c3d4e5f6a7b8c9d0e1f2')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('screens out URLs whose last path segment carries a file extension', async () => {
    stubDeno('key-123');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchViaJinaHtml('https://ft.com/feeds/secret.xml')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('screens out a PERCENT-ENCODED file extension (private%2Exml → private.xml)', async () => {
    // The dotted-segment guard must decode before testing, or an encoded `.`
    // slips a resource URL past it (looksTokenized leaves the short segment).
    stubDeno('key-123');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchViaJinaHtml('https://example.com/feeds/private%2Exml')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('screens out a dotted segment behind a trailing slash or mid-path (…/private.xml/)', async () => {
    // split('/').pop() returns '' after a trailing slash, so the extension guard
    // must test every segment, not just the last.
    stubDeno('key-123');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchViaJinaHtml('https://example.com/feeds/private.xml/')).toBeNull();
    expect(await fetchViaJinaHtml('https://example.com/feeds/private.xml/extra')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed percent-escape segment', async () => {
    // Per-segment decode must not let one bad escape disable screening: a
    // malformed segment → reject outright rather than forward to the third party.
    stubDeno('key-123');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchViaJinaHtml('https://example.com/feeds/private%2Exml/%E0%A4%A')).toBeNull();
    expect(await fetchViaJinaHtml('https://example.com/%E0%A4%A/home')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('screens out matrix path params (/;jsessionid=…), raw and percent-encoded', async () => {
    stubDeno('key-123');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchViaJinaHtml('https://example.com/;jsessionid=abc123')).toBeNull();
    expect(await fetchViaJinaHtml('https://example.com/%3Bjsessionid=abc123')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null for an unparseable target', async () => {
    stubDeno('key-123');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchViaJinaHtml('not a url')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null on a non-ok Jina response', async () => {
    stubDeno('key-123');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 502 }))));
    expect(await fetchViaJinaHtml('https://ft.com/')).toBeNull();
  });

  it('returns null when the body exceeds the size cap', async () => {
    stubDeno('key-123');
    const huge = 'a'.repeat(5 * 1024 * 1024); // > 4 MiB cap
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(huge, { status: 200 }))));
    expect(await fetchViaJinaHtml('https://ft.com/')).toBeNull();
  });

  it('handles a 2xx response with no body stream', async () => {
    stubDeno('key-123');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))));
    expect(await fetchViaJinaHtml('https://ft.com/')).toBe('');
  });

  it('never throws when the Jina fetch rejects', async () => {
    stubDeno('key-123');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('boom'))));
    expect(await fetchViaJinaHtml('https://ft.com/')).toBeNull();
  });
});
