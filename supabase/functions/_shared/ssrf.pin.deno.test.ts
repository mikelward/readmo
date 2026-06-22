// Deno integration test for the IP-pinned fetch (DNS-rebinding defense).
//
// Runs under the Deno runtime (`deno test --allow-net`), NOT Vitest — it
// exercises the real TCP/TLS pinning that the node/jsdom suite can't. The pure
// validation logic (IP denylist, redirect re-checks) is covered in
// ssrf.test.ts; this proves the transport connects to the vetted IP and binds
// TLS SNI/verification to the hostname.
import { fetchViaIpPinned } from './ssrf.ts';

// Dependency-free assertions (the sandbox/CI may not reach jsr.io).
function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(
      `assertEquals failed: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}${msg ? ` (${msg})` : ''}`,
    );
  }
}
async function assertRejects(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error('expected promise to reject, but it resolved');
}

// A long-lived (10y) self-managed CA + localhost leaf, so the HTTPS test needs
// no openssl at run time.
const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDHTCCAgWgAwIBAgIUbXOw/FEqgAMpsp+FX14EwuG5oIIwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTUmVhZG1vIFRlc3QgUm9vdCBDQTAeFw0yNjA2MjIwNzIz
NDFaFw0zNjA2MTkwNzIzNDFaMB4xHDAaBgNVBAMME1JlYWRtbyBUZXN0IFJvb3Qg
Q0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDBYqr8NAq/LA5HwGZ5
77wSEdiJ/i9SOcc8/1yEQt8MfsdomR1qnP1EoSMByuimA49lv7+LhcHJXR6JZRMe
wYfBRTFyEReiQY4rT9EjdQUoUwD5YZukc40+QZbaolH5j9mnOSt1fJxAEyDE1348
xIivQl8iKGwytoi2LJr5FzWvTT1a6aEbnpPCB9BisLKwbk6t+h6LXNIdOkiyLLV+
eVBrnp0+YTM67BbweIXDdp5nYm8m9Qu8nFDT4b1x/OFSLYhaVGRWNYx/sdBEC8iT
/EZZLa5ALQjECezuWQBd05h6WqTOpW0KeoPMRtpHEuNjHqN4IQtnaGukXIUfDOXi
okxDAgMBAAGjUzBRMB0GA1UdDgQWBBR+AL+YVp6OcmtkbzaaxZgyUjEg5DAfBgNV
HSMEGDAWgBR+AL+YVp6OcmtkbzaaxZgyUjEg5DAPBgNVHRMBAf8EBTADAQH/MA0G
CSqGSIb3DQEBCwUAA4IBAQA/0U5K0UmfjWMcaO/nnmndZIclJzbcNLXQfps0cbNp
CebJn44wyKbmJdv0GrE2w1WCWw8yHw4ZbTG5zxiaRHh9Rg+p++eqUYABwnSJS8Tr
L/KIOnPY4KtxoG1JQBuxIgFgXTCnZLzqS4HTYX7eOeKBbB4aHTbmlH8+oh9gSCNA
j8uSX7EMElpbzNGNymCltlPaFTFchjYWtV/ptwm1n/q2RSy1YNXQh/H8R1aRO7Zs
DwujcGK9ekExcLmh4nx+oLEbWrztQ11bXgKhm+1JoZG4XbI1yuvRBcGozVV/737T
NYB1ACd+dsosU72Q9myQvPo2uRrtBRiPntrwq2QXZjfo
-----END CERTIFICATE-----`;
const LEAF_PEM = `-----BEGIN CERTIFICATE-----
MIIDRzCCAi+gAwIBAgIUL3epwz4gYgmmcySdYWtW6AUsqQUwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTUmVhZG1vIFRlc3QgUm9vdCBDQTAeFw0yNjA2MjIwNzIz
NDFaFw0zNjA2MTkwNzIzNDFaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAMeiZPePqHB9E+FArODzyN3oBZmVuL2a
pjQw5wwXqzwSatMmnlh7x8XDghr6+tl7BKD48BM/VFydo2iWORo7TJNFy9Pitblb
+HMs3CK8fSb8tUszHRzVtzn6+TUpPZ3o3mp15gFe4UoRb3ZdNrTwhWSuLKkDgde8
NyOntosFCdiV+pcCgDAB5UZ+8nNjPMlu0TnRDS1UvGYk+4yuLkp93QEISKsvt3Oa
Aq0sR8Z52Spnl6Jzc91Xb5vUHlYfLs6MPJYC9FBkgcPjBaw4X13ZbY7oJthOxTgx
weioQK5ZVPBNrReWqL7oNvCNlyKMY2sdo2nCwmeboZSpDe/9raOTwSsCAwEAAaOB
hjCBgzAUBgNVHREEDTALgglsb2NhbGhvc3QwCQYDVR0TBAIwADALBgNVHQ8EBAMC
BaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0OBBYEFHgo7sF+CKJnATbFv7GQ
a0Cm8hVUMB8GA1UdIwQYMBaAFH4Av5hWno5ya2RvNprFmDJSMSDkMA0GCSqGSIb3
DQEBCwUAA4IBAQCvdgOB9J5bUo1n2wHTgbPeiM9wQ58m4ofjGE7ko86b8ZyhrXve
lzJFC2g/xmpR/7HwFS1/AWn7esQvZ2vgmqNC3sT8kB2BXOCHNyJDWdIUu+LPhNBS
QFLMPV7HSvNSqkwZqyUezCMw9VfNQJOwPuAmELRFjckvfMlT9kNIwTm4DvwfQGmO
WFOeQBnj+oKEgnoNMGG4NcDhxVvYJxbn1xGKifSSWjmPNBYL+dI/+EI5XTII6qoA
QwC2wI6fldg9zZ7c7+dt094iwE97tdy6rGmdZwCtucDEFvZP1iJ0GfzZrTD8ytYN
LT634kWp3AvqWmjabOZ/HHJRcyU4itKv/nCC
-----END CERTIFICATE-----`;
const LEAF_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDHomT3j6hwfRPh
QKzg88jd6AWZlbi9mqY0MOcMF6s8EmrTJp5Ye8fFw4Ia+vrZewSg+PATP1RcnaNo
ljkaO0yTRcvT4rW5W/hzLNwivH0m/LVLMx0c1bc5+vk1KT2d6N5qdeYBXuFKEW92
XTa08IVkriypA4HXvDcjp7aLBQnYlfqXAoAwAeVGfvJzYzzJbtE50Q0tVLxmJPuM
ri5Kfd0BCEirL7dzmgKtLEfGedkqZ5eic3PdV2+b1B5WHy7OjDyWAvRQZIHD4wWs
OF9d2W2O6CbYTsU4McHoqECuWVTwTa0Xlqi+6DbwjZcijGNrHaNpwsJnm6GUqQ3v
/a2jk8ErAgMBAAECggEACqDVl+AXYbgomePvFq5z7oVLrKCt34F/Wr6SkAny848W
QXXILvUvSBL/qlioiHHGGwNvbwVLapjfGiwK3NL0yALXXK/KG/tOnJclUYyDONM+
z0LPFUadhO7P9YNKEZrUIiSmIUMmlfwCpdffMaSvSiwDTayibSFknOqkMcq++oxX
ESEtiIaazDOyLggdCTrmftsdszj22yEHFdu+QMmwe7ubG0Gxe05NZqRD7bJCDpzi
82hqcZfTvQFDVxsr1TYiOO8+Cetj54TS8/JoOF7CZ4/yI+UO96npL/b2KM0A1WW1
5KW8vucsvnGRdu5MQ8jmGdfR3Vx6Ll7+8qR1fB0oqQKBgQDreMYvqADU6jU52EX5
/L84UzCaxWHcgGwLRgG81U50QVle1EchfCnau4EHBi73XuTHoZyWlUNoTiuzn49q
/G4IxXMiGErcFaE3K3UBLPmqL8NJdVfIABwRoGNB2QNjXHPkBI7UHSKlcpqDAfH3
tr4SMXlBjWS1Z6DBNEqx4ycPWQKBgQDZCc5EgWP/AffiUMSBh2QvLu0QgttLbG71
CfTrKBN8dGXPiAFHoMXltV4VSAuQ4hdr6RWIzvdeDEbM3yC1Cae8Cc0nfJ6b6C6B
NVkA/wyQybCwOxosaO/cptlUG7k972DVXfwKUnaQ4bRPDy4lnTwSPYY5ktI1vefl
xpRis3ToIwKBgBMdUrk7ohWmjXuMmuGYKs2fsypdK3yC0EJ6BFoX1q6JP3/7K2sE
cUFYRzkSv21FPr0V2Wg/5aDp95I1OactpqD/pkD2R91lxBh+ZpkZ1YqDJg8of1+0
4pJruqL1wtimAKJZ3F5LnyxfCTvpRIMfSn6flYBEwhAXwWztmcKm9dzBAoGBAM3J
2mZiOSpF94ADDQ+0DG4glG8fZEbznZGBy1RdP3y18QMB9hSwgHP5sCeFlFHfzk1n
SB/b/fiSs172AdEmQoCs2nUiWFGDqPSiXK3xJzzxwDKZF4wcQ7J4EYEKeG4dVzd4
Uc6HuhxNpeWAg0Tu/VJeO7LDX8XNNuBLlc6wUZz5AoGASecRgEiuY46gQHSSAVOK
tmHzmoPM1D9xpjmLicWTfFibgpOuGni3j829HQ77c8bSHtNSz+pVHN716YHIy72/
iX7/g3yoMzrhZiM8/jG1vwEwSgo0Jn9NB23mUZRuTPXSzg4Q/3tya1lnCzaYWh8K
gaj7ZD+A+avECiCsHtD4FkI=
-----END PRIVATE KEY-----`;

