// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CIRCUIT_BREAKER_FAILS,
  MAX_INTERVAL_S,
  pollOne,
  recordFailure,
  resolveStoredFavicon,
} from './poller.ts';
import type { PollerDbClient, PollerFeedRow, PollerFetch } from './poller.ts';
import type { SafeFetchResult } from './ssrf.ts';

const FEED: PollerFeedRow = {
  id: 'feed-1',
  url: 'https://example.com/feed.xml',
  secret_url: null,
  etag: null,
  last_modified: null,
  fetch_interval_s: 1800,
  error_count: 0,
  favicon_url: null,
};

const RSS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Test Feed</title>
  <link>https://example.com/</link>
  <item>
    <title>First item</title>
    <link>https://example.com/a</link>
    <guid>https://example.com/a</guid>
  </item>
</channel></rss>`;

type RecordedCall =
  | { kind: 'update'; table: string; values: Record<string, unknown> }
  | { kind: 'rpc'; fn: string; args: Record<string, unknown> };

/** In-memory PollerDbClient that records every write in call order. */
function makeClient(opts?: { upsertError?: { message: string } }) {
  const calls: RecordedCall[] = [];
  const client: PollerDbClient = {
    from(table) {
      return {
        update(values) {
          return {
            eq() {
              calls.push({ kind: 'update', table, values });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
    rpc(fn, args) {
      calls.push({ kind: 'rpc', fn, args });
      return Promise.resolve({ error: opts?.upsertError ?? null });
    },
  };
  return { client, calls };
}

function makeFetch(res: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}): { fetchFn: PollerFetch; requests: Array<{ url: string; headers: Record<string, string> }> } {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn: PollerFetch = (url, options) => {
    requests.push({ url, headers: options?.headers ?? {} });
    const result: SafeFetchResult = {
      status: res.status,
      headers: new Headers(res.headers ?? {}),
      url,
      body: new TextEncoder().encode(res.body ?? ''),
    };
    return Promise.resolve(result);
  };
  return { fetchFn, requests };
}

const updatesWithValidators = (calls: RecordedCall[]) =>
  calls.filter((c) => c.kind === 'update' && ('etag' in c.values || 'last_modified' in c.values));

describe('pollOne validator ordering', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists etag/last_modified only AFTER the item upsert succeeds', async () => {
    const { client, calls } = makeClient();
    const { fetchFn } = makeFetch({
      status: 200,
      headers: {
        'content-type': 'application/rss+xml',
        'etag': 'W/"abc"',
        'last-modified': 'Tue, 30 Jun 2026 01:02:03 GMT',
      },
      body: RSS_BODY,
    });

    await pollOne(client, FEED, fetchFn);

    // The metadata update that precedes the upsert must not carry validators.
    const rpcIndex = calls.findIndex((c) => c.kind === 'rpc');
    expect(rpcIndex).toBeGreaterThanOrEqual(0);
    for (const call of calls.slice(0, rpcIndex)) {
      expect(call.kind).toBe('update');
      expect(call).not.toHaveProperty('values.etag');
      expect(call).not.toHaveProperty('values.last_modified');
    }

    // The validators land in the post-upsert schedule update.
    const validatorWrites = updatesWithValidators(calls);
    expect(validatorWrites).toHaveLength(1);
    expect(calls.indexOf(validatorWrites[0])).toBeGreaterThan(rpcIndex);
    expect(validatorWrites[0]).toMatchObject({
      values: {
        etag: 'W/"abc"',
        last_modified: 'Tue, 30 Jun 2026 01:02:03 GMT',
        error_count: 0,
      },
    });
  });

  it('leaves validators unwritten when the item upsert fails, so the next poll refetches unconditionally', async () => {
    // Regression: writing the new ETag before upsert_feed_items meant a
    // transient upsert failure made the next poll send If-None-Match, get a
    // 304, and permanently skip the items that were never stored.
    const { client, calls } = makeClient({ upsertError: { message: 'statement timeout' } });
    const { fetchFn } = makeFetch({
      status: 200,
      headers: { 'content-type': 'application/rss+xml', 'etag': 'W/"abc"' },
      body: RSS_BODY,
    });

    await expect(pollOne(client, FEED, fetchFn)).rejects.toThrow('item upsert failed');
    expect(updatesWithValidators(calls)).toHaveLength(0);
  });

  it('sanitizes the summary before storing (publisher HTML, guardrail #6)', async () => {
    // A distinct <description> next to <content:encoded> survives as the
    // summary — it is publisher HTML and must be sanitized like the body.
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
  <title>Test Feed</title>
  <link>https://example.com/</link>
  <item>
    <title>First item</title>
    <link>https://example.com/a</link>
    <guid>https://example.com/a</guid>
    <description>&lt;p onclick="steal()"&gt;Teaser&lt;/p&gt;&lt;script&gt;evil()&lt;/script&gt;</description>
    <content:encoded>&lt;p&gt;Full body&lt;/p&gt;</content:encoded>
  </item>
</channel></rss>`;
    const { client, calls } = makeClient();
    const { fetchFn } = makeFetch({
      status: 200,
      headers: { 'content-type': 'application/rss+xml' },
      body,
    });

    await pollOne(client, FEED, fetchFn);

    const rpc = calls.find((c) => c.kind === 'rpc') as Extract<RecordedCall, { kind: 'rpc' }>;
    const items = rpc.args.p_items as Array<Record<string, unknown>>;
    expect(items[0].summary).toBe('<p>Teaser</p>');
    // No distinct summary → null survives (not collapsed to '').
    const { client: c2, calls: calls2 } = makeClient();
    const { fetchFn: f2 } = makeFetch({
      status: 200,
      headers: { 'content-type': 'application/rss+xml' },
      body: RSS_BODY,
    });
    await pollOne(c2, FEED, f2);
    const rpc2 = calls2.find((c) => c.kind === 'rpc') as Extract<RecordedCall, { kind: 'rpc' }>;
    expect((rpc2.args.p_items as Array<Record<string, unknown>>)[0].summary).toBeNull();
  });

  it('does not clobber stored validators on a 304', async () => {
    const { client, calls } = makeClient();
    const { fetchFn, requests } = makeFetch({ status: 304 });
    const feed = { ...FEED, etag: 'W/"stored"', last_modified: 'Mon, 29 Jun 2026 00:00:00 GMT' };

    await pollOne(client, feed, fetchFn);

    // Conditional headers were sent from the stored validators…
    expect(requests[0].headers['If-None-Match']).toBe('W/"stored"');
    expect(requests[0].headers['If-Modified-Since']).toBe('Mon, 29 Jun 2026 00:00:00 GMT');
    // …and the reschedule stamps the check without touching them.
    expect(updatesWithValidators(calls)).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'update', values: { error_count: 0 } });
    expect((calls[0] as { values: Record<string, unknown> }).values).toHaveProperty('last_fetched_at');
  });
});

