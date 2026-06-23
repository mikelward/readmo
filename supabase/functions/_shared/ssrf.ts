// Readmo SSRF-hardened fetch wrapper.
//
// Every server-side outbound fetch (discovery, the poller, the image proxy,
// any future full-text fetch) MUST route through this module. Feed URLs and
// site URLs come from users, so they are the app's untrusted input
// (SPEC.md "Fetch hardening (SSRF)" + guardrail #6).
//
// Defenses:
//   - Scheme allow-list: http/https only.
//   - Resolved-IP denylist: loopback, link-local (incl. 169.254.169.254 cloud
//     metadata), RFC1918, ULA, 0.0.0.0/8, and other reserved ranges — checked
//     against the RESOLVED IP(s), not just the literal.
//   - Connection pinning: production opens the socket to a vetted resolved IP
//     itself (TLS SNI + cert verification bound to the hostname), so the HTTP
//     client can't re-resolve the name and rebind to a private/metadata IP
//     between our check and the connection (DNS rebinding).
//   - Manual redirect following with a per-hop re-check (a 302 to
//     169.254.169.254 is rejected), capped at depth 5.
//   - Request timeout + response body size cap.
//   - No credential forwarding; no trust of client Host/forwarding headers.
//
// The IP-classification logic (`isBlockedAddress`) is a PURE exported function
// so unit tests need neither DNS nor network. `assertSafeUrl` validates a URL's
// scheme/host shape; `safeFetch` wires in a (possibly injected) resolver and
// fetch so tests can simulate redirects to metadata without real I/O.

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Abort the request after this many ms (default 10_000). */
  timeoutMs?: number;
  /** Reject once the body exceeds this many bytes (default 8 MiB). */
  maxBytes?: number;
  /** Max redirect hops to follow (default 5). */
  maxRedirects?: number;
  /** Injectable DNS resolver — returns the IP literals a host resolves to.
   * Defaults to Deno.resolveDns at runtime; tests pass a fake. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Injectable low-level fetch with manual redirect handling. Defaults to
   * the global fetch with redirect:'manual'; tests pass a fake. */
  fetchImpl?: typeof fetch;
}

export interface SafeFetchResult {
  status: number;
  headers: Headers;
  /** The final URL after redirects. */
  url: string;
  /** The (size-capped) response body. */
  body: Uint8Array;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// IP classification (pure)
// ---------------------------------------------------------------------------

/**
 * Return true if `ip` (an IPv4 or IPv6 literal) falls in a range we must
 * never fetch from. Pure — no DNS, no network.
 */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  if (!addr) return true; // empty == unparseable == block (fail closed)

  // IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1) — classify by the
  // embedded v4 address.
  const mapped = extractMappedV4(addr);
  if (mapped) return isBlockedV4(mapped);

  if (addr.includes(':')) return isBlockedV6(addr);
  return isBlockedV4(addr);
}

