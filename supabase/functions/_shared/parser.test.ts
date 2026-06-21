// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseFeed, absolutizeUrl, toIso, contentHash } from './parser.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(here, 'fixtures', name), 'utf-8');

describe('parseFeed — RSS 2.0', () => {
  const parsed = parseFeed(fixture('rss2.xml'), 'https://example.com/feed.xml');

  it('reads the feed title and site URL', () => {
    expect(parsed.feedTitle).toBe('Example RSS 2.0 Feed');
    expect(parsed.siteUrl).toBe('https://example.com/');
  });

  it('normalizes the first item', () => {
    const it0 = parsed.items[0];
    expect(it0.guid).toBe('tag:example.com,2024:first');
    expect(it0.url).toBe('https://example.com/posts/first');
    expect(it0.title).toBe('First Post');
    expect(it0.author).toBe('Jane Doe');
    expect(it0.publishedAt).toBe('2024-10-02T13:00:00.000Z');
    // content:encoded wins over description for the body.
    expect(it0.contentHtml).toContain('Full body');
    expect(it0.summary).toBe('A short summary.');
  });

  it('captures enclosures', () => {
    expect(parsed.items[0].enclosures).toEqual([
      {
        url: 'https://cdn.example.com/audio/first.mp3',
        type: 'audio/mpeg',
        length: 12345,
      },
    ]);
  });

  it('falls back to description when no content:encoded', () => {
    const it1 = parsed.items[1];
    expect(it1.contentHtml).toBe('Just a description, no content:encoded.');
    // summary equals body → suppressed to avoid duplicate render.
    expect(it1.summary).toBeNull();
  });
});

describe('parseFeed — Atom', () => {
  const parsed = parseFeed(fixture('atom.xml'), 'https://atom.example.com/feed.xml');

  it('reads title and alternate site link', () => {
    expect(parsed.feedTitle).toBe('Example Atom Feed');
    expect(parsed.siteUrl).toBe('https://atom.example.com/');
  });

  it('normalizes entry, author, dates and content', () => {
    const e0 = parsed.items[0];
    expect(e0.guid).toBe('urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a');
    expect(e0.url).toBe('https://atom.example.com/entry/1');
    expect(e0.author).toBe('Sam Reader');
    expect(e0.publishedAt).toBe('2024-10-02T13:00:00.000Z');
    expect(e0.contentHtml).toContain('Hello');
  });

  it('reads enclosure links', () => {
    expect(parsed.items[1].enclosures).toEqual([
      {
        url: 'https://atom.example.com/img/2.png',
        type: 'image/png',
        length: 2048,
      },
    ]);
  });
});

describe('parseFeed — RSS 1.0 / RDF', () => {
  const parsed = parseFeed(fixture('rdf.xml'), 'https://rdf.example.com/feed');

  it('reads channel title and items', () => {
    expect(parsed.feedTitle).toBe('Example RSS 1.0 / RDF Feed');
    expect(parsed.items).toHaveLength(2);
  });

  it('normalizes an RDF item', () => {
    const a = parsed.items[0];
    expect(a.guid).toBe('https://rdf.example.com/item/a');
    expect(a.url).toBe('https://rdf.example.com/item/a');
    expect(a.author).toBe('RDF Author');
    expect(a.publishedAt).toBe('2024-10-01T10:00:00.000Z');
    expect(a.contentHtml).toContain('RDF full');
  });
});

describe('parseFeed — JSON Feed', () => {
  const parsed = parseFeed(fixture('jsonfeed.json'), 'https://json.example.com/feed.json');

  it('reads title and home page', () => {
    expect(parsed.feedTitle).toBe('Example JSON Feed');
    expect(parsed.siteUrl).toBe('https://json.example.com/');
  });

  it('normalizes html and text items', () => {
    expect(parsed.items[0].guid).toBe('json-1');
    expect(parsed.items[0].author).toBe('JSON Author');
    expect(parsed.items[0].contentHtml).toContain('JSON body');
    expect(parsed.items[1].contentHtml).toBe('Plain text content.');
  });

  it('reads attachments', () => {
    expect(parsed.items[0].enclosures).toEqual([
      {
        url: 'https://json.example.com/media/1.mp3',
        type: 'audio/mpeg',
        length: 9000,
      },
    ]);
  });
});

describe('parseFeed — malformed input', () => {
  it('throws on an unrecognized XML root', () => {
    expect(() => parseFeed('<html><body>not a feed</body></html>', 'https://x/'))
      .toThrow(/Unrecognized feed/);
  });

  it('throws on empty input', () => {
    expect(() => parseFeed('   ', 'https://x/')).toThrow(/Empty feed/);
  });

  it('throws on JSON-looking but invalid body', () => {
    expect(() => parseFeed('{ not json', 'https://x/')).toThrow(/JSON/);
  });
});

describe('parseFeed — missing GUID fallbacks', () => {
  const parsed = parseFeed(fixture('no-guid.xml'), 'https://noguid.example.com/feed');

  it('falls back to the item URL when no guid', () => {
    expect(parsed.items[0].guid).toBe('https://noguid.example.com/posts/has-link');
  });

  it('falls back to a content hash when neither guid nor url', () => {
    const g = parsed.items[1].guid;
    // Shape: "<feedUrl>#<8-hex-hash>".
    expect(g).toMatch(/^https:\/\/noguid\.example\.com\/feed#[0-9a-f]{8}$/);
  });
});

describe('parseFeed — relative-URL absolutization', () => {
  it('absolutizes a relative <link> against the feed URL', () => {
    const raw = `<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <title>Rel</title><link>/home</link>
        <item><title>Rel item</title><link>/posts/rel</link>
          <guid>g1</guid></item>
      </channel></rss>`;
    const parsed = parseFeed(raw, 'https://rel.example.com/feeds/main.xml');
    expect(parsed.siteUrl).toBe('https://rel.example.com/home');
    expect(parsed.items[0].url).toBe('https://rel.example.com/posts/rel');
  });
});

describe('helpers', () => {
  it('absolutizeUrl resolves relative against base and passes absolute through', () => {
    expect(absolutizeUrl('/a', 'https://h.com/x/y')).toBe('https://h.com/a');
    expect(absolutizeUrl('https://other.com/z', 'https://h.com/')).toBe(
      'https://other.com/z',
    );
    expect(absolutizeUrl('', 'https://h.com/')).toBeNull();
    expect(absolutizeUrl(null, 'https://h.com/')).toBeNull();
  });

  it('toIso parses RFC822 and RFC3339, null otherwise', () => {
    expect(toIso('Wed, 02 Oct 2024 13:00:00 GMT')).toBe('2024-10-02T13:00:00.000Z');
    expect(toIso('2024-10-02T13:00:00Z')).toBe('2024-10-02T13:00:00.000Z');
    expect(toIso('not a date')).toBeNull();
    expect(toIso(null)).toBeNull();
  });

  it('contentHash is deterministic and stable', () => {
    expect(contentHash('a', 'b')).toBe(contentHash('a', 'b'));
    expect(contentHash('a', 'b')).not.toBe(contentHash('a', 'c'));
    expect(contentHash('a')).toMatch(/^[0-9a-f]{8}$/);
  });
});
