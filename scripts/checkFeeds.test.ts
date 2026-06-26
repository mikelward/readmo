// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations.
import { parseFeedList, looksLikeFeed, retryDelayMs } from './checkFeeds.mjs';
import { POPULAR_FEEDS } from '../src/lib/popularFeeds';

const source = readFileSync(
  new URL('../src/lib/popularFeeds.ts', import.meta.url),
  'utf8',
);

describe('parseFeedList', () => {
  it('extracts the same feeds the module actually exports', () => {
    // The regex parser must stay in lockstep with the real data file — if the
    // entry format changes, this fails instead of the checker silently
    // skipping feeds.
    const parsed = parseFeedList(source) as Array<{ name: string; feedUrl: string }>;
    expect(parsed.length).toBe(POPULAR_FEEDS.length);
    expect(parsed.map((f) => f.feedUrl).sort()).toEqual(
      POPULAR_FEEDS.map((f) => f.feedUrl).sort(),
    );
    expect(parsed.map((f) => f.name).sort()).toEqual(
      POPULAR_FEEDS.map((f) => f.name).sort(),
    );
  });

  it("unescapes embedded single quotes (e.g. Tom's Hardware)", () => {
    const parsed = parseFeedList(
      "{ name: 'Tom\\'s Hardware', feedUrl: 'https://www.tomshardware.com/feeds/all', category: 'Technology' },",
    );
    expect(parsed).toEqual([
      { name: "Tom's Hardware", feedUrl: 'https://www.tomshardware.com/feeds/all' },
    ]);
  });
});

describe('looksLikeFeed', () => {
  it('accepts RSS / Atom / RDF XML by body', () => {
    expect(looksLikeFeed('<?xml version="1.0"?><rss version="2.0">')).toBe(true);
    expect(looksLikeFeed('<feed xmlns="http://www.w3.org/2005/Atom">')).toBe(true);
    expect(looksLikeFeed('<rdf:RDF xmlns="...">')).toBe(true);
    // Leading BOM + whitespace must not defeat the sniff.
    expect(looksLikeFeed('﻿\n  <?xml version="1.0"?>\n<rss version="2.0">')).toBe(true);
  });

  it('rejects a 200 XML error document (the prolog alone is not enough)', () => {
    // A rotted URL can return a well-formed but non-feed XML error page; the
    // checker must surface it as dead, not pass it on the `<?xml` declaration.
    expect(looksLikeFeed('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>')).toBe(false);
    // ...and a `<feedback>` element must not be mistaken for an Atom `<feed>`.
    expect(looksLikeFeed('<?xml version="1.0"?><feedback>ok</feedback>')).toBe(false);
  });

  it('accepts JSON Feed', () => {
    expect(looksLikeFeed('{"version":"https://jsonfeed.org/version/1.1","items":[]}')).toBe(true);
  });

  it('does not let a feed content-type rescue a non-feed body', () => {
    // The caller no longer passes the content-type — the body is decisive. A
    // 200 served as application/rss+xml but carrying an empty/error/challenge
    // body must still be reported as dead, which is the whole point of the
    // checker. (Signature is body-only; these strings are bodies, not types.)
    expect(looksLikeFeed('')).toBe(false);
    expect(looksLikeFeed('Just a moment... (bot challenge)')).toBe(false);
    expect(looksLikeFeed('<!doctype html><html><head>')).toBe(false);
    expect(looksLikeFeed('Not Found')).toBe(false);
  });

  it('anchors to the root, not a substring (HTML mentioning <rss> is dead)', () => {
    // A rotted URL serving an HTML help/error page that merely mentions a feed
    // tag in its body must not pass — the root element decides.
    expect(
      looksLikeFeed('<!doctype html><html><body>Subscribe via our <rss> feed.</body></html>'),
    ).toBe(false);
    // A real feed behind a comment / stylesheet PI still passes (root is found
    // after the prolog is stripped).
    expect(
      looksLikeFeed('<?xml version="1.0"?>\n<?xml-stylesheet href="x.xsl"?>\n<!-- generated -->\n<rss version="2.0">'),
    ).toBe(true);
  });
});

describe('retryDelayMs', () => {
  it('honors a numeric Retry-After (seconds), capped', () => {
    expect(retryDelayMs('5')).toBe(5_000);
    expect(retryDelayMs('0')).toBe(0);
    expect(retryDelayMs('600')).toBe(15_000); // capped
  });

  it('falls back to the default for missing or non-numeric values', () => {
    expect(retryDelayMs(null)).toBe(2_000);
    expect(retryDelayMs(undefined)).toBe(2_000);
    expect(retryDelayMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(2_000);
  });
});
