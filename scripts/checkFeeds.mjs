// Feed health checker for the curated suggestions in src/lib/popularFeeds.ts.
//
// Fetches every feedUrl and reports the ones that fail to load or don't look
// like a feed, so dead/rotted entries get caught before a user hits them.
//
//   node scripts/checkFeeds.mjs            (or: npm run feeds:check)
//   node scripts/checkFeeds.mjs --json     machine-readable output
//
// Run it locally or in CI where the public internet is reachable — it is NOT
// wired into the per-PR build (it makes one outbound request per feed, ~150+).
// Some sandboxes block outbound egress to news domains, in which case every
// feed "fails" with a connection error; that's the environment, not the feeds.
//
// Exit code is 1 when any feed fails, 0 when all pass, so a manual or scheduled
// CI job can gate on it.
//
// Cost/reliability (guardrail #5): no third-party service, no API key — plain
// HTTP GETs to the publishers themselves. Negligible cost. The publishers'
// own availability is the only dependency; a transient outage shows as a
// failure for that one feed and does not affect the others.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEEDS_FILE = path.join(ROOT, 'src/lib/popularFeeds.ts');

const TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;
const SNIFF_BYTES = 2_000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; ReadmoFeedCheck/1.0; +https://readmo.app)';

/** Extract `{ name, feedUrl }` pairs from the popularFeeds.ts source. Reading
 * the source text (rather than importing the TS module) keeps this runnable
 * with plain `node`, no transpile step. popularFeeds.test.ts guards the data
 * file's shape, and checkFeeds.test.ts asserts this parser stays in lockstep
 * with the exported list, so the regex can't silently drift. */
export function parseFeedList(source) {
  const re =
    /name:\s*'((?:[^'\\]|\\.)*)'\s*,\s*feedUrl:\s*'((?:[^'\\]|\\.)*)'/g;
  const entries = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    entries.push({ name: unescapeSingleQuoted(m[1]), feedUrl: unescapeSingleQuoted(m[2]) });
  }
  return entries;
}

function unescapeSingleQuoted(s) {
  return s.replace(/\\(['"\\])/g, '$1');
}

/** Strip the leading whitespace, BOM, XML declaration / processing
 * instructions (`<?xml …?>`, `<?xml-stylesheet …?>`), comments, and DOCTYPE
 * from `s`, so what remains starts with the document's root element. */
function stripXmlProlog(s) {
  let out = s.replace(/^﻿/, '');
  for (;;) {
    const before = out;
    out = out
      .replace(/^\s+/, '')
      .replace(/^<\?[\s\S]*?\?>/, '')
      .replace(/^<!--[\s\S]*?-->/, '')
      .replace(/^<!doctype[\s\S]*?>/i, '');
    if (out === before) return out;
  }
}

/** Heuristic: does this response *body* look like an RSS/Atom/RDF/JSON feed?
 *
 * Anchored to the document root, not a substring match: a rotted URL can
 * return an HTML help/error page that merely *mentions* `<rss>`/`<feed>` in its
 * text, so we strip the prolog and require the first real element to be a feed
 * root. That also rejects a 200 XML error document (S3/Cloudflare `<Error>`),
 * whose root isn't a feed.
 *
 * The content-type is deliberately NOT consulted: a dead endpoint can serve an
 * empty/challenge body under a feed content-type (must report dead), while
 * real feeds are often misserved as `text/xml` or `text/html` (must still
 * pass) — the body is decisive in both directions. */
export function looksLikeFeed(bodyStart) {
  const root = stripXmlProlog((bodyStart || '').toLowerCase());
  // The trailing `[\s>]`/`[:\s>]` requires a tag boundary, so `<feedback>`
  // isn't mistaken for an Atom `<feed>` and `<rdf:rdf` is matched.
  if (/^<rss[\s>]/.test(root) || /^<feed[\s>]/.test(root) || /^<rdf[:\s>]/.test(root)) {
    return true;
  }
  // JSON Feed (jsonfeed.org) — an object carrying the spec's version marker.
  if (root.startsWith('{') && root.includes('jsonfeed.org')) return true;
  return false;
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait before retrying a 429, from its `Retry-After` header.
 * Honors the numeric-seconds form (what Reddit sends), capped so the checker
 * never stalls for long; falls back to `defaultMs` for missing/HTTP-date
 * values. */
export function retryDelayMs(retryAfter, { defaultMs = 2_000, capMs = 15_000 } = {}) {
  // `Number(null)` and `Number('')` are 0, so guard the empty cases explicitly.
  if (retryAfter == null || retryAfter === '') return defaultMs;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, capMs);
  return defaultMs;
}

// Per-host serialization: at most one in-flight request per host. A burst of
// same-host feeds (e.g. the six reddit.com feeds) would otherwise hit the host
// concurrently and trip its rate limiter — Reddit 429s a parallel burst even
// though each feed is healthy and the production poller (which fetches them
// spaced out, one per scheduled interval) never sees it. Different hosts still
// run concurrently up to the pool size.
const hostChains = new Map();
function withHostLock(host, fn) {
  const prev = hostChains.get(host) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  hostChains.set(
    host,
    result.then(
      () => {},
      () => {},
    ),
  );
  return result;
}

async function fetchAndClassify({ name, feedUrl }) {
  // Retry once on 429 after honoring Retry-After, so a transient rate-limit
  // (rather than a dead feed) doesn't get reported as a failure.
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(feedUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept:
            'application/rss+xml, application/atom+xml, application/xml;q=0.9, application/json;q=0.8, */*;q=0.5',
        },
      });
      if (res.status === 429 && attempt === 0) {
        await sleep(retryDelayMs(res.headers.get('retry-after')));
        continue;
      }
      const contentType = res.headers.get('content-type') || '';
      const body = await res.text();
      const isFeed = looksLikeFeed(body.slice(0, SNIFF_BYTES));
      const ok = res.ok && isFeed;
      const reason = ok
        ? ''
        : !res.ok
          ? `HTTP ${res.status}`
          : `not a feed (content-type: ${contentType || 'none'})`;
      return { name, feedUrl, ok, status: res.status, finalUrl: res.url, reason };
    } catch (err) {
      const reason =
        err.name === 'AbortError'
          ? `timeout after ${TIMEOUT_MS}ms`
          : err.cause?.code || err.message || 'fetch failed';
      return { name, feedUrl, ok: false, status: 0, finalUrl: feedUrl, reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

function checkOne(feed) {
  return withHostLock(hostOf(feed.feedUrl), () => fetchAndClassify(feed));
}

/** Run `worker` over `items` with a fixed concurrency, preserving input order. */
async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function drain() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, drain),
  );
  return results;
}

async function main() {
  const asJson = process.argv.includes('--json');
  const source = await readFile(FEEDS_FILE, 'utf8');
  const feeds = parseFeedList(source);
  const results = await runPool(feeds, checkOne, CONCURRENCY);
  const failures = results.filter((r) => !r.ok);

  if (asJson) {
    process.stdout.write(
      JSON.stringify({ total: results.length, failing: failures.length, failures }, null, 2) +
        '\n',
    );
  } else {
    for (const r of failures) {
      process.stdout.write(`✗ ${r.name}\n    ${r.feedUrl}\n    ${r.reason}\n`);
    }
    const okCount = results.length - failures.length;
    process.stdout.write(
      `\n${okCount}/${results.length} feeds OK — ${failures.length} failing.\n`,
    );
  }
  process.exitCode = failures.length > 0 ? 1 : 0;
}

// Run only when invoked directly, not when imported by the unit test.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