function extractMappedV4(addr: string): string | null {
  // ::ffff:a.b.c.d
  const dotted = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  // ::ffff:7f00:0001
  const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function isBlockedV4(addr: string): boolean {
  const octets = addr.split('.');
  if (octets.length !== 4) return true; // malformed → block
  const o = octets.map((p) => Number(p));
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;

  // 0.0.0.0/8 — "this network", includes 0.0.0.0.
  if (a === 0) return true;
  // 10.0.0.0/8 — RFC1918 private.
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local, incl. 169.254.169.254 cloud metadata.
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — RFC1918 private.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — RFC1918 private.
  if (a === 192 && b === 168) return true;
  // 192.0.0.0/24 (IETF protocol assignments) & 192.0.2.0/24 (TEST-NET-1).
  // Scope to those two /24s by the third octet: the rest of 192.0.0.0/16 is
  // public — notably 192.0.64.0/18 (Automattic), which carries the
  // WordPress.com / Jetpack / Gravatar image CDN (192.0.72.0/22). Blocking the
  // whole /16 here made the image proxy reject those hosts as "Blocked".
  if (a === 192 && b === 0 && (o[2] === 0 || o[2] === 2)) return true;
  // 100.64.0.0/10 — carrier-grade NAT.
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 198.18.0.0/15 — benchmarking.
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 — TEST-NET-2.
  if (a === 198 && b === 51 && o[2] === 100) return true;
  // 203.0.113.0/24 — TEST-NET-3.
  if (a === 203 && b === 0 && o[2] === 113) return true;
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved (incl. 255.255.255.255).
  if (a >= 224) return true;

  return false;
}

function isBlockedV6(addr: string): boolean {
  // Normalize: strip zone id (fe80::1%eth0) and brackets.
  let a = addr.replace(/^\[|\]$/g, '');
  const pct = a.indexOf('%');
  if (pct !== -1) a = a.slice(0, pct);

  // Unspecified ::, and loopback ::1.
  if (a === '::' || a === '::1') return true;

  // Expand to full groups so prefix checks are simple.
  const groups = expandV6(a);
  if (!groups) return true; // unparseable → block
  const first = groups[0];

  // fe80::/10 link-local: first 10 bits == 1111111010 → 0xfe80..0xfebf.
  if (first >= 0xfe80 && first <= 0xfebf) return true;
  // fc00::/7 unique local (ULA): first 7 bits == 1111110 → 0xfc00..0xfdff.
  if (first >= 0xfc00 && first <= 0xfdff) return true;
  // ff00::/8 multicast.
  if ((first & 0xff00) === 0xff00) return true;

  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052): the low 32 bits embed an
  // IPv4 address, so classify THAT — otherwise 64:ff9b::a9fe:a9fe (which maps
  // to 169.254.169.254, the cloud-metadata IP) would slip through as public on
  // NAT64-enabled egress.
  if (
    first === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    const embedded =
      `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.` +
      `${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`;
    return isBlockedV4(embedded);
  }
  // NAT64 local-use prefix 64:ff9b:1::/48 (RFC 8215): the IPv4 embedding format
  // varies, so block the whole prefix conservatively.
  if (first === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) {
    return true;
  }

  // ::/8 reserved block other than the handled :: / ::1 (::ffff: mapped is
  // handled earlier): all-zero high bits → IPv4-compatible / reserved; block.
  if (groups.every((g, i) => (i < 5 ? g === 0 : true)) && groups[5] === 0) {
    return true;
  }

  return false;
}

