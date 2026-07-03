// Bot-bypass HTML fetch via Jina Reader (r.jina.ai).
//
// Some publishers (ft.com, economist.com, …) 403 a plain server-side GET of
// their homepage even though a real browser loads it fine. `/api/discover`
// already retries such pages through Jina Reader — a headless-browser proxy that
// bypasses the bot wall — before giving up (see discover/index.ts). This module
// is the SAME fallback, factored out so the poller and the manual-refresh path
// can reuse it for homepage favicon discovery (the case the discovery feature
// exists for: a feed advertising no icon whose /favicon.ico guess 404s, but
// whose homepage <head> points at a real icon a headless browser can see).
//
// Security (guardrail #6):
//   - The fetch target is always the fixed host r.jina.ai — the page URL only
//     ever appears in the path — so there is no redirect-based SSRF here.
//   - We never forward a URL that could carry a subscriber secret to the third
//     party: a query string (`?token=…`) or a tokenized resource path
//     (`…/<secret>.xml`) is screened out. A site homepage — the only thing this
//     is called with — has neither.
//
// Deno's env is read through the same node-safe `globalThis` guard ssrf.ts uses,
// so the module type-checks under tsc and imports cleanly under vitest (where
// `Deno` is undefined and `JINA_API_KEY` is absent, so it no-ops to null).

import { looksTokenized } from './urlSafety.ts';

/** A page fetcher that returns raw HTML, or null when unavailable/screened. */
export type JinaHtmlFetch = (target: string) => Promise<string | null>;

/** Cap on the Jina response body — plenty for any HTML <head>, and a guard
 * against memory exhaustion from a large or slow response. */
const JINA_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB

function jinaApiKey(): string | undefined {
  return (globalThis as {
    Deno?: { env?: { get(k: string): string | undefined } };
  }).Deno?.env?.get?.('JINA_API_KEY');
}

/**
 * Fetch a page via Jina Reader as raw HTML. Returns the HTML on success, or null
 * when Jina is unconfigured (`JINA_API_KEY` unset — the unit-test / self-hosted
 * default), the URL looks like it could carry a secret, or the request fails.
 * Never throws.
 */
export async function fetchViaJinaHtml(target: string): Promise<string | null> {
  const apiKey = jinaApiKey();
  if (!apiKey) return null;

  // Screen the URL before forwarding it to the third party (guardrail #6): the
  // page URL travels in the r.jina.ai path, so anything secret-bearing would
  // leak. `looksTokenized` is the module's canonical check — it rejects embedded
  // credentials (`user:pass@…`), ANY query string (`?token=…`), and high-entropy
  // /tokenized path segments; it also fails closed on an unparseable URL. On top
  // of that, on the DECODED path (so a percent-encoded form can't slip past) we
  // reject two more secret-smuggling shapes the favicon URL screen already
  // blocks (`looksTokenizedAllowingQuery`) but `looksTokenized` doesn't, testing
  // EVERY non-empty segment (not just the last) so a trailing slash
  // (`/feeds/x.xml/`) or a mid-path resource can't slip past:
  //   - a matrix path param (`;jsessionid=…`) — a session/credential vector;
  //   - a file extension (`/feeds/<secret>.xml`) — a resource URL, whereas a
  //     site homepage (all this is called with) has none in any segment.
  // SSRF host screening (loopback/link-local/private/metadata) is enforced
  // upstream: the caller only reaches Jina on a real non-2xx HTTP status from a
  // host safeFetch already vetted, never on the throw safeFetch raises for those.
  if (looksTokenized(target)) return null;
  try {
    const pathname = new URL(target).pathname;
    for (const rawSegment of pathname.split('/')) {
      if (!rawSegment) continue;
      // Decode each segment INDEPENDENTLY: decoding the whole path at once lets
      // one malformed escape (`%E0%A4%A`) throw and drop every OTHER segment
      // back to its raw, still-encoded form, hiding an encoded `.`/`;` elsewhere.
      let segment: string;
      try {
        segment = decodeURIComponent(rawSegment);
      } catch {
        return null; // can't normalize this segment → fail closed, don't forward.
      }
      if (segment.includes('.') || segment.includes(';')) return null;
    }
  } catch {
    return null;
  }

  try {
    const res = await fetch(`https://r.jina.ai/${target}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Return-Format': 'html',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    // Read the body with a size cap to prevent memory exhaustion.
    const reader = res.body?.getReader();
    if (!reader) return await res.text();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      total += value.byteLength;
      if (total > JINA_MAX_BYTES) {
        reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return new TextDecoder().decode(out);
  } catch {
    return null;
  }
}