// A fetchFn that serves a canned response per URL and records the URLs hit.
function routedFetch(routes: Record<string, { status?: number; ct?: string; body?: string }>) {
  const requests: string[] = [];
  const fetchFn: PollerFetch = (url) => {
    requests.push(url);
    const r = routes[url] ?? { status: 404 };
    return Promise.resolve({
      status: r.status ?? 200,
      headers: new Headers(r.ct ? { 'content-type': r.ct } : {}),
      url,
      body: new TextEncoder().encode(r.body ?? ''),
    } satisfies SafeFetchResult);
  };
  return { fetchFn, requests };
}

const faviconOf = (calls: RecordedCall[]): unknown => {
  const meta = calls.find(
    (c) => c.kind === 'update' && 'favicon_url' in c.values,
  ) as { values: Record<string, unknown> } | undefined;
  return meta?.values.favicon_url;
};

describe('resolveStoredFavicon', () => {
  const HTML_ICON = '<html><head><link rel="icon" href="/brand/icon.png"></head></html>';

  it('returns the advertised icon without any fetch', async () => {
    const { fetchFn, requests } = routedFetch({});
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://cdn.example.com/adv.png', faviconAdvertised: true, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
    );
    expect(url).toBe('https://cdn.example.com/adv.png');
    expect(requests).toEqual([]);
  });

  it('reuses a stored real icon without fetching', async () => {
    const { fetchFn, requests } = routedFetch({});
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      'https://example.com/brand/icon.png',
      fetchFn,
    );
    expect(url).toBe('https://example.com/brand/icon.png');
    expect(requests).toEqual([]);
  });

  it('discovers the homepage <link rel="icon"> when nothing is advertised or stored', async () => {
    const { fetchFn, requests } = routedFetch({
      'https://example.com/': { ct: 'text/html', body: HTML_ICON },
    });
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
    );
    expect(url).toBe('https://example.com/brand/icon.png');
    expect(requests).toEqual(['https://example.com/']);
  });

  it('is one-shot: never re-fetches the homepage once any favicon (even the guess) is stored', async () => {
    // Regression for the "rediscover favicons that match the guess" case: a
    // homepage advertising <link rel="icon" href="/favicon.ico"> stores a URL
    // equal to the guess — later polls must still reuse it, not re-fetch.
    const { fetchFn, requests } = routedFetch({
      'https://example.com/': { ct: 'text/html', body: HTML_ICON },
    });
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      'https://example.com/favicon.ico',
      fetchFn,
    );
    expect(url).toBe('https://example.com/favicon.ico');
    expect(requests).toEqual([]);
  });

  it('skips a candidate rejected by the favicon screen and takes a later safe one', async () => {
    // The first advertised icon is a data: URL (rejected by cleanFaviconUrl);
    // a second, safe icon follows. Discovery must not stop at the first.
    const { fetchFn } = routedFetch({
      'https://example.com/': {
        ct: 'text/html',
        body:
          '<head><link rel="icon" href="data:image/png;base64,AAAA">' +
          '<link rel="icon" href="/real.png"></head>',
      },
    });
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
    );
    expect(url).toBe('https://example.com/real.png');
  });

  it('falls back to the guess when the homepage advertises no icon', async () => {
    const { fetchFn } = routedFetch({
      'https://example.com/': { ct: 'text/html', body: '<html><head><title>x</title></head></html>' },
    });
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
    );
    expect(url).toBe('https://example.com/favicon.ico');
  });

  it('falls back to the guess when the homepage fetch is non-2xx', async () => {
    const { fetchFn } = routedFetch({ 'https://example.com/': { status: 503 } });
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
    );
    expect(url).toBe('https://example.com/favicon.ico');
  });

  it('never lets a homepage fetch error fail resolution', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn: PollerFetch = () => Promise.reject(new Error('network down'));
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
    );
    expect(url).toBe('https://example.com/favicon.ico');
    vi.restoreAllMocks();
  });

  it('skips discovery (uses the guess) when there is no site URL', async () => {
    const { fetchFn, requests } = routedFetch({});
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: null },
      null,
      fetchFn,
    );
    expect(url).toBe('https://example.com/favicon.ico');
    expect(requests).toEqual([]);
  });

  // A recording Jina fake: serves canned HTML per URL and records the URLs hit.
  const jinaFake = (routes: Record<string, string | null>) => {
    const targets: string[] = [];
    const jinaFetch = (target: string) => {
      targets.push(target);
      return Promise.resolve(routes[target] ?? null);
    };
    return { jinaFetch, targets };
  };

  it('retries a bot-blocked (403) homepage through Jina and stores the discovered icon', async () => {
    // The exact ft.com case: /favicon.ico guess would 404, and the homepage that
    // advertises the real icon 403s a plain GET but loads via Jina Reader.
    const { fetchFn } = routedFetch({ 'https://example.com/': { status: 403 } });
    const { jinaFetch, targets } = jinaFake({
      'https://example.com/': '<head><link rel="icon" href="/real.png"></head>',
    });
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
      jinaFetch,
    );
    expect(url).toBe('https://example.com/real.png');
    expect(targets).toEqual(['https://example.com/']);
  });

  it('does NOT retry via Jina when the direct homepage fetch THROWS (SSRF/DNS/timeout)', async () => {
    // A thrown fetch is indistinguishable from safeFetch failing closed on an
    // SSRF-unsafe host (loopback/link-local/private/metadata) — we must not hand
    // such a URL to a third party, so a throw falls back to the guess, never Jina.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn: PollerFetch = () => Promise.reject(new Error('SSRF: link-local address'));
    const { jinaFetch, targets } = jinaFake({
      'https://example.com/': '<head><link rel="apple-touch-icon" href="/apple.png"></head>',
    });
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
      jinaFetch,
    );
    expect(url).toBe('https://example.com/favicon.ico');
    expect(targets).toEqual([]);
    vi.restoreAllMocks();
  });

  it('absolutizes the Jina-discovered icon against the post-redirect homepage host', async () => {
    // example.com -> www.example.com then 403: safeFetch resolves to the www
    // host; the Jina retry must target/parse against that, so a relative
    // <link rel="icon" href="/real.png"> lands on www.example.com, not example.com.
    const requested: string[] = [];
    const fetchFn: PollerFetch = (url) => {
      requested.push(url);
      return Promise.resolve({
        status: 403,
        headers: new Headers(),
        url: 'https://www.example.com/', // post-redirect final URL
        body: new TextEncoder().encode(''),
      });
    };
    const jinaTargets: string[] = [];
    const jinaFetch = (target: string) => {
      jinaTargets.push(target);
      return Promise.resolve('<head><link rel="icon" href="/real.png"></head>');
    };
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
      jinaFetch,
    );
    expect(url).toBe('https://www.example.com/real.png');
    expect(jinaTargets).toEqual(['https://www.example.com/']);
  });

  it('forwards only the origin root to Jina, never a tokenized homepage path', async () => {
    // A feed with a token in feeds.url (secret_url null, per 0004) can resolve
    // siteUrl under the token path; the Jina target must be the bare origin so a
    // short token can't ride into the third-party request.
    const { fetchFn } = routedFetch({ 'https://example.com/member/abc123/': { status: 403 } });
    const { jinaFetch, targets } = jinaFake({
      'https://example.com/': '<head><link rel="icon" href="/real.png"></head>',
    });
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/member/abc123/' },
      null,
      fetchFn,
      jinaFetch,
    );
    expect(url).toBe('https://example.com/real.png');
    expect(targets).toEqual(['https://example.com/']); // origin root, token stripped
  });

  it('does NOT spend a Jina call when the homepage is reachable but advertises no icon', async () => {
    // A reachable, iconless page → the /favicon.ico guess is the right answer;
    // an ordinary site must not burn a third-party fetch on every poll.
    const { fetchFn } = routedFetch({
      'https://example.com/': { ct: 'text/html', body: '<html><head><title>x</title></head></html>' },
    });
    const { jinaFetch, targets } = jinaFake({
      'https://example.com/': '<head><link rel="icon" href="/real.png"></head>',
    });
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
      jinaFetch,
    );
    expect(url).toBe('https://example.com/favicon.ico');
    expect(targets).toEqual([]);
  });

  it('does NOT proxy a rate-limited (429) or server-error (5xx) homepage through Jina', async () => {
    // Only 401/403 (auth/bot-wall) warrant a Jina retry; a 429 throttle or a
    // transient 5xx falls back to the guess without burning Jina quota.
    for (const status of [429, 503]) {
      const { fetchFn } = routedFetch({ 'https://example.com/': { status } });
      const { jinaFetch, targets } = jinaFake({
        'https://example.com/': '<head><link rel="icon" href="/real.png"></head>',
      });
      const url = await resolveStoredFavicon(
        { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
        null,
        fetchFn,
        jinaFetch,
      );
      expect(url).toBe('https://example.com/favicon.ico');
      expect(targets).toEqual([]);
    }
  });

  it('retries via Jina on a 401 (auth-wall), like a 403', async () => {
    const { fetchFn } = routedFetch({ 'https://example.com/': { status: 401 } });
    const { jinaFetch, targets } = jinaFake({
      'https://example.com/': '<head><link rel="icon" href="/real.png"></head>',
    });
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
      jinaFetch,
    );
    expect(url).toBe('https://example.com/real.png');
    expect(targets).toEqual(['https://example.com/']);
  });

  it('falls back to the guess when a blocked homepage yields nothing from Jina either', async () => {
    const { fetchFn } = routedFetch({ 'https://example.com/': { status: 403 } });
    const { jinaFetch, targets } = jinaFake({ 'https://example.com/': null });
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
      jinaFetch,
    );
    expect(url).toBe('https://example.com/favicon.ico');
    expect(targets).toEqual(['https://example.com/']);
  });

  it('never lets a Jina failure fail resolution', async () => {
    const { fetchFn } = routedFetch({ 'https://example.com/': { status: 403 } });
    const jinaFetch = () => Promise.reject(new Error('jina exploded'));
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
      jinaFetch,
    );
    expect(url).toBe('https://example.com/favicon.ico');
  });

  it('does not reach for Jina at all when none is supplied (blocked → guess)', async () => {
    // Preserves the pre-fallback behavior for callers that pass no Jina fetcher.
    const { fetchFn } = routedFetch({ 'https://example.com/': { status: 403 } });
    const url = await resolveStoredFavicon(
      { faviconUrl: 'https://example.com/favicon.ico', faviconAdvertised: false, siteUrl: 'https://example.com/' },
      null,
      fetchFn,
    );
    expect(url).toBe('https://example.com/favicon.ico');
  });
});