/** Expand an IPv6 string into 8 numeric groups, or null if malformed. */
function expandV6(addr: string): number[] | null {
  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const parse = (s: string): number[] | null => {
    if (s === '') return [];
    const parts = s.split(':');
    const out: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };

  if (halves.length === 1) {
    const g = parse(halves[0]);
    return g && g.length === 8 ? g : null;
  }

  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  if (head == null || tail == null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/** Thrown when a URL is rejected before any network access. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * Validate a URL's scheme and host shape and throw SsrfError if unsafe.
 * If the host is an IP literal, it is classified immediately; if it's a name,
 * DNS resolution + IP classification happens later in `safeFetch` (this keeps
 * `assertSafeUrl` pure and synchronous). Returns the parsed URL.
 */
export function assertSafeUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError(`Invalid URL: ${url}`);
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new SsrfError(`Disallowed scheme: ${scheme}:`);
  }

  // Reject embedded credentials (https://user:pass@host) — both a credential
  // leak and a known SSRF/parsing-confusion vector.
  if (parsed.username || parsed.password) {
    throw new SsrfError('Credentials in URL are not allowed');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new SsrfError('Empty host');

  // If the host is already an IP literal, classify now (no DNS needed).
  if (isIpLiteral(host) && isBlockedAddress(host)) {
    throw new SsrfError(`Blocked address: ${host}`);
  }

  return parsed;
}

/** True if `host` is a numeric IPv4 or IPv6 literal (not a DNS name). */
export function isIpLiteral(host: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (host.includes(':')) return true; // IPv6 always contains colons
  return false;
}

// ---------------------------------------------------------------------------
// safeFetch
// ---------------------------------------------------------------------------

/**
 * Fetch a URL with full SSRF hardening: scheme + resolved-IP checks on the
 * initial URL and on every redirect hop, a timeout, and a body size cap.
 *
 * The DNS resolver and fetch are injectable for testing. At runtime in Deno,
 * the defaults use Deno.resolveDns and the global fetch with manual redirects.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const resolve = opts.resolve ?? defaultResolve;

  // Build a headers object that NEVER carries caller credentials. We only set
  // what the caller explicitly passes plus a default UA if absent.
  const baseHeaders: Record<string, string> = { ...(opts.headers ?? {}) };
  delete baseHeaders.authorization;
  delete baseHeaders.cookie;
  delete baseHeaders.Authorization;
  delete baseHeaders.Cookie;
  if (!hasHeader(baseHeaders, 'user-agent')) {
    baseHeaders['User-Agent'] = 'Readmo/1.0 (+https://readmo.app)';
  }

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = assertSafeUrl(current);

    // Resolve the host (if it's a name) and check EVERY resolved IP — this is
    // the DNS-rebinding defense: the literal might be fine but the name could
    // point at 169.254.169.254.
    // Resolve to the vetted IP(s) we will actually CONNECT to. For a literal
    // host the literal is the connect target (already validated by
    // assertSafeUrl); for a name we resolve, reject any blocked IP, and pin the
    // connection to a resolved IP below so the HTTP layer can't re-resolve and
    // rebind to a private/metadata address.
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    let pinIps: string[];
    if (isIpLiteral(host)) {
      pinIps = [host];
    } else {
      const ips = await resolve(host);
      if (ips.length === 0) throw new SsrfError(`No DNS records for ${host}`);
      for (const ip of ips) {
        if (isBlockedAddress(ip)) {
          throw new SsrfError(`Host ${host} resolves to blocked IP ${ip}`);
        }
      }
      pinIps = ips;
    }

    // One deadline per hop covering BOTH the fetch AND the body read. The
    // finally clears it on every exit (redirect `continue`, terminal return,
    // or throw); the next hop installs a fresh controller/timer. Clearing only
    // around the fetch (as before) would leave readCapped unbounded, so a
    // server that streams headers fast then trickles the body could hang past
    // timeoutMs.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Production pins the TCP connection to a vetted IP (closing the DNS
      // rebinding hole — the HTTP client never re-resolves the name). Tests
      // inject `fetchImpl` to simulate responses/redirects without real I/O.
      const res = opts.fetchImpl
        ? await opts.fetchImpl(current, {
            method: opts.method ?? 'GET',
            headers: baseHeaders,
            redirect: 'manual', // we follow manually so we can re-check each hop
            signal: controller.signal,
          })
        : await fetchPinned(parsed, pinIps, {
            method: opts.method ?? 'GET',
            headers: baseHeaders,
            signal: controller.signal,
          });

      // Handle redirects ourselves so each Location is re-validated.
      if (res.status >= 300 && res.status < 400) {
        // Release the socket backing this redirect response up front — we never
        // read a redirect body, and in the pinned path it owns the conn. Do this
        // before any throw so an invalid/oversized 3xx can't leak the connection.
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get('location');
        if (!location) {
          throw new SsrfError(`Redirect ${res.status} without Location header`);
        }
        if (hop === maxRedirects) {
          throw new SsrfError(`Too many redirects (> ${maxRedirects})`);
        }
        // Resolve relative redirects against the current URL, then loop — the
        // top of the loop re-runs assertSafeUrl + DNS checks on the new target.
        current = new URL(location, current).toString();
        continue;
      }

      const body = await readCapped(res, maxBytes, controller.signal);
      return { status: res.status, headers: res.headers, url: current, body };
    } finally {
      clearTimeout(timer);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new SsrfError('Redirect handling exhausted');
}

/**
 * Read a response body, aborting if it exceeds `maxBytes` or if `signal` fires
 * (the shared per-request deadline). Each `reader.read()` is raced against the
 * abort so the read is bounded even when the underlying body stream does not
 * itself honor the signal — otherwise a trickled/never-ending body would
 * outlive the caller's `timeoutMs`.
 */
async function readCapped(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  // Fast path: a trustworthy Content-Length over the cap → reject early.
  const len = res.headers.get('content-length');
  if (len && Number(len) > maxBytes) {
    throw new SsrfError(`Response too large: ${len} bytes > ${maxBytes}`);
  }

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new SsrfError(`Response too large: ${buf.byteLength} > ${maxBytes}`);
    }
    return buf;
  }

  const reader = res.body.getReader();

  // A promise that rejects the moment the deadline fires.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new SsrfError('Timed out reading response body'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new SsrfError(`Response exceeded ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    // Release the stream (no-op if already drained; cancels a trickling body).
    reader.cancel().catch(() => {});
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

