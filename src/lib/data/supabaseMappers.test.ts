// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FULLTEXT_VERSION } from '../fullText';
import {
  PARKED_ERROR_THRESHOLD,
  isPermanentWriteError,
  mapFeed,
  mapItem,
  mapItemState,
  mapSubscription,
  tsToMs,
  type FeedPublicRow,
  type ItemRow,
  type ItemStateRow,
  type SubscriptionRow,
} from './supabaseMappers';

describe('isPermanentWriteError', () => {
  it('treats version conflict and lost visibility as permanent', () => {
    expect(isPermanentWriteError({ code: '40001' })).toBe(true); // conflict
    expect(isPermanentWriteError({ code: '42501' })).toBe(true); // visibility
  });

  it('treats transient/unknown failures as non-permanent (keep queued)', () => {
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

  it('surfaces a cached full body stamped with the current extractor version', () => {
    const item = mapItem({
      ...row,
      full_content_html: '<p>current full body</p>',
      full_content_version: FULLTEXT_VERSION,
    });
    expect(item.fullContentHtml).toBe('<p>current full body</p>');
    expect(item.fullContentStale).toBe(false);
  });

  it('drops a legacy cached body with no version stamp and flags it stale', () => {
    // The duplicated-header bug: a body cached before versioning (NULL) must not
    // be rendered directly — dropping it routes the reader through re-extraction,
    // and the stale flag makes that happen even on a non-truncated feed.
    const item = mapItem({
      ...row,
      full_content_html: '<p>stale legacy body</p>',
      full_content_version: null,
    });
    expect(item.fullContentHtml).toBeNull();
    expect(item.fullContentStale).toBe(true);
  });

  it('drops a cached body stamped with an older version and flags it stale', () => {
    const item = mapItem({
      ...row,
      full_content_html: '<p>stale body</p>',
      full_content_version: FULLTEXT_VERSION - 1,
    });
    expect(item.fullContentHtml).toBeNull();
    expect(item.fullContentStale).toBe(true);
  });

  it('leaves fullContentHtml null and not-stale when the row omits the body', () => {
    // List/search reads select neither column; both are undefined → null, and
    // there was never a body to re-extract, so it is not flagged stale.
    const item = mapItem(row);
    expect(item.fullContentHtml).toBeNull();
    expect(item.fullContentStale).toBe(false);
  });
});

describe('mapItemState', () => {
  it('maps booleans + timestamps + version, dropping the key columns', () => {
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
      version: 7,
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
      version: 7,
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
      sort: 3,
    };
    expect(mapSubscription(row)).toEqual({
      feedId: 'feed-1',
      folder: 'Tech',
      titleOverride: 'My Title',
      muted: true,
      sort: 3,
    });
  });
});