async function gzip(s: string): Promise<Uint8Array<ArrayBuffer>> {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  void w.write(new TextEncoder().encode(s));
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

Deno.test('IP-pinned fetch (plain HTTP)', async (t) => {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', signal: ac.signal, onListen() {} },
    async (req) => {
      const u = new URL(req.url);
      if (u.pathname === '/cl') return new Response('hello-cl');
      if (u.pathname === '/chunked') {
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('chunk-A;'));
              c.enqueue(new TextEncoder().encode('chunk-B'));
              c.close();
            },
          }),
        );
      }
      if (u.pathname === '/gzip') {
        return new Response(await gzip('gzipped-body'), {
          headers: { 'content-encoding': 'gzip', 'content-type': 'text/plain' },
        });
      }
      if (u.pathname === '/redir') {
        return new Response(null, { status: 302, headers: { location: '/cl' } });
      }
      if (u.pathname === '/host') return new Response('host=' + req.headers.get('host'));
      return new Response('nope', { status: 404 });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  // The hostname is intentionally unresolvable: success proves we connect to the
  // pinned IP (127.0.0.1) rather than re-resolving the name.
  const url = (p: string) => new URL(`http://bogus.invalid:${port}${p}`);

  await t.step('pins to the IP despite a bogus hostname (content-length)', async () => {
    const res = await fetchViaIpPinned(url('/cl'), '127.0.0.1');
    assertEquals(res.status, 200);
    assertEquals(await res.text(), 'hello-cl');
  });
  await t.step('decodes chunked transfer-encoding', async () => {
    const res = await fetchViaIpPinned(url('/chunked'), '127.0.0.1');
    assertEquals(await res.text(), 'chunk-A;chunk-B');
  });
  await t.step('decodes gzip content-encoding', async () => {
    const res = await fetchViaIpPinned(url('/gzip'), '127.0.0.1');
    assertEquals(await res.text(), 'gzipped-body');
    assertEquals(res.headers.get('content-encoding'), null);
  });
  await t.step('surfaces redirect status + Location without following', async () => {
    const res = await fetchViaIpPinned(url('/redir'), '127.0.0.1');
    assertEquals(res.status, 302);
    assertEquals(res.headers.get('location'), '/cl');
    await res.body?.cancel();
  });
  await t.step('sends Host = original hostname, not the IP', async () => {
    const res = await fetchViaIpPinned(url('/host'), '127.0.0.1');
    assertEquals(await res.text(), `host=bogus.invalid:${port}`);
  });

  ac.abort();
  await server.finished;
});