/** Default DNS resolver — uses Deno's resolver at runtime. Wrapped so the
 * module still imports cleanly under node/vitest (where `Deno` is undefined);
 * tests always inject their own resolver and never hit this path. */
async function defaultResolve(hostname: string): Promise<string[]> {
  const D = (globalThis as { Deno?: { resolveDns?: (h: string, t: string) => Promise<string[]> } }).Deno;
  if (D?.resolveDns) {
    const [a, aaaa] = await Promise.allSettled([
      D.resolveDns(hostname, 'A'),
      D.resolveDns(hostname, 'AAAA'),
    ]);
    const ips: string[] = [];
    if (a.status === 'fulfilled') ips.push(...a.value);
    if (aaaa.status === 'fulfilled') ips.push(...aaaa.value);
    return ips;
  }
  throw new SsrfError(
    'No DNS resolver available (inject opts.resolve outside Deno)',
  );
}

// ---------------------------------------------------------------------------
// IP-pinned fetch (DNS-rebinding defense)
//
// The global fetch performs its OWN DNS lookup, so validating resolved IPs is
// not enough: a hostile name can answer with a public IP to `resolve()` and a
// private/metadata IP at connect time. We instead open the TCP connection to a
// vetted IP ourselves and (for https) run the TLS handshake with SNI + cert
// verification bound to the original hostname — the name is never re-resolved.
// A minimal HTTP/1.1 client (Connection: close) speaks over that pinned socket.
// ---------------------------------------------------------------------------

type Bytes = Uint8Array<ArrayBufferLike>;

interface PinnedFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Extra TLS trust anchors (the integration test uses a local CA);
   * production passes none and uses the system roots. */
  caCerts?: string[];
}

/** Try each vetted IP in turn (first that connects wins) so a feed whose first
 * A record is unreachable still loads; an abort propagates immediately. */
