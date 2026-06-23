// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  isBlockedAddress,
  assertSafeUrl,
  isIpLiteral,
  safeFetch,
  SsrfError,
} from './ssrf.ts';

describe('isBlockedAddress — IPv4', () => {
  it('blocks loopback 127.0.0.0/8', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('127.255.255.255')).toBe(true);
  });

  it('blocks link-local 169.254.0.0/16 incl. cloud metadata', () => {
    expect(isBlockedAddress('169.254.0.1')).toBe(true);
    expect(isBlockedAddress('169.254.169.254')).toBe(true); // metadata
  });

  it('blocks RFC1918 private ranges', () => {
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('172.16.0.1')).toBe(true);
    expect(isBlockedAddress('172.31.255.255')).toBe(true);
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
  });

  it('blocks 0.0.0.0/8 and reserved/multicast', () => {
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
    expect(isBlockedAddress('224.0.0.1')).toBe(true);
    expect(isBlockedAddress('255.255.255.255')).toBe(true);
  });

  it('blocks 192.0.0.0/24 and 192.0.2.0/24 only (not the whole /16)', () => {
    expect(isBlockedAddress('192.0.0.8')).toBe(true); // IETF protocol assignments
    expect(isBlockedAddress('192.0.2.1')).toBe(true); // TEST-NET-1
  });

  it('allows ordinary public IPv4', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('93.184.216.34')).toBe(false); // example.com
    expect(isBlockedAddress('172.32.0.1')).toBe(false); // just outside 172.16/12
    // 192.0.64.0/18 is Automattic (public); 192.0.72.0/22 is the
    // WordPress.com / Jetpack / Gravatar image CDN, 192.0.73.0/24 Gravatar.
    // These must NOT be caught by the 192.0.0.0/24 + 192.0.2.0/24 block.
    expect(isBlockedAddress('192.0.73.2')).toBe(false); // www.gravatar.com
    expect(isBlockedAddress('192.0.72.1')).toBe(false); // i0.wp.com (Jetpack)
    expect(isBlockedAddress('192.0.77.2')).toBe(false); // WordPress.com CDN
  });

  it('blocks malformed literals (fail closed)', () => {
    expect(isBlockedAddress('999.1.1.1')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

describe('isBlockedAddress — IPv6', () => {
  it('blocks loopback ::1 and unspecified ::', () => {
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('::')).toBe(true);
  });

  it('blocks link-local fe80::/10', () => {
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('febf::abcd')).toBe(true);
  });

  it('blocks ULA fc00::/7', () => {
    expect(isBlockedAddress('fc00::1')).toBe(true);
    expect(isBlockedAddress('fd12:3456::1')).toBe(true);
  });

  it('blocks multicast ff00::/8', () => {
    expect(isBlockedAddress('ff02::1')).toBe(true);
  });

  it('blocks IPv4-mapped private addresses', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
  });

  it('blocks NAT64 64:ff9b::/96 embedding a private/metadata IPv4', () => {
    expect(isBlockedAddress('64:ff9b::a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isBlockedAddress('64:ff9b::7f00:1')).toBe(true); // 127.0.0.1
    expect(isBlockedAddress('64:ff9b::0a00:1')).toBe(true); // 10.0.0.1
  });

  it('allows NAT64 embedding a public IPv4', () => {
    expect(isBlockedAddress('64:ff9b::808:808')).toBe(false); // 8.8.8.8
  });

  it('blocks the NAT64 local-use prefix 64:ff9b:1::/48 wholesale', () => {
    expect(isBlockedAddress('64:ff9b:1::1')).toBe(true);
  });

  it('allows ordinary public IPv6', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false); // cloudflare
  });
});

