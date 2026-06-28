// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { POPULAR_FEEDS } from './popularFeeds';

describe('POPULAR_FEEDS', () => {
  it('has unique display names', () => {
    const names = POPULAR_FEEDS.map((f) => f.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it('has unique feed URLs', () => {
    const urls = POPULAR_FEEDS.map((f) => f.feedUrl);
    const dupes = urls.filter((u, i) => urls.indexOf(u) !== i);
    expect(dupes).toEqual([]);
  });

  it('every entry is a well-formed https URL with a name and category', () => {
    for (const feed of POPULAR_FEEDS) {
      expect(feed.name.trim()).not.toBe('');
      expect(feed.category.trim()).not.toBe('');
      const url = new URL(feed.feedUrl);
      expect(url.protocol).toBe('https:');
    }
  });

  // The poller fetches these URLs server-side; an accidental space or stray
  // character in a hand-edited entry would 404 silently in production.
  it('has no whitespace inside any feed URL', () => {
    for (const feed of POPULAR_FEEDS) {
      expect(feed.feedUrl).not.toMatch(/\s/);
    }
  });

  it('includes the curated Australian outlets', () => {
    const byName = new Map(POPULAR_FEEDS.map((f) => [f.name, f.feedUrl]));
    expect(byName.get('ABC News (Australia)')).toBe(
      'https://www.abc.net.au/news/feed/45910/rss.xml',
    );
    expect(byName.get('SBS News')).toBe('https://www.sbs.com.au/news/feed');
  });

  it('contains no Google News feeds (a curated pick bypasses the discover gate)', () => {
    // Curated suggestions are submitted straight to subscribe(), skipping the
    // discover Edge Function — so they bypass its Google News allowlist gate.
    // Keeping news.google.com out of the catalog keeps that gate effective.
    for (const feed of POPULAR_FEEDS) {
      expect(new URL(feed.feedUrl).hostname.replace(/^www\./, '')).not.toBe(
        'news.google.com',
      );
    }
  });
});
