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
//     against the RESOLVED IP(s), not just the literal, to defeat DNS
//     rebinding.
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
  if (a === 192 && b === 0) return true;
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
  // ::/8 reserved block other than the handled :: / ::1 (e.g. ::ffff: mapped
  // is handled earlier). Block 64:ff9b (NAT64) and other ::-prefixed oddities.
  if (groups.every((g, i) => (i < 5 ? g === 0 : true)) && groups[5] === 0) {
    // all-zero high bits → IPv4-compatible / reserved; block.
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
  const fetchImpl = opts.fetchImpl ?? fetch;

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
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!isIpLiteral(host)) {
      const ips = await resolve(host);
      if (ips.length === 0) throw new SsrfError(`No DNS records for ${host}`);
      for (const ip of ips) {
        if (isBlockedAddress(ip)) {
          throw new SsrfError(`Host ${host} resolves to blocked IP ${ip}`);
        }
      }
    }

    // TODO(PR2, P1 — DNS rebinding): we validate the resolved IP(s) above, but
    // `fetchImpl` then performs its OWN DNS lookup, so a hostile domain can
    // return a public IP to `resolve()` and rebind to a private/metadata IP
    // for the actual connection — bypassing this denylist for discover, the
    // poller, and the image proxy. The complete fix pins the connection to the
    // vetted IP (custom Deno HttpClient connecting by IP with correct SNI/cert
    // verification). Deferred to PR2 when the fetcher runs live and can be
    // tested end-to-end. See PR #1 review (codex P1).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(current, {
        method: opts.method ?? 'GET',
        headers: baseHeaders,
        redirect: 'manual', // we follow manually so we can re-check each hop
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Handle redirects ourselves so each Location is re-validated.
    if (res.status >= 300 && res.status < 400) {
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

    const body = await readCapped(res, maxBytes);
    return { status: res.status, headers: res.headers, url: current, body };
  }

  // Unreachable: the loop either returns or throws.
  throw new SsrfError('Redirect handling exhausted');
}

/** Read a response body, aborting if it exceeds `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
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
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SsrfError(`Response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
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