describe('pollOne favicon discovery', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores a homepage-discovered icon for a feed that advertises none', async () => {
    const { client, calls } = makeClient();
    const { fetchFn, requests } = routedFetch({
      'https://example.com/feed.xml': { ct: 'application/rss+xml', body: RSS_BODY },
      'https://example.com/': {
        ct: 'text/html',
        body: '<html><head><link rel="shortcut icon" href="https://cdn.example.com/ft.ico"></head></html>',
      },
    });

    await pollOne(client, FEED, fetchFn);

    expect(faviconOf(calls)).toBe('https://cdn.example.com/ft.ico');
    expect(requests).toContain('https://example.com/');
  });

  it('does not re-fetch the homepage when a real icon is already stored', async () => {
    const { client, calls } = makeClient();
    const { fetchFn, requests } = routedFetch({
      'https://example.com/feed.xml': { ct: 'application/rss+xml', body: RSS_BODY },
    });

    await pollOne(client, { ...FEED, favicon_url: 'https://cdn.example.com/ft.ico' }, fetchFn);

    expect(faviconOf(calls)).toBe('https://cdn.example.com/ft.ico');
    expect(requests).toEqual(['https://example.com/feed.xml']);
  });

  it('never uses the Jina fallback for a secret-backed feed (guardrail #6)', async () => {
    // An absolute channel <link> can echo the tokenized fetch URL, so a secret
    // feed's homepage must not be forwarded to Jina.
    const { client, calls } = makeClient();
    const jinaTargets: string[] = [];
    const jinaFetch = (t: string) => {
      jinaTargets.push(t);
      return Promise.resolve('<head><link rel="icon" href="/real.png"></head>');
    };
    const { fetchFn } = routedFetch({
      'https://example.com/feed.xml?token=SECRET': { ct: 'application/rss+xml', body: RSS_BODY },
      'https://example.com/': { status: 403 }, // homepage bot-blocked
    });
    const feed = { ...FEED, secret_url: 'https://example.com/feed.xml?token=SECRET' };

    await pollOne(client, feed, fetchFn, jinaFetch);

    // Jina was never called; favicon fell back to the origin-root guess.
    expect(jinaTargets).toEqual([]);
    expect(faviconOf(calls)).toBe('https://example.com/favicon.ico');
  });

  it('absolutizes relative feed links against the public url, never the secret_url (guardrail #7)', async () => {
    // A relative channel/item <link> in a tokenized feed must not resolve
    // under the secret path: that would persist the token into
    // subscriber-visible feeds.site_url / items.url — and diverge from
    // refresh/index.ts (which parses against feed.url), splitting the
    // (feed_id, url) dedup key between the two writers.
    const relativeLinkBody = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Test Feed</title>
  <link>home/</link>
  <item>
    <title>First item</title>
    <link>posts/1</link>
    <guid>g-1</guid>
  </item>
</channel></rss>`;
    const { client, calls } = makeClient();
    const { fetchFn } = routedFetch({
      'https://example.com/secret/TOKEN/feed.xml': {
        ct: 'application/rss+xml',
        body: relativeLinkBody,
      },
    });
    const feed = {
      ...FEED,
      favicon_url: 'https://cdn.example.com/ft.ico',
      secret_url: 'https://example.com/secret/TOKEN/feed.xml',
    };

    await pollOne(client, feed, fetchFn);

    const meta = calls.find(
      (c) => c.kind === 'update' && 'site_url' in c.values,
    ) as { values: Record<string, unknown> } | undefined;
    expect(meta?.values.site_url).toBe('https://example.com/home/');
    const upsert = calls.find((c) => c.kind === 'rpc') as
      | { args: { p_items: Array<{ url: string | null }> } }
      | undefined;
    expect(upsert?.args.p_items[0]?.url).toBe('https://example.com/posts/1');
  });
});

describe('recordFailure', () => {
  // The refresh Edge Function (on-add / pull-to-refresh) now funnels a failed
  // fetch through recordFailure just like the cron poller, so a feed whose only
  // attempt so far was its immediate poll records "Poll failed" + the reason
  // instead of showing "Not tried". These assert the write it performs.
  beforeEach(() => {
    // Deterministic jitter so the backoff interval is exact (0.5 → factor 1.0).
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => vi.restoreAllMocks());

  it('increments error_count and stores last_error, then backs off', async () => {
    const { client, calls } = makeClient();
    const before = Date.now();

    await recordFailure(client, FEED, new Error('HTTP 403'));

    const update = calls.find((c) => c.kind === 'update') as
      | { table: string; values: Record<string, unknown> }
      | undefined;
    expect(update?.table).toBe('feeds');
    expect(update?.values.error_count).toBe(1);
    expect(update?.values.last_error).toBe('HTTP 403');
    // 1800s * 2^1 * 1.0 = 3600s of backoff (well inside the clamp bounds).
    const nextMs = Date.parse(update?.values.next_fetch_at as string) - before;
    expect(nextMs).toBeGreaterThanOrEqual(3600 * 1000 - 1000);
    expect(nextMs).toBeLessThanOrEqual(3600 * 1000 + 2000);
  });

  it('coerces a non-Error reason to a string for last_error', async () => {
    const { client, calls } = makeClient();
    await recordFailure(client, FEED, 'non-feed response (text/html)');
    const update = calls.find((c) => c.kind === 'update') as
      | { values: Record<string, unknown> }
      | undefined;
    expect(update?.values.last_error).toBe('non-feed response (text/html)');
  });

  it('parks the feed at the max interval once the circuit breaker trips', async () => {
    const { client, calls } = makeClient();
    const before = Date.now();

    // One more failure reaches CIRCUIT_BREAKER_FAILS consecutive failures.
    await recordFailure(client, { ...FEED, error_count: CIRCUIT_BREAKER_FAILS - 1 }, new Error('down'));

    const update = calls.find((c) => c.kind === 'update') as
      | { values: Record<string, unknown> }
      | undefined;
    expect(update?.values.error_count).toBe(CIRCUIT_BREAKER_FAILS);
    const nextMs = Date.parse(update?.values.next_fetch_at as string) - before;
    expect(nextMs).toBeGreaterThanOrEqual(MAX_INTERVAL_S * 1000 - 1000);
    expect(nextMs).toBeLessThanOrEqual(MAX_INTERVAL_S * 1000 + 2000);
  });

  it('logs but does not throw when the failure write itself fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client: PollerDbClient = {
      from() {
        return {
          update() {
            return { eq: () => Promise.resolve({ error: { message: 'write blew up' } }) };
          },
        };
      },
      rpc: () => Promise.resolve({ error: null }),
    };

    await expect(recordFailure(client, FEED, new Error('boom'))).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});
