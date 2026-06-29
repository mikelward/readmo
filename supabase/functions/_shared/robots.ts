// Readmo robots.txt honoring.
//
// Reading-mode full-text extraction (the `fulltext` Edge Function) fetches an
// article's OWN HTML page — a crawl beyond the syndicated feed body — so it
// asks the publisher's robots.txt for permission first. This module fetches
// `/robots.txt` for the target's origin (through the SSRF-hardened safeFetch —
// the robots fetch is itself a server-side fetch of a user-influenced origin,
// guardrail #6) and consults it for our product token.
//
// Parsing/matching is delegated to `robots-parser` (a mature, zero-dependency,
// spec-tested MIT library) rather than a hand-rolled parser — it handles the
// RFC 9309 fiddly bits (group selection, Allow/Disallow precedence, `*`/`$`
// wildcards, and path percent-encoding normalization) that are easy to get
// subtly wrong. It's pure JS using only the `URL` global, so it runs unchanged
// under Deno (via `npm:` in import_map.json) and vitest (node).
//
// Fail OPEN: a missing (404), unreachable, non-2xx, oversized, or unparseable
// robots.txt is treated as "no restriction" — the robots.txt convention is that
// absence of rules means everything is allowed, and a publisher's flaky
// robots.txt must never silently stop a legitimate fetch. Only a robots.txt we
// successfully fetched AND parsed, whose applicable group disallows the target,
// blocks the fetch.

import robotsParser from 'robots-parser';
import { safeFetch } from './ssrf.ts';

/** Our crawler's product token, matched (case-insensitively) against the
 * `User-agent:` lines in robots.txt. This is the bare product name — the
 * request UA carries a version (`Readmo/1.0.<build> …`, see version.ts) but
 * robots.txt matches on the product token, which stays `Readmo`. */
export const ROBOTS_USER_AGENT = 'Readmo';

/** Minimal shape of a fetch result `robotsAllows` needs — `safeFetch` satisfies
 * it, and tests pass a fake without standing up the whole SSRF stack. */
interface RobotsFetchResult {
  status: number;
  body: Uint8Array;
}
type RobotsFetcher = (
  url: string,
  opts?: { timeoutMs?: number; maxBytes?: number },
) => Promise<RobotsFetchResult>;

export interface RobotsAllowsOptions {
  /** Product token to match against `User-agent:` lines. Defaults to
   * {@link ROBOTS_USER_AGENT}. */
  userAgent?: string;
  /** Injectable fetcher (defaults to safeFetch); tests pass a fake. */
  fetcher?: RobotsFetcher;
  /** Abort the robots.txt fetch after this many ms (default 5_000). */
  timeoutMs?: number;
}

// robots.txt files are tiny in practice; cap well below safeFetch's default so a
// hostile origin can't make us buffer megabytes for a permission check. RFC 9309
// asks crawlers to parse at least 500 KiB, so allow that much.
const ROBOTS_MAX_BYTES = 512 * 1024;
const DEFAULT_ROBOTS_TIMEOUT_MS = 5_000;

/**
 * Fetch and consult `<origin>/robots.txt` for `targetUrl`, returning whether our
 * crawler may fetch it. Fails OPEN (returns true) on any error, non-2xx, or
 * unparseable body — see the module header.
 */
export async function robotsAllows(
  targetUrl: string,
  opts: RobotsAllowsOptions = {},
): Promise<boolean> {
  let origin: string;
  try {
    const u = new URL(targetUrl);
    // Only http(s) is governed by robots.txt; anything else is out of scope and
    // safeFetch would reject it anyway — allow and let the real fetch decide.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    origin = u.origin;
  } catch {
    return true; // unparseable URL — let the real fetch surface the error
  }

  const fetcher = opts.fetcher ?? safeFetch;
  const userAgent = opts.userAgent ?? ROBOTS_USER_AGENT;
  const robotsUrl = `${origin}/robots.txt`;

  let text: string;
  try {
    const res = await fetcher(robotsUrl, {
      timeoutMs: opts.timeoutMs ?? DEFAULT_ROBOTS_TIMEOUT_MS,
      maxBytes: ROBOTS_MAX_BYTES,
    });
    // Per RFC 9309: a 4xx (incl. 404 "no robots.txt") means unrestricted. We
    // additionally fail open on 5xx and anything else non-2xx (the user-chosen
    // policy), so only a body we actually got back gets parsed.
    if (res.status < 200 || res.status >= 300) return true;
    text = new TextDecoder().decode(res.body);
  } catch {
    return true; // network error / SSRF block / timeout / oversized → fail open
  }

  return isUrlAllowed(robotsUrl, text, targetUrl, userAgent);
}

/**
 * Pure rule evaluation: given the robots.txt URL + body, does it allow
 * `targetUrl` for `userAgent`? Delegates to `robots-parser`. Returns true when
 * no rule applies (`isAllowed` → undefined) or the body can't be parsed —
 * the fail-open default. Exported for unit tests (no network needed).
 */
export function isUrlAllowed(
  robotsUrl: string,
  robotsTxt: string,
  targetUrl: string,
  userAgent: string = ROBOTS_USER_AGENT,
): boolean {
  let allowed: boolean | undefined;
  try {
    allowed = robotsParser(robotsUrl, robotsTxt).isAllowed(targetUrl, userAgent);
  } catch {
    return true; // parser error → fail open
  }
  // `isAllowed` returns undefined when no group/rule matches (or the URL host
  // differs from the robots host) — treat that as allowed (the default).
  return allowed !== false;
}