Deno.test('IP-pinned fetch (HTTPS: SNI + cert verification)', async (t) => {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: '127.0.0.1', cert: LEAF_PEM, key: LEAF_KEY_PEM, signal: ac.signal, onListen() {} },
    () => new Response('secure-hello'),
  );
  const port = (server.addr as Deno.NetAddr).port;

  await t.step('verifies the leaf against the SNI hostname, pinned to 127.0.0.1', async () => {
    const res = await fetchViaIpPinned(new URL(`https://localhost:${port}/`), '127.0.0.1', {
      caCerts: [CA_PEM],
    });
    assertEquals(res.status, 200);
    assertEquals(await res.text(), 'secure-hello');
  });
  await t.step('rejects a certificate from an untrusted CA', async () => {
    await assertRejects(() =>
      fetchViaIpPinned(new URL(`https://localhost:${port}/`), '127.0.0.1', { caCerts: [] })
        .then((r) => r.text()),
    );
  });

  ac.abort();
  await server.finished;
});

// The deliberately-stalled socket leaks ops/resources by design, so opt out of
// the sanitizers for this one.
Deno.test({
  name: 'IP-pinned fetch is bounded by the abort signal on a stalled peer',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // A raw TCP listener that accepts connections but never sends a response —
    // models a vetted IP that accepts TCP then stalls.
    const listener = Deno.listen({ port: 0, hostname: '127.0.0.1' });
    const port = (listener.addr as Deno.NetAddr).port;
    (async () => {
      try {
        for await (const _conn of listener) { /* hold open, never reply */ }
      } catch {
        /* listener closed */
      }
    })();

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 100); // stand-in for timeoutMs
    const started = Date.now();
    let threw = false;
    try {
      const res = await fetchViaIpPinned(
        new URL(`http://bogus.invalid:${port}/`),
        '127.0.0.1',
        { signal: ac.signal },
      );
      await res.text();
    } catch {
      threw = true;
    }
    clearTimeout(timer);
    listener.close();

    assertEquals(threw, true);
    // Promptly aborted, not hung until an OS-level timeout.
    if (Date.now() - started > 5000) {
      throw new Error('abort did not bound the stalled connection');
    }
  },
});

// A raw TCP server lets us send a hand-crafted response with a malformed
// Content-Length, which Deno.serve would otherwise normalise.
Deno.test({
  name: 'IP-pinned fetch ignores a malformed Content-Length (no tight loop)',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const body = 'hello-world';
    const raw =
      `HTTP/1.1 200 OK\r\nContent-Length: 5, 5\r\nConnection: close\r\n\r\n${body}`;
    const listener = Deno.listen({ port: 0, hostname: '127.0.0.1' });
    const port = (listener.addr as Deno.NetAddr).port;
    (async () => {
      try {
        for await (const conn of listener) {
          const buf = new Uint8Array(1024);
          await conn.read(buf); // consume the request line/headers
          await conn.write(new TextEncoder().encode(raw));
          conn.close();
        }
      } catch {
        /* listener closed */
      }
    })();

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000); // would fire if it hung
    const res = await fetchViaIpPinned(
      new URL(`http://bogus.invalid:${port}/`),
      '127.0.0.1',
      { signal: ac.signal },
    );
    // Falls back to close-delimited framing and returns the whole body, rather
    // than spinning on NaN remaining until the deadline.
    const text = await res.text();
    clearTimeout(timer);
    listener.close();
    assertEquals(text, body);
  },
});