async function fetchPinned(
  parsed: URL,
  ips: string[],
  opts: PinnedFetchOptions,
): Promise<Response> {
  let lastErr: unknown;
  for (const ip of ips) {
    try {
      return await fetchViaIpPinned(parsed, ip, opts);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new SsrfError('connection failed: no resolved IPs');
}

/**
 * Issue an HTTP/1.1 request over a connection PINNED to `ip`, with TLS SNI and
 * certificate verification bound to the URL's hostname — so the transport can
 * never re-resolve the name to a private/metadata address. Returns a streaming
 * Response (body de-chunked and gzip/deflate-decoded) so the caller's size cap
 * still bounds it. Exported for the Deno integration test; production reaches
 * it through safeFetch.
 */
export async function fetchViaIpPinned(
  parsed: URL,
  ip: string,
  opts: PinnedFetchOptions = {},
): Promise<Response> {
  const isHttps = parsed.protocol === 'https:';
  const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
  const sni = parsed.hostname.replace(/^\[|\]$/g, '');

  const signal = opts.signal;
  if (signal?.aborted) throw new SsrfError('aborted before connect');

  // Bound EVERY phase (connect, TLS handshake, header read) by the deadline:
  // closing the socket does not reliably reject a pending read/handshake, so we
  // also race each await against a single abort rejection. One listener total.
  const abortRejection: Promise<never> | null = signal
    ? new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new SsrfError('aborted (timeout)')),
          { once: true },
        );
      })
    : null;
  // Swallow the rejection if it's never raced (avoids an unhandled rejection).
  abortRejection?.catch(() => {});
  const race = <T>(p: Promise<T>): Promise<T> =>
    abortRejection ? Promise.race([p, abortRejection]) : p;

  // Pass the signal to connect too, so Deno tears the socket down on abort.
  const tcp = await race(Deno.connect({ hostname: ip, port, signal }));

  // Close the socket on abort as well (frees the resource); `conn` starts as the
  // raw TCP conn and becomes the TLS conn below — closing whichever is current.
  let conn: Deno.Conn = tcp;
  const close = () => {
    try {
      conn.close();
    } catch {
      /* already closed */
    }
  };
  signal?.addEventListener('abort', close, { once: true });

  try {
    if (isHttps) {
      conn = await race(
        Deno.startTls(tcp, { hostname: sni, caCerts: opts.caCerts }),
      );
    }
  } catch (err) {
    close();
    signal?.removeEventListener('abort', close);
    throw err;
  }

  try {
    const method = (opts.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    headers['Host'] = parsed.host;
    headers['Connection'] = 'close';
    if (!hasHeader(headers, 'accept-encoding')) {
      headers['Accept-Encoding'] = 'gzip, deflate';
    }
    const reqLines = [`${method} ${parsed.pathname + parsed.search} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) reqLines.push(`${k}: ${v}`);
    const reqBytes = new TextEncoder().encode(reqLines.join('\r\n') + '\r\n\r\n');
    const writer = conn.writable.getWriter();
    await writer.write(reqBytes);
    writer.releaseLock();

    const reader = conn.readable.getReader();
    // Accumulate bytes until the end of the header block.
    let buf: Bytes = new Uint8Array(0);
    let headerEnd = -1;
    while (headerEnd < 0) {
      const { value, done } = await race(reader.read());
      if (done) break;
      buf = concatBytes(buf, value);
      headerEnd = indexOfDoubleCrlf(buf);
      if (buf.length > 64 * 1024) {
        throw new SsrfError('response headers too large');
      }
    }
    if (headerEnd < 0) throw new SsrfError('connection closed before headers');

    const headText = new TextDecoder().decode(buf.subarray(0, headerEnd));
    const leftover = buf.subarray(headerEnd + 4);
    const [statusLine, ...headerLines] = headText.split('\r\n');
    const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(statusLine);
    if (!m) throw new SsrfError(`malformed status line: ${statusLine}`);
    const status = Number(m[1]);

    const resHeaders = new Headers();
    for (const line of headerLines) {
      const i = line.indexOf(':');
      if (i > 0) {
        resHeaders.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
      }
    }

    const chunked = (resHeaders.get('transfer-encoding') ?? '')
      .toLowerCase()
      .includes('chunked');
    const bodyless = status === 204 || status === 304 || method === 'HEAD';

    if (bodyless) {
      close();
      return new Response(null, { status, headers: resHeaders });
    }

    // Use Content-Length for framing only when it's a single finite, non-negative
    // integer. A malformed or duplicated value (e.g. "abc" or "5, 5") is ignored
    // and we fall back to close-delimited framing — otherwise NaN would spin the
    // fixed-length reader in a tight loop until the timeout.
    let contentLength: number | null = null;
    if (!chunked) {
      const clen = resHeaders.get('content-length');
      if (clen !== null) {
        const n = Number(clen.trim());
        if (Number.isInteger(n) && n >= 0) contentLength = n;
      }
    }

    let body: ReadableStream<Bytes> = bodyStream(reader, leftover, {
      chunked,
      contentLength,
      close,
    });

    // Transparently decode, matching a normal fetch, then drop the framing
    // headers that no longer describe the decoded stream.
    const enc = (resHeaders.get('content-encoding') ?? '').toLowerCase();
    if (enc === 'gzip' || enc === 'deflate') {
      body = body.pipeThrough(
        new DecompressionStream(enc) as unknown as ReadableWritablePair<
          Bytes,
          Bytes
        >,
      );
      resHeaders.delete('content-encoding');
      resHeaders.delete('content-length');
    }

    return new Response(body, { status, headers: resHeaders });
  } catch (err) {
    close();
    throw err;
  } finally {
    signal?.removeEventListener('abort', close);
  }
}

/** Build a body ReadableStream over the pinned connection, honoring
 * Transfer-Encoding: chunked, Content-Length, or read-until-close framing, and
 * closing the socket when the body is fully read or the stream is cancelled. */
function bodyStream(
  reader: ReadableStreamDefaultReader<Bytes>,
  initial: Bytes,
  framing: { chunked: boolean; contentLength: number | null; close: () => void },
): ReadableStream<Bytes> {
  let pending = initial;
  let remaining = framing.contentLength;
  let finished = false;
  // Chunked decode state, carried across pulls so a single chunk is streamed in
  // bounded slices rather than buffered whole.
  let chunkRemaining = 0; // data bytes left in the current chunk
  let awaitingTrailer = false; // need to consume the CRLF after a chunk's data

  const finish = (c: ReadableStreamDefaultController<Bytes>) => {
    if (finished) return;
    finished = true;
    framing.close();
    c.close();
  };
  // Grow `pending` until it holds at least `min` bytes; false at EOF.
  async function fill(min: number): Promise<boolean> {
    while (pending.length < min) {
      const { value, done } = await reader.read();
      if (done || !value) return false;
      pending = concatBytes(pending, value);
    }
    return true;
  }
  // Next available bytes (drains `pending` first, else one read); empty at EOF.
  async function next(): Promise<Bytes> {
    if (pending.length > 0) {
      const out = pending;
      pending = new Uint8Array(0);
      return out;
    }
    const { value, done } = await reader.read();
    return done || !value ? new Uint8Array(0) : value;
  }

  return new ReadableStream<Bytes>({
    async pull(controller) {
      try {
        if (finished) return;
        if (framing.chunked) {
          // Consume the CRLF that terminated the previous chunk's data.
          if (awaitingTrailer) {
            if (!(await fill(2))) {
              finish(controller);
              return;
            }
            pending = pending.subarray(2);
            awaitingTrailer = false;
          }
          // Parse the next chunk's size line when we're between chunks.
          if (chunkRemaining === 0) {
            let nl = indexOfCrlf(pending);
            while (nl < 0) {
              if (pending.length > 1024) {
                throw new SsrfError('chunk size line too long');
              }
              if (!(await fill(pending.length + 1))) {
                finish(controller);
                return;
              }
              nl = indexOfCrlf(pending);
            }
            const size = parseInt(
              new TextDecoder().decode(pending.subarray(0, nl)).split(';')[0],
              16,
            );
            pending = pending.subarray(nl + 2);
            if (!Number.isInteger(size) || size < 0) {
              throw new SsrfError('bad chunk size');
            }
            if (size === 0) {
              finish(controller); // last chunk
              return;
            }
            chunkRemaining = size;
          }
          // Emit only what's already buffered (or one read), bounded by the
          // chunk — so readCapped enforces maxBytes incrementally instead of
          // letting a huge advertised chunk buffer unbounded first.
          if (pending.length === 0) {
            const got = await next();
            if (got.length === 0) throw new SsrfError('truncated chunk');
            pending = got;
          }
          const take = Math.min(chunkRemaining, pending.length);
          controller.enqueue(pending.subarray(0, take));
          pending = pending.subarray(take);
          chunkRemaining -= take;
          if (chunkRemaining === 0) awaitingTrailer = true;
        } else if (remaining !== null) {
          if (remaining <= 0) {
            finish(controller);
            return;
          }
          const out = await next();
          if (out.length === 0) {
            finish(controller);
            return;
          }
          const take = out.subarray(0, remaining);
          remaining -= take.length;
          if (take.length < out.length) pending = out.subarray(take.length);
          controller.enqueue(take);
          if (remaining <= 0) finish(controller);
        } else {
          const out = await next();
          if (out.length === 0) {
            finish(controller);
            return;
          }
          controller.enqueue(out);
        }
      } catch (err) {
        framing.close();
        controller.error(err);
      }
    },
    cancel() {
      framing.close();
    },
  });
}

function concatBytes(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
function indexOfDoubleCrlf(b: Bytes): number {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}
function indexOfCrlf(b: Bytes): number {
  for (let i = 0; i + 1 < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10) return i;
  }
  return -1;
}
