// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseFeed, parseFeedBody, absolutizeUrl, toIso, contentHash } from './parser.ts';

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

  it('nulls the summary when a summary-only entry falls back to it as the body', () => {
    // Regression: the dedup compared <summary> against the raw <content>
    // (null here), not the effective body it becomes — storing identical text
    // as both body and summary, rendered twice. Mirrors the RSS 2.0
    // description/encoded suppression.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Summary-only</title>
        <entry>
          <id>urn:x:1</id>
          <title>Teaser entry</title>
          <link rel="alternate" href="https://atom.example.com/entry/9"/>
          <summary type="html">&lt;p&gt;The full teaser text.&lt;/p&gt;</summary>
        </entry>
        <entry>
          <id>urn:x:2</id>
          <title>Both present</title>
          <link rel="alternate" href="https://atom.example.com/entry/10"/>
          <summary type="text">Short form.</summary>
          <content type="html">&lt;p&gt;The whole article.&lt;/p&gt;</content>
        </entry>
      </feed>`;
    const p = parseFeed(xml, 'https://atom.example.com/feed.xml');
    // Summary-only: it becomes the body and must not ALSO stay as the summary.
    expect(p.items[0].contentHtml).toContain('The full teaser text.');
    expect(p.items[0].summary).toBeNull();
    // A distinct summary next to real content is preserved.
    expect(p.items[1].contentHtml).toContain('The whole article.');
    expect(p.items[1].summary).toBe('Short form.');
  });
});

describe('parseFeed — comments / discussion URL', () => {
  it('captures the RSS 2.0 <comments> element (e.g. Hacker News)', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <title>HN</title><link>https://news.ycombinator.com/</link>
      <item>
        <title>A linked story</title>
        <link>https://example.com/the-article</link>
        <comments>https://news.ycombinator.com/item?id=44390000</comments>
      </item>
    </channel></rss>`;
    const it0 = parseFeed(xml, 'https://news.ycombinator.com/rss').items[0];
    // url stays the article; commentsUrl is the discussion thread.
    expect(it0.url).toBe('https://example.com/the-article');
    expect(it0.commentsUrl).toBe('https://news.ycombinator.com/item?id=44390000');
  });

  it('absolutizes a relative <comments> URL', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <title>Blog</title><link>https://blog.example.com/</link>
      <item><title>Post</title><link>https://blog.example.com/p/1</link>
        <comments>/p/1#comments</comments></item>
    </channel></rss>`;
    expect(parseFeed(xml, 'https://blog.example.com/feed').items[0].commentsUrl).toBe(
      'https://blog.example.com/p/1#comments',
    );
  });

  it('is null when an RSS item has no <comments>', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <title>Blog</title><link>https://blog.example.com/</link>
      <item><title>Post</title><link>https://blog.example.com/p/2</link></item>
    </channel></rss>`;
    expect(parseFeed(xml, 'https://blog.example.com/feed').items[0].commentsUrl).toBeNull();
  });

  it('captures the Atom <link rel="replies"> and never the article link', () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom</title><link href="https://atom.example.com/"/>
      <entry>
        <title>Entry</title>
        <id>urn:1</id>
        <link rel="alternate" href="https://atom.example.com/entry/1"/>
        <link rel="replies" href="https://atom.example.com/entry/1/replies"/>
      </entry></feed>`;
    const e0 = parseFeed(xml, 'https://atom.example.com/feed').items[0];
    expect(e0.url).toBe('https://atom.example.com/entry/1');
    expect(e0.commentsUrl).toBe('https://atom.example.com/entry/1/replies');
  });

  it('is null for an Atom entry with only an alternate link (no replies)', () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom</title><link href="https://atom.example.com/"/>
      <entry><title>Entry</title><id>urn:2</id>
        <link rel="alternate" href="https://atom.example.com/entry/2"/></entry></feed>`;
    expect(parseFeed(xml, 'https://atom.example.com/feed').items[0].commentsUrl).toBeNull();
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

describe('parseFeed — favicon', () => {
  it('derives /favicon.ico from the site origin when no icon is advertised', () => {
    // None of the fixtures advertise an icon, so each falls back to the
    // well-known /favicon.ico at the resolved site origin.
    expect(
      parseFeed(fixture('rss2.xml'), 'https://example.com/feed.xml').faviconUrl,
    ).toBe('https://example.com/favicon.ico');
    expect(
      parseFeed(fixture('atom.xml'), 'https://atom.example.com/feed.xml').faviconUrl,
    ).toBe('https://atom.example.com/favicon.ico');
    expect(
      parseFeed(fixture('rdf.xml'), 'https://rdf.example.com/feed.xml').faviconUrl,
    ).toBe('https://rdf.example.com/favicon.ico');
    expect(
      parseFeed(fixture('jsonfeed.json'), 'https://json.example.com/feed.json').faviconUrl,
    ).toBe('https://json.example.com/favicon.ico');
  });

  it('falls back to the FEED origin when there is no site link', () => {
    const raw =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>No link</title>' +
      '<item><title>i</title><guid>g1</guid></item></channel></rss>';
    expect(parseFeed(raw, 'https://feeds.example.org/path/main.xml').faviconUrl).toBe(
      'https://feeds.example.org/favicon.ico',
    );
  });

  it('prefers an RSS <image><url> over the derived favicon', () => {
    const raw =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
      '<link>https://ex.com/</link>' +
      '<image><url>https://cdn.ex.com/logo.png</url></image>' +
      '<item><title>i</title><guid>g1</guid></item></channel></rss>';
    expect(parseFeed(raw, 'https://ex.com/feed.xml').faviconUrl).toBe(
      'https://cdn.ex.com/logo.png',
    );
  });

  it('prefers an RDF <image><url> over the derived favicon', () => {
    const raw =
      '<?xml version="1.0"?><rdf:RDF ' +
      'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ' +
      'xmlns="http://purl.org/rss/1.0/">' +
      '<channel rdf:about="https://rdf.ex.com/"><title>T</title>' +
      '<link>https://rdf.ex.com/</link></channel>' +
      '<image rdf:about="https://rdf.ex.com/logo.png">' +
      '<url>https://rdf.ex.com/logo.png</url></image>' +
      '<item rdf:about="https://rdf.ex.com/a"><title>A</title>' +
      '<link>https://rdf.ex.com/a</link></item></rdf:RDF>';
    expect(parseFeed(raw, 'https://rdf.ex.com/feed.xml').faviconUrl).toBe(
      'https://rdf.ex.com/logo.png',
    );
  });

  it('prefers Atom <icon>, then <logo>, over the derived favicon', () => {
    const withIcon =
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
      '<title>T</title><link rel="alternate" href="https://a.ex.com/"/>' +
      '<icon>https://a.ex.com/icon.png</icon>' +
      '<logo>https://a.ex.com/logo.png</logo></feed>';
    expect(parseFeed(withIcon, 'https://a.ex.com/feed.xml').faviconUrl).toBe(
      'https://a.ex.com/icon.png',
    );
    const logoOnly =
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
      '<title>T</title><link rel="alternate" href="https://a.ex.com/"/>' +
      '<logo>https://a.ex.com/logo.png</logo></feed>';
    expect(parseFeed(logoOnly, 'https://a.ex.com/feed.xml').faviconUrl).toBe(
      'https://a.ex.com/logo.png',
    );
  });

  it('prefers JSON Feed `favicon`, then `icon`, over the derived favicon', () => {
    const base = {
      version: 'https://jsonfeed.org/version/1.1',
      title: 'T',
      home_page_url: 'https://j.ex.com/',
      items: [{ id: '1', url: 'https://j.ex.com/1' }],
    };
    expect(
      parseFeed(
        JSON.stringify({
          ...base,
          favicon: 'https://j.ex.com/fav.png',
          icon: 'https://j.ex.com/icon.png',
        }),
        'https://j.ex.com/feed.json',
      ).faviconUrl,
    ).toBe('https://j.ex.com/fav.png');
    expect(
      parseFeed(
        JSON.stringify({ ...base, icon: 'https://j.ex.com/icon.png' }),
        'https://j.ex.com/feed.json',
      ).faviconUrl,
    ).toBe('https://j.ex.com/icon.png');
  });

  it('absolutizes a relative advertised icon against the site URL', () => {
    const raw =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
      '<link>https://ex.com/blog/</link>' +
      '<image><url>/assets/logo.png</url></image>' +
      '<item><title>i</title><guid>g1</guid></item></channel></rss>';
    expect(parseFeed(raw, 'https://ex.com/feed.xml').faviconUrl).toBe(
      'https://ex.com/assets/logo.png',
    );
  });

  it('rejects a non-http(s) advertised icon and derives /favicon.ico instead', () => {
    const raw =
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
      '<title>T</title><link rel="alternate" href="https://a.ex.com/"/>' +
      '<icon>data:image/png;base64,AAAA</icon></feed>';
    expect(parseFeed(raw, 'https://a.ex.com/feed.xml').faviconUrl).toBe(
      'https://a.ex.com/favicon.ico',
    );
  });

  it('keeps an advertised icon with benign resize query params', () => {
    // Vox / MIT Tech Review etc. advertise CDN icons with ?w=…&h=…&crop=1;
    // those are not secrets and must be kept, not thrown away for the guess.
    const raw =
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
      '<title>T</title><link rel="alternate" href="https://vox.com/"/>' +
      '<icon>https://cdn.vox-cdn.com/uploads/icon.png?w=150&amp;h=150&amp;crop=1</icon></feed>';
    expect(parseFeed(raw, 'https://vox.com/feed.xml').faviconUrl).toBe(
      'https://cdn.vox-cdn.com/uploads/icon.png?w=150&h=150&crop=1',
    );
  });

  it('strips a URL fragment from an advertised icon before storing', () => {
    // A fragment is never sent by an <img>, but would still be exposed via
    // feeds_public and could carry a per-subscriber token.
    const raw =
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
      '<title>T</title><link rel="alternate" href="https://ex.com/"/>' +
      '<icon>https://cdn.ex.com/i.png?w=150#access_token=secret</icon></feed>';
    expect(parseFeed(raw, 'https://ex.com/feed.xml').faviconUrl).toBe(
      'https://cdn.ex.com/i.png?w=150',
    );
  });

  it('rejects an advertised icon with a secret-shaped query value or credentials', () => {
    // A private feed's advertised icon carrying a real token must not be stored
    // or exposed via feeds_public; fall back to the /favicon.ico guess.
    const withQueryToken =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
      '<link>https://ex.com/</link>' +
      '<image><url>https://cdn.ex.com/icon.png?token=0123456789abcdef0123456789abcdef</url></image>' +
      '<item><title>i</title><guid>g1</guid></item></channel></rss>';
    expect(parseFeed(withQueryToken, 'https://ex.com/feed.xml').faviconUrl).toBe(
      'https://ex.com/favicon.ico',
    );
    const withCredentials =
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
      '<title>T</title><link rel="alternate" href="https://a.ex.com/"/>' +
      '<icon>https://user:pass@cdn.ex.com/icon.png</icon></feed>';
    expect(parseFeed(withCredentials, 'https://a.ex.com/feed.xml').faviconUrl).toBe(
      'https://a.ex.com/favicon.ico',
    );
  });

  it('fails closed (no favicon) when the site link is a non-http(s) scheme', () => {
    // A hierarchical non-http <link> (ftp://…) would otherwise derive
    // ftp://…/favicon.ico; favicons are contractually http(s)-only.
    const raw =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
      '<link>ftp://example.com/</link>' +
      '<item><title>i</title><guid>g1</guid></item></channel></rss>';
    expect(parseFeed(raw, 'ftp://example.com/feed.xml').faviconUrl).toBeNull();
  });

  it('fails closed (no favicon) when even the feed origin carries credentials', () => {
    // No advertised icon → derived /favicon.ico, but the base URL's userinfo
    // would ride along; screen it out rather than expose a credentialed URL.
    const raw =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
      '<item><title>i</title><guid>g1</guid></item></channel></rss>';
    expect(parseFeed(raw, 'https://user:pass@feeds.ex.com/main.xml').faviconUrl).toBeNull();
  });
});

describe('entity decoding in plain-text fields', () => {
  // fast-xml-parser only resolves the five predefined XML entities; numeric
  // references and HTML named entities survive into title/author/feedTitle,
  // which the UI renders as escaped plain text. The parser must decode them so
  // the stored value is the actual character — not a literal "&#8217;".
  const rss = (channelExtra: string, itemExtra: string) =>
    parseFeed(
      `<?xml version="1.0"?><rss version="2.0"><channel>${channelExtra}` +
        `<item>${itemExtra}<link>https://ex.com/1</link><guid>g1</guid></item>` +
        `</channel></rss>`,
      'https://ex.com/feed',
    );

  it('decodes a numeric decimal reference (&#8217;) in an item title', () => {
    const { items } = rss('<title>Feed</title>', '<title>Something&#8217;s off</title>');
    expect(items[0].title).toBe('Something’s off');
  });

  it('decodes a numeric hex reference (&#x2019;) in an item title', () => {
    const { items } = rss('<title>Feed</title>', '<title>It&#x2019;s here</title>');
    expect(items[0].title).toBe('It’s here');
  });

  it('decodes HTML named entities (&rsquo;, &nbsp;) the XML parser leaves raw', () => {
    const { items } = rss('<title>Feed</title>', '<title>O&rsquo;Brien&nbsp;wins</title>');
    expect(items[0].title).toBe('O’Brien wins');
  });

  it('decodes a double-encoded entity (&amp;#8217;) down to the character', () => {
    // The publisher HTML-encoded then XML-escaped the ampersand. The XML parser
    // un-escapes the outer &amp; to "&#8217;"; we must finish the job.
    const { items } = rss('<title>Feed</title>', '<title>Don&amp;#8217;t panic</title>');
    expect(items[0].title).toBe('Don’t panic');
  });

  it('decodes entities in the feed title and the author byline', () => {
    const { feedTitle, items } = rss(
      '<title>Tom &amp; Jerry&#8217;s Blog</title>',
      '<title>Post</title><dc:creator>Jos&#xe9; Garc&#237;a</dc:creator>',
    );
    expect(feedTitle).toBe('Tom & Jerry’s Blog');
    expect(items[0].author).toBe('José García');
  });

  it('does NOT entity-decode the HTML body (entities stay meaningful for render)', () => {
    // The body is sanitized and rendered as HTML, where the browser decodes
    // entities. Decoding here would turn escaped code samples into live tags.
    const { items } = rss(
      '<title>Feed</title>',
      '<title>T</title><description>5 &amp;lt; 10 &amp;#8217;</description>',
    );
    expect(items[0].contentHtml).toBe('5 &lt; 10 &#8217;');
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

const MINIMAL_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><item><title>I</title><link>https://ex.com/1</link><guid>g1</guid></item></channel></rss>`;
const HTML_PAGE = `<!DOCTYPE html><html><head><title>Bot check</title></head><body>Checking your browser</body></html>`;

describe('parseFeedBody', () => {
  it('accepts valid RSS with correct content-type', () => {
    const result = parseFeedBody(MINIMAL_RSS, 'https://ex.com/feed', 'application/rss+xml');
    expect(result.feedTitle).toBe('T');
    expect(result.items).toHaveLength(1);
  });

  it('accepts mislabelled-but-valid RSS served as text/html', () => {
    // Publisher misconfiguration: valid RSS body, wrong content-type.
    // Should parse successfully instead of throwing.
    const result = parseFeedBody(MINIMAL_RSS, 'https://ex.com/feed', 'text/html; charset=utf-8');
    expect(result.feedTitle).toBe('T');
    expect(result.items).toHaveLength(1);
  });

  it('rejects bot-challenge HTML page (empty parse + text/html)', () => {
    expect(() =>
      parseFeedBody(HTML_PAGE, 'https://ex.com/feed', 'text/html; charset=utf-8')
    ).toThrow('non-feed response');
  });

  it('throws parse error (not html-specific) for garbage body with non-html content-type', () => {
    expect(() =>
      parseFeedBody('not xml or json at all$$$$', 'https://ex.com/feed', 'application/xml')
    ).toThrow();
  });
});
