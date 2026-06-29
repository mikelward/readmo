// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  pickIconFromHtml,
  resolveFeedFavicon,
  faviconLookupDue,
  siteOriginChanged,
  FAVICON_RECHECK_MS,
} from './siteIcon.ts';

describe('pickIconFromHtml', () => {
  const base = 'https://example.com/';

  it('finds a standard <link rel="icon"> and absolutizes it', () => {
    const html = '<head><link rel="icon" href="/assets/favicon.svg"></head>';
    expect(pickIconFromHtml(html, base)).toBe('https://example.com/assets/favicon.svg');
  });

  it('handles rel="shortcut icon" (multi-token rel)', () => {
    const html = '<link rel="shortcut icon" href="https://cdn.example.com/fav.png">';
    expect(pickIconFromHtml(html, base)).toBe('https://cdn.example.com/fav.png');
  });

  it('prefers a standard icon over apple-touch-icon', () => {
    const html =
      '<link rel="apple-touch-icon" href="/touch.png">' +
      '<link rel="icon" href="/icon.png">';
    expect(pickIconFromHtml(html, base)).toBe('https://example.com/icon.png');
  });

  it('falls back to apple-touch-icon, then mask-icon, when no standard icon', () => {
    expect(
      pickIconFromHtml('<link rel="apple-touch-icon" href="/touch.png">', base),
    ).toBe('https://example.com/touch.png');
    expect(
      pickIconFromHtml('<link rel="mask-icon" href="/mask.svg" color="#000">', base),
    ).toBe('https://example.com/mask.svg');
  });

  it('returns null when the page declares no icon link', () => {
    expect(pickIconFromHtml('<head><title>No icon</title></head>', base)).toBeNull();
  });

  it('rejects a tokenized icon href (screened like any favicon)', () => {
    const html = '<link rel="icon" href="https://cdn.example.com/i.png?token=secret123">';
    expect(pickIconFromHtml(html, base)).toBeNull();
  });

  it('rejects a non-http(s) icon href', () => {
    expect(
      pickIconFromHtml('<link rel="icon" href="data:image/png;base64,AAAA">', base),
    ).toBeNull();
  });

  it('skips a rejected icon and keeps scanning for a valid one in the same tier', () => {
    // First standard icon is a data: URL (rejected); a later one is valid.
    const html =
      '<link rel="icon" href="data:image/png;base64,AAAA">' +
      '<link rel="icon" href="/real.svg">';
    expect(pickIconFromHtml(html, base)).toBe('https://example.com/real.svg');
  });

  it('falls back to a valid apple-touch icon when the only standard icon is rejected', () => {
    const html =
      '<link rel="icon" href="https://cdn.example.com/i.png?token=secret123">' +
      '<link rel="apple-touch-icon" href="/touch.png">';
    expect(pickIconFromHtml(html, base)).toBe('https://example.com/touch.png');
  });
});