describe('isIpLiteral', () => {
  it('recognizes v4 and v6 literals, not names', () => {
    expect(isIpLiteral('1.2.3.4')).toBe(true);
    expect(isIpLiteral('fe80::1')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  it('rejects non-http(s) schemes', () => {
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(SsrfError);
    expect(() => assertSafeUrl('gopher://x/')).toThrow(SsrfError);
    expect(() => assertSafeUrl('data:text/html,x')).toThrow(SsrfError);
  });

  it('rejects embedded credentials', () => {
    expect(() => assertSafeUrl('https://user:pass@example.com/')).toThrow(
      /Credentials/,
    );
  });

  it('rejects blocked IP literals immediately', () => {
    expect(() => assertSafeUrl('http://127.0.0.1/')).toThrow(/Blocked/);
    expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data')).toThrow(
      /Blocked/,
    );
    expect(() => assertSafeUrl('http://[::1]/')).toThrow(/Blocked/);
  });

  it('accepts a well-formed public http(s) URL', () => {
    expect(() => assertSafeUrl('https://example.com/feed.xml')).not.toThrow();
  });
});

describe('safeFetch — with injected resolver/fetch', () => {
  const okResponse = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers });

  it('fetches a public host that resolves to a public IP', async () => {
    const res = await safeFetch('https://example.com/feed.xml', {
      resolve: async () => ['93.184.216.34'],
      fetchImpl: async () => okResponse('<rss/>'),
    });
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe('<rss/>');
  });

  it('rejects a host that resolves to loopback (DNS rebinding)', async () => {
    await expect(
      safeFetch('https://rebind.example.com/', {
        resolve: async () => ['127.0.0.1'],
        fetchImpl: async () => okResponse('nope'),
      }),
    ).rejects.toThrow(/blocked IP/);
  });

  it('rejects a host that resolves to the metadata IP', async () => {
    await expect(
      safeFetch('https://meta.example.com/', {
        resolve: async () => ['169.254.169.254'],
        fetchImpl: async () => okResponse('secrets'),
      }),
    ).rejects.toThrow(/blocked IP/);
  });

  it('re-validates redirects and rejects a 302 to 169.254.169.254', async () => {
    let call = 0;
    const fetchImpl = async (url: string | URL): Promise<Response> => {
      call++;
      const u = String(url);
      if (u === 'https://safe.example.com/') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      }
      return okResponse('should-not-reach');
    };
    await expect(
      safeFetch('https://safe.example.com/', {
        resolve: async (h) => (h === 'safe.example.com' ? ['8.8.8.8'] : ['8.8.8.8']),
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(/Blocked address: 169\.254\.169\.254/);
    // It must have stopped at the redirect, not fetched the metadata body.
    expect(call).toBe(1);
  });

  it('follows a safe redirect to another public host', async () => {
    const fetchImpl = async (url: string | URL): Promise<Response> => {
      const u = String(url);
      if (u === 'https://a.example.com/') {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://b.example.com/final' },
        });
      }
      return okResponse('final-body');
    };
    const res = await safeFetch('https://a.example.com/', {
      resolve: async () => ['8.8.8.8'],
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(res.url).toBe('https://b.example.com/final');
    expect(new TextDecoder().decode(res.body)).toBe('final-body');
  });

  it('cancels a redirect response body before following it', async () => {
    // In the pinned path the body owns the socket; the loop must cancel it on a
    // redirect or the connection leaks.
    let cancelled = false;
    const redirectBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = async (url: string | URL): Promise<Response> => {
      if (String(url) === 'https://a.example.com/') {
        return new Response(redirectBody, {
          status: 302,
          headers: { location: 'https://b.example.com/final' },
        });
      }
      return okResponse('final-body');
    };
    const res = await safeFetch('https://a.example.com/', {
      resolve: async () => ['8.8.8.8'],
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(cancelled).toBe(true);
    expect(new TextDecoder().decode(res.body)).toBe('final-body');
  });

  it('caps the number of redirects', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://loop.example.com/next' },
      });
    await expect(
      safeFetch('https://loop.example.com/start', {
        maxRedirects: 2,
        resolve: async () => ['8.8.8.8'],
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(/Too many redirects/);
  });

  it('enforces a body size cap', async () => {
    await expect(
      safeFetch('https://big.example.com/', {
        maxBytes: 4,
        resolve: async () => ['8.8.8.8'],
        fetchImpl: async () => okResponse('way too long'),
      }),
    ).rejects.toThrow(/too large|exceeded/i);
  });

  it('times out a trickled body that never completes (deadline spans the read)', async () => {
    // Headers arrive immediately, but the body stream never enqueues or closes.
    // The timeout must still fire — it covers the body read, not just the fetch.
    const neverEnding = new ReadableStream<Uint8Array>({
      start() {
        /* never enqueue, never close */
      },
    });
    await expect(
      safeFetch('https://slow.example.com/', {
        timeoutMs: 30,
        resolve: async () => ['8.8.8.8'],
        fetchImpl: async () => new Response(neverEnding, { status: 200 }),
      }),
    ).rejects.toThrow(/Timed out reading response body/);
  });

  it('does not forward Authorization/Cookie headers', async () => {
    let seen: Headers | undefined;
    await safeFetch('https://example.com/', {
      headers: { Authorization: 'Bearer secret', Cookie: 'sid=1', 'X-Ok': 'y' },
      resolve: async () => ['8.8.8.8'],
      fetchImpl: async (_u, init) => {
        seen = new Headers(init?.headers);
        return okResponse('ok');
      },
    });
    expect(seen?.get('authorization')).toBeNull();
    expect(seen?.get('cookie')).toBeNull();
    expect(seen?.get('x-ok')).toBe('y');
    expect(seen?.get('user-agent')).toContain('Readmo/1.0');
  });
});
