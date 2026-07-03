// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollOne, resolveStoredFavicon } from './poller.ts';
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
});