describe('resolveFeedFavicon', () => {
  const NOW = 1_700_000_000_000;
  const derived = { faviconUrl: 'https://x.com/favicon.ico', faviconFromFeed: false, siteUrl: 'https://x.com' };
  const fail = () => {
    throw new Error('fetchIcon should not be called');
  };

  it('uses the feed-advertised icon without any HTML fetch', async () => {
    const out = await resolveFeedFavicon(
      { faviconUrl: 'https://x.com/feed-icon.png', faviconFromFeed: true, siteUrl: 'https://x.com' },
      null,
      null,
      NOW,
      true,
      fail,
    );
    expect(out).toEqual({ url: 'https://x.com/feed-icon.png', stampCheckedAt: false });
  });

  it('keeps a previously-discovered icon without re-fetching', async () => {
    const out = await resolveFeedFavicon(derived, 'https://cdn.x.com/cached.svg', null, NOW, true, fail);
    expect(out).toEqual({ url: 'https://cdn.x.com/cached.svg', stampCheckedAt: false });
  });

  it('preserves a discovered icon named /assets/favicon.ico (value, not suffix)', async () => {
    // Regression: an HTML icon ending in /favicon.ico must not be mistaken for
    // the derived root guess and overwritten.
    const out = await resolveFeedFavicon(
      derived,
      'https://x.com/assets/favicon.ico',
      new Date(NOW).toISOString(),
      NOW,
      true,
      fail,
    );
    expect(out).toEqual({ url: 'https://x.com/assets/favicon.ico', stampCheckedAt: false });
  });

  it('looks the icon up in the site HTML when none is advertised or cached', async () => {
    const out = await resolveFeedFavicon(derived, null, null, NOW, true, async () => 'https://cdn.x.com/from-html.svg');
    expect(out).toEqual({ url: 'https://cdn.x.com/from-html.svg', stampCheckedAt: true });
  });

  it('re-checks HTML when the cache is only the derived /favicon.ico', async () => {
    const out = await resolveFeedFavicon(
      derived,
      'https://x.com/favicon.ico',
      null,
      NOW,
      true,
      async () => 'https://cdn.x.com/from-html.svg',
    );
    expect(out).toEqual({ url: 'https://cdn.x.com/from-html.svg', stampCheckedAt: true });
  });

  it('falls back to the /favicon.ico guess (and stamps) when HTML yields no icon', async () => {
    const out = await resolveFeedFavicon(derived, null, null, NOW, true, async () => null);
    expect(out).toEqual({ url: 'https://x.com/favicon.ico', stampCheckedAt: true });
  });

  it('does NOT fetch or stamp when the lookup is disallowed (budget exhausted)', async () => {
    const out = await resolveFeedFavicon(derived, null, null, NOW, false, fail);
    expect(out).toEqual({ url: 'https://x.com/favicon.ico', stampCheckedAt: false });
  });

  it('skips the HTML fetch when checked within the recheck window (negative cache)', async () => {
    const checkedAt = new Date(NOW - 1000).toISOString(); // 1s ago
    const out = await resolveFeedFavicon(derived, 'https://x.com/favicon.ico', checkedAt, NOW, true, fail);
    expect(out).toEqual({ url: 'https://x.com/favicon.ico', stampCheckedAt: false });
  });

  it('re-checks once the recheck window has lapsed', async () => {
    const checkedAt = new Date(NOW - FAVICON_RECHECK_MS - 1).toISOString();
    const out = await resolveFeedFavicon(
      derived,
      'https://x.com/favicon.ico',
      checkedAt,
      NOW,
      true,
      async () => 'https://cdn.x.com/now-has-one.svg',
    );
    expect(out).toEqual({ url: 'https://cdn.x.com/now-has-one.svg', stampCheckedAt: true });
  });

  it('treats an unparseable checked-at stamp as due', async () => {
    const out = await resolveFeedFavicon(derived, null, 'not-a-date', NOW, true, async () => 'https://cdn.x.com/h.svg');
    expect(out).toEqual({ url: 'https://cdn.x.com/h.svg', stampCheckedAt: true });
  });

  it('skips the HTML fetch when there is no site URL', async () => {
    const out = await resolveFeedFavicon(
      { faviconUrl: null, faviconFromFeed: false, siteUrl: null },
      null,
      null,
      NOW,
      true,
      fail,
    );
    expect(out).toEqual({ url: null, stampCheckedAt: false });
  });
});

describe('faviconLookupDue', () => {
  const NOW = 1_700_000_000_000;
  const site = 'https://x.com';

  it('is false when there is no site URL (nothing to look up)', () => {
    expect(faviconLookupDue(null, null, null, NOW)).toBe(false);
  });

  it('is false when a real (non-derived) icon is already stored', () => {
    // Even with a never-checked stamp: we already have an icon.
    expect(faviconLookupDue('https://cdn.x.com/icon.svg', null, site, NOW)).toBe(false);
  });

  it('is true when never checked and only the derived guess (or nothing) is stored', () => {
    expect(faviconLookupDue('https://x.com/favicon.ico', null, site, NOW)).toBe(true);
    expect(faviconLookupDue(null, null, site, NOW)).toBe(true);
  });

  it('is false within the recheck window, true once it lapses', () => {
    const recent = new Date(NOW - 1000).toISOString();
    const stale = new Date(NOW - FAVICON_RECHECK_MS - 1).toISOString();
    expect(faviconLookupDue('https://x.com/favicon.ico', recent, site, NOW)).toBe(false);
    expect(faviconLookupDue('https://x.com/favicon.ico', stale, site, NOW)).toBe(true);
  });
});

describe('siteOriginChanged', () => {
  it('is true when the origin differs', () => {
    expect(siteOriginChanged('https://a.com/blog', 'https://b.com/')).toBe(true);
    expect(siteOriginChanged('https://a.com', 'https://www.a.com')).toBe(true); // host differs
    expect(siteOriginChanged('http://a.com', 'https://a.com')).toBe(true); // scheme differs
  });

  it('is false for the same origin (path/query differences ignored)', () => {
    expect(siteOriginChanged('https://a.com/blog', 'https://a.com/news?x=1')).toBe(false);
  });

  it('is false when either side is missing or unparseable (no needless invalidation)', () => {
    expect(siteOriginChanged(null, 'https://a.com')).toBe(false);
    expect(siteOriginChanged('https://a.com', null)).toBe(false);
    expect(siteOriginChanged('not a url', 'https://a.com')).toBe(false);
  });
});
