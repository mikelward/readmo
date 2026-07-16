// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PARKED_ERROR_THRESHOLD,
  isPermanentWriteError,
  mapAiCall,
  mapFeed,
  mapItem,
  mapItemState,
  mapSharedItem,
  mapSubscription,
  toRequestError,
  tsToMs,
  type FeedPublicRow,
  type ItemRow,
  type ItemStateRow,
  type SharedItemRow,
  type SubscriptionRow,
} from './supabaseMappers';

describe('toRequestError', () => {
  it('preserves the HTTP status and PostgREST code on the thrown error', () => {
    const err = toRequestError({
      error: { message: 'JWT expired', code: 'PGRST301' },
      status: 401,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('JWT expired');
    expect(err.status).toBe(401);
    expect(err.code).toBe('PGRST301');
  });

  it('omits status/code when absent (a network-shaped error)', () => {
    const err = toRequestError({ error: new Error('Failed to fetch') });
    expect(err.message).toBe('Failed to fetch');
    expect(err.status).toBeUndefined();
    expect(err.code).toBeUndefined();
  });
});

describe('isPermanentWriteError', () => {
  it('treats lost visibility as permanent', () => {
    expect(isPermanentWriteError({ code: '42501' })).toBe(true); // visibility
  });

  it('treats transient/unknown failures as non-permanent (keep queued)', () => {
    // Per-field LWW means a stale write is superseded server-side, not rejected,
    // so there is no version-conflict code (40001) to roll back on.
    expect(isPermanentWriteError({ code: '40001' })).toBe(false); // not a conflict now
    expect(isPermanentWriteError({ code: '53300' })).toBe(false); // too many conns
    expect(isPermanentWriteError({ code: '28000' })).toBe(false); // auth (refresh)
    expect(isPermanentWriteError({ message: '503' })).toBe(false); // no code
    expect(isPermanentWriteError(null)).toBe(false);
  });
});

describe('tsToMs', () => {
  it('parses ISO timestamps and tolerates null/garbage', () => {
    expect(tsToMs('2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(tsToMs(null)).toBeNull();
    expect(tsToMs(undefined)).toBeNull();
    expect(tsToMs('not-a-date')).toBeNull();
  });
});

describe('mapFeed', () => {
  const base: FeedPublicRow = {
    id: 'feed-1',
    site_url: 'https://example.com',
    title: 'Example',
    last_fetched_at: null,
    next_fetch_at: null,
    fetch_interval_s: 1800,
    error_count: 0,
    last_error: null,
    created_at: null,
  };

  it('sources the display url from site_url (never a fetch url)', () => {
    const feed = mapFeed(base);
    expect(feed.url).toBe('https://example.com');
    expect(feed.siteUrl).toBe('https://example.com');
    expect(feed.title).toBe('Example');
    expect(feed.faviconUrl).toBeNull();
    expect(feed.parked).toBe(false);
  });

  it('maps favicon_url when the view provides it', () => {
    expect(
      mapFeed({ ...base, favicon_url: 'https://example.com/favicon.ico' }).faviconUrl,
    ).toBe('https://example.com/favicon.ico');
  });

  it('defaults faviconUrl to null when favicon_url is absent or null', () => {
    // `base` omits favicon_url entirely (a malformed row); a present null maps
    // the same way.
    expect(mapFeed(base).faviconUrl).toBeNull();
    expect(mapFeed({ ...base, favicon_url: null }).faviconUrl).toBeNull();
  });

  it('parks a feed once error_count crosses the threshold', () => {
    expect(mapFeed({ ...base, error_count: PARKED_ERROR_THRESHOLD - 1 }).parked).toBe(false);
    expect(mapFeed({ ...base, error_count: PARKED_ERROR_THRESHOLD }).parked).toBe(true);
  });

  it('falls back to site_url then a placeholder for a missing title', () => {
    expect(mapFeed({ ...base, title: null }).title).toBe('https://example.com');
    expect(mapFeed({ ...base, title: null, site_url: null }).title).toBe('Untitled feed');
  });
});

describe('mapItem', () => {
  const row: ItemRow = {
    id: 'item-1',
    feed_id: 'feed-1',
    guid: 'guid-1',
    url: 'https://example.com/post',
    title: 'A post',
    author: 'Ada',
    published_at: '2026-02-03T04:05:06.000Z',
    content_html: '<p>hi</p>',
    summary: 'sum',
    enclosures: [
      { url: 'https://cdn/x.mp3', type: 'audio/mpeg', length: 1234 },
      { type: 'bad-no-url' },
      'junk',
    ],
    content_hash: 'h',
    created_at: '2026-01-01T00:00:00.000Z',
  };

  it('maps fields, converts published_at to ms, and filters enclosures', () => {
    const item = mapItem(row);
    expect(item.id).toBe('item-1');
    expect(item.feedId).toBe('feed-1');
    expect(item.publishedAt).toBe(Date.parse('2026-02-03T04:05:06.000Z'));
    expect(item.enclosures).toEqual([
      { url: 'https://cdn/x.mp3', type: 'audio/mpeg', length: 1234 },
    ]);
  });

  it('falls back to created_at when published_at is null', () => {
    expect(mapItem({ ...row, published_at: null }).publishedAt).toBe(
      Date.parse('2026-01-01T00:00:00.000Z'),
    );
  });

  it('maps comments_url, defaulting to null when the column is absent', () => {
    expect(
      mapItem({ ...row, comments_url: 'https://news.ycombinator.com/item?id=1' })
        .commentsUrl,
    ).toBe('https://news.ycombinator.com/item?id=1');
    // A malformed row omitting the column defaults to null.
    expect(mapItem(row).commentsUrl).toBeNull();
  });

  it('maps spoiler_free_title, defaulting to null when the column is absent', () => {
    expect(
      mapItem({ ...row, spoiler_free_title: 'EPL MNU v ARS spoiler' }).spoilerFreeTitle,
    ).toBe('EPL MNU v ARS spoiler');
    // A malformed row omitting the column defaults to null.
    expect(mapItem(row).spoilerFreeTitle).toBeNull();
    expect(mapItem({ ...row, spoiler_free_title: null }).spoilerFreeTitle).toBeNull();
  });

  it('maps ai_summary (the allowlisted list-row ride-along), defaulting to null', () => {
    expect(mapItem({ ...row, ai_summary: 'A cached gist.' }).aiSummary).toBe('A cached gist.');
    // Direct ITEM_COLS reads omit it, an off-allowlist caller / an old backend
    // gets it NULLed — all map to null, and the reader falls back to `getSummary`.
    expect(mapItem(row).aiSummary).toBeNull();
    expect(mapItem({ ...row, ai_summary: null }).aiSummary).toBeNull();
  });
});

describe('mapSharedItem', () => {
  const row: SharedItemRow = {
    id: 'item-1',
    feed_id: 'feed-1',
    guid: 'guid-1',
    url: 'https://public.example/post',
    title: 'A shared post',
    author: 'Ada',
    published_at: '2026-02-03T04:05:06.000Z',
    content_html: '<p>body</p>',
    summary: null,
    enclosures: [],
    content_hash: null,
    created_at: '2026-01-01T00:00:00.000Z',
    feed_site_url: 'https://public.example',
    feed_title: 'Public Feed',
    feed_favicon_url: 'https://public.example/icon.png',
    feed_last_fetched_at: null,
    feed_next_fetch_at: null,
    feed_fetch_interval_s: 1800,
    feed_error_count: 0,
    feed_last_error: null,
    feed_created_at: null,
  };

  it('splits the flat RPC row into item + feed and reuses mapItem/mapFeed', () => {
    const fi = mapSharedItem(row);
    expect(fi.item.id).toBe('item-1');
    expect(fi.item.contentHtml).toBe('<p>body</p>');
    // feed_id is the feed's id (no separate feed id column in the flat row).
    expect(fi.feed.id).toBe('feed-1');
    expect(fi.feed.title).toBe('Public Feed');
    expect(fi.feed.faviconUrl).toBe('https://public.example/icon.png');
    // The gated full body/summary are never part of this row's shape.
    expect(fi.item.fullContentHtml).toBeNull();
    expect(fi.item.aiSummary).toBeNull();
  });
});

describe('mapItemState', () => {
  it('maps booleans + timestamps, dropping the key columns', () => {
    const row: ItemStateRow = {
      user_id: 'u1',
      item_id: 'item-1',
      pinned: true,
      pinned_at: '2026-01-01T00:00:00.000Z',
      favorite: false,
      favorite_at: null,
      done: false,
      done_at: null,
      hidden: false,
      hidden_at: null,
      opened: true,
      opened_at: '2026-01-02T00:00:00.000Z',
    };
    const st = mapItemState(row);
    expect(st).toEqual({
      pinned: true,
      pinnedAt: Date.parse('2026-01-01T00:00:00.000Z'),
      favorite: false,
      favoriteAt: null,
      done: false,
      doneAt: null,
      hidden: false,
      hiddenAt: null,
      opened: true,
      openedAt: Date.parse('2026-01-02T00:00:00.000Z'),
    });
  });
});

describe('mapSubscription', () => {
  it('maps snake_case to camelCase', () => {
    const row: SubscriptionRow = {
      feed_id: 'feed-1',
      folder: 'Tech',
      title_override: 'My Title',
      muted: true,
      open_original: true,
      open_newshacker: true,
      mark_done_on_open: true,
      list_layout: 'excerpt',
      sort: 3,
    };
    expect(mapSubscription(row)).toEqual({
      feedId: 'feed-1',
      folder: 'Tech',
      titleOverride: 'My Title',
      muted: true,
      openOriginal: true,
      openNewshacker: true,
      markDoneOnOpen: true,
      listLayout: 'excerpt',
      sort: 3,
    });
  });

  it('defaults openOriginal/openNewshacker/markDoneOnOpen to false and listLayout to null when the columns are absent (pre-migration backend)', () => {
    const row: SubscriptionRow = {
      feed_id: 'feed-1',
      folder: null,
      title_override: null,
      muted: false,
      sort: 0,
    };
    expect(mapSubscription(row).openOriginal).toBe(false);
    expect(mapSubscription(row).openNewshacker).toBe(false);
    expect(mapSubscription(row).markDoneOnOpen).toBe(false);
    expect(mapSubscription(row).listLayout).toBe(null);
  });

  it('coerces an unrecognized list_layout value to null (drops it to the app default)', () => {
    const row: SubscriptionRow = {
      feed_id: 'feed-1',
      folder: null,
      title_override: null,
      muted: false,
      list_layout: 'nonsense',
      sort: 0,
    };
    expect(mapSubscription(row).listLayout).toBe(null);
  });
});

describe('mapAiCall', () => {
  it('maps a full row to the domain shape', () => {
    expect(
      mapAiCall({
        kind: 'spoiler',
        status: 'rewrite',
        http_status: 200,
        item_id: 'item-1',
        item_title: 'Some match',
        error: null,
        created_at: '2026-07-16T02:00:00.000Z',
      }),
    ).toEqual({
      kind: 'spoiler',
      status: 'rewrite',
      httpStatus: 200,
      itemId: 'item-1',
      itemTitle: 'Some match',
      error: null,
      createdAt: '2026-07-16T02:00:00.000Z',
    });
  });

  it('defaults nulls and an unknown kind (summary), and keeps http_status null', () => {
    const call = mapAiCall({
      kind: 'something-new',
      status: 'unavailable',
      http_status: null,
      item_id: null,
      item_title: null,
      error: null,
      created_at: '2026-07-16T01:00:00.000Z',
    });
    // An unrecognized kind falls back to 'summary' so the row still renders.
    expect(call.kind).toBe('summary');
    expect(call.httpStatus).toBeNull();
    expect(call.itemId).toBeNull();
    expect(call.itemTitle).toBeNull();
  });
});
