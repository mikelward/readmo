// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  PUBLISHERS,
  MAX_SECTIONS,
  publisherForUrl,
  looksLikeFeedUrl,
} from './feedSections';

describe('feedSections — data integrity', () => {
  it('keeps every publisher to at most MAX_SECTIONS sections, main feed first', () => {
    for (const p of PUBLISHERS) {
      expect(p.sections.length).toBeGreaterThan(1);
      expect(p.sections.length).toBeLessThanOrEqual(MAX_SECTIONS);
      // Main feed first: the first section's feed must be one of the
      // publisher's general/front feeds, never empty.
      expect(p.sections[0].name).toBeTruthy();
      expect(p.sections[0].feedUrl).toMatch(/^https:\/\//);
    }
  });

  it('has no duplicate feed URLs within a publisher', () => {
    for (const p of PUBLISHERS) {
      const urls = p.sections.map((s) => s.feedUrl);
      expect(new Set(urls).size).toBe(urls.length);
    }
  });

  it('serves every section feed from one of the publisher feed hosts', () => {
    for (const p of PUBLISHERS) {
      const allowed = [...p.siteHosts, ...p.feedHosts];
      for (const s of p.sections) {
        const host = new URL(s.feedUrl).hostname.replace(/^www\./, '');
        expect(
          allowed.some((h) => host === h || host.endsWith(`.${h}`)),
          `${s.feedUrl} should be served from one of ${allowed.join(', ')}`,
        ).toBe(true);
      }
    }
  });
});

describe('publisherForUrl', () => {
  it('maps a bare site host to its publisher', () => {
    expect(publisherForUrl('bbc.com')?.name).toBe('BBC');
    expect(publisherForUrl('bbc.co.uk')?.name).toBe('BBC');
    expect(publisherForUrl('https://www.bbc.co.uk/news/uk-123')?.name).toBe('BBC');
  });

  it('maps a curated feed URL on a separate feed host to its publisher', () => {
    // A dropdown pick of "BBC News" submits feeds.bbci.co.uk/... — a different
    // host than the site, reachable only via feedHosts.
    expect(publisherForUrl('https://feeds.bbci.co.uk/news/rss.xml')?.name).toBe('BBC');
    expect(publisherForUrl('https://feeds.npr.org/1001/rss.xml')?.name).toBe('NPR');
  });

  it('does NOT match a feed host when sitesOnly is set (raw paste of a feed URL)', () => {
    // A user pasting the feed URL directly "meant that feed" — it must not
    // expand to the whole publisher's section picker.
    expect(
      publisherForUrl('https://feeds.bbci.co.uk/news/world/rss.xml', { sitesOnly: true }),
    ).toBeNull();
    // The site host still matches under sitesOnly.
    expect(publisherForUrl('bbc.com', { sitesOnly: true })?.name).toBe('BBC');
  });

  it('returns null for unknown sites and unparseable input', () => {
    expect(publisherForUrl('example.com')).toBeNull();
    expect(publisherForUrl('notbbc.com')).toBeNull();
    expect(publisherForUrl('')).toBeNull();
  });
});

describe('looksLikeFeedUrl', () => {
  it('treats feed-shaped URLs as feeds', () => {
    expect(looksLikeFeedUrl('https://www.theguardian.com/world/rss')).toBe(true);
    expect(looksLikeFeedUrl('https://feeds.bbci.co.uk/news/rss.xml')).toBe(true);
    expect(looksLikeFeedUrl('https://example.com/feed')).toBe(true);
    expect(looksLikeFeedUrl('https://example.com/atom.xml')).toBe(true);
    expect(looksLikeFeedUrl('https://example.com/feed.json')).toBe(true);
  });

  it('treats slug-form feed URLs as feeds (e.g. CBC /cmlink/rss-*)', () => {
    expect(looksLikeFeedUrl('https://www.cbc.ca/cmlink/rss-topstories')).toBe(true);
    expect(looksLikeFeedUrl('https://www.cbc.ca/cmlink/rss-sports')).toBe(true);
  });

  it('recognizes every curated section feed URL as feed-shaped (paste = that feed)', () => {
    // A pasted curated feed URL must subscribe directly rather than expand to
    // its publisher's section picker — for publishers whose feeds share the
    // site host (Guardian, CBC), the feed-shape check is the only signal.
    for (const p of PUBLISHERS) {
      for (const s of p.sections) {
        expect(looksLikeFeedUrl(s.feedUrl), s.feedUrl).toBe(true);
      }
    }
  });

  it('treats site pages as not-a-feed', () => {
    expect(looksLikeFeedUrl('bbc.com')).toBe(false);
    expect(looksLikeFeedUrl('https://www.theguardian.com')).toBe(false);
    expect(looksLikeFeedUrl('https://www.bbc.co.uk/news/10628494')).toBe(false);
    // "feed" + "back" — a word that merely starts with a feed word is not a feed.
    expect(looksLikeFeedUrl('https://example.com/feedback')).toBe(false);
  });

  it('combines with publisherForUrl so a same-host feed paste subscribes directly', () => {
    // Guardian feeds live on theguardian.com itself, so host matching alone
    // can't tell a section feed from the site. The feed-shape guard does.
    const url = 'https://www.theguardian.com/world/rss';
    expect(publisherForUrl(url, { sitesOnly: true })?.name).toBe('The Guardian');
    expect(looksLikeFeedUrl(url)).toBe(true); // → add flow skips expansion
  });
});
