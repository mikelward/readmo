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
 * `User-agent:` lines in robots.txt. Mirrors the `User-Agent` request header
 * the fetchers send (`Readmo/1.0 (+https://readmo.app)`). */
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

/** The outcome of a robots.txt check. On a disallow it also carries the
 * matching directive + its user-agent group, so the operator can see WHY a
 * fetch was blocked (surfaced on `/admin/feeds`). `rule`/`matchedUserAgent` are
 * null when allowed or when the matching line couldn't be recovered. */
export interface RobotsMatch {
  allowed: boolean;
  /** The matched `Disallow:` directive text, e.g. `Disallow: /news/`. */
  rule: string | null;
  /** The `User-agent:` group the rule belongs to (our token or `*`). */
  matchedUserAgent: string | null;
}

const ALLOWED: RobotsMatch = { allowed: true, rule: null, matchedUserAgent: null };

/**
 * Fetch and consult `<origin>/robots.txt` for `targetUrl`, returning whether our
 * crawler may fetch it — and, on a disallow, the matching rule. Fails OPEN
 * (allowed) on any error, non-2xx, or unparseable body — see the module header.
 */
export async function robotsCheck(
  targetUrl: string,
  opts: RobotsAllowsOptions = {},
): Promise<RobotsMatch> {
  let origin: string;
  try {
    const u = new URL(targetUrl);
    // Only http(s) is governed by robots.txt; anything else is out of scope and
    // safeFetch would reject it anyway — allow and let the real fetch decide.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ALLOWED;
    origin = u.origin;
  } catch {
    return ALLOWED; // unparseable URL — let the real fetch surface the error
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
    if (res.status < 200 || res.status >= 300) return ALLOWED;
    text = new TextDecoder().decode(res.body);
  } catch {
    return ALLOWED; // network error / SSRF block / timeout / oversized → fail open
  }

  return evaluateRobots(robotsUrl, text, targetUrl, userAgent);
}

/**
 * Fetch and consult `<origin>/robots.txt` for `targetUrl`, returning whether our
 * crawler may fetch it. Thin boolean wrapper over {@link robotsCheck}.
 */
export async function robotsAllows(
  targetUrl: string,
  opts: RobotsAllowsOptions = {},
): Promise<boolean> {
  return (await robotsCheck(targetUrl, opts)).allowed;
}

/**
 * Pure rule evaluation: given the robots.txt URL + body, does it allow
 * `targetUrl` for `userAgent`, and if not, which rule blocked it? Delegates to
 * `robots-parser`. Allowed when no rule applies (`isAllowed` → undefined) or the
 * body can't be parsed — the fail-open default. Exported for unit tests.
 */
export function evaluateRobots(
  robotsUrl: string,
  robotsTxt: string,
  targetUrl: string,
  userAgent: string = ROBOTS_USER_AGENT,
): RobotsMatch {
  try {
    const parser = robotsParser(robotsUrl, robotsTxt);
    // `isAllowed` returns undefined when no group/rule matches (or the URL host
    // differs from the robots host) — treat that as allowed (the default).
    if (parser.isAllowed(targetUrl, userAgent) !== false) return ALLOWED;
    // Disallowed → recover the matching directive (1-based line number) so the
    // operator can see exactly which rule blocked the fetch.
    const lineNumber = parser.getMatchingLineNumber(targetUrl, userAgent);
    const { rule, matchedUserAgent } = extractRule(robotsTxt, lineNumber);
    return { allowed: false, rule, matchedUserAgent };
  } catch {
    return ALLOWED; // parser error → fail open
  }
}

/**
 * Whether a robots.txt allows `targetUrl` (boolean). Retained for callers/tests
 * that only need the verdict; delegates to {@link evaluateRobots}.
 */
export function isUrlAllowed(
  robotsUrl: string,
  robotsTxt: string,
  targetUrl: string,
  userAgent: string = ROBOTS_USER_AGENT,
): boolean {
  return evaluateRobots(robotsUrl, robotsTxt, targetUrl, userAgent).allowed;
}

/** The directive key (`user-agent` / `disallow` / …) of a robots.txt line,
 * lowercased, or null for a blank/comment line. */
function directiveKey(line: string): string | null {
  const beforeComment = line.split('#')[0];
  const colon = beforeComment.indexOf(':');
  if (colon === -1) return null;
  const key = beforeComment.slice(0, colon).trim().toLowerCase();
  return key || null;
}

/** Given the 1-based line number of the matching directive, recover its text
 * and the `User-agent:` group it belongs to (scanning upward past the group's
 * other rule lines to its user-agent header). Best-effort: returns nulls if the
 * line can't be recovered. */
function extractRule(
  robotsTxt: string,
  lineNumber: number,
): { rule: string | null; matchedUserAgent: string | null } {
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    return { rule: null, matchedUserAgent: null };
  }
  const lines = robotsTxt.split(/\r\n|\r|\n/);
  const raw = lines[lineNumber - 1];
  if (raw == null) return { rule: null, matchedUserAgent: null };
  const rule = raw.split('#')[0].trim() || null;

  // Walk upward: skip this group's other rule lines, collect the contiguous
  // `User-agent:` header above them, then stop.
  const agents: string[] = [];
  for (let i = lineNumber - 2; i >= 0; i--) {
    const key = directiveKey(lines[i]);
    if (key === null) continue; // blank / comment
    if (key === 'user-agent') {
      const value = lines[i].split('#')[0].split(':').slice(1).join(':').trim();
      if (value) agents.unshift(value);
      continue;
    }
    if (agents.length > 0) break; // header ended → previous group's rules
  }
  // Mirror robots-parser's precedence: our specific token wins over `*`.
  const preferred =
    agents.find((a) => a.toLowerCase() === ROBOTS_USER_AGENT.toLowerCase()) ??
    agents.find((a) => a === '*') ??
    agents[0] ??
    null;
  return { rule, matchedUserAgent: preferred };
}
