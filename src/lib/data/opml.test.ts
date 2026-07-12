import { describe, expect, it } from 'vitest';
import { buildOpml } from './opml';

describe('buildOpml', () => {
  it('serializes outlines with xmlUrl (fetch URL) and htmlUrl (homepage)', () => {
    const xml = buildOpml([
      { title: 'Alpha', xmlUrl: 'https://a.example.com/feed.xml', htmlUrl: 'https://a.example.com' },
    ]);
    expect(xml).toContain('<opml version="2.0">');
    expect(xml).toContain('xmlUrl="https://a.example.com/feed.xml"');
    expect(xml).toContain('htmlUrl="https://a.example.com"');
    expect(xml).toContain('text="Alpha"');
    expect(xml).toContain('title="Alpha"');
  });

  it('omits htmlUrl when the homepage is absent', () => {
    const xml = buildOpml([{ title: 'No home', xmlUrl: 'https://x/feed', htmlUrl: null }]);
    expect(xml).toContain('xmlUrl="https://x/feed"');
    expect(xml).not.toContain('htmlUrl=');
  });

  it('XML-escapes titles and URLs so a & round-trips instead of breaking the doc', () => {
    const xml = buildOpml([{ title: 'A & B', xmlUrl: 'https://x/feed?a=1&b=2' }]);
    expect(xml).toContain('text="A &amp; B"');
    expect(xml).toContain('xmlUrl="https://x/feed?a=1&amp;b=2"');
    expect(xml).not.toContain('&b=2'); // the raw ampersand must not survive
  });

  it('stamps the head with an RFC-822 dateCreated when given a date, and omits it otherwise', () => {
    const stamped = buildOpml([{ title: 'A', xmlUrl: 'https://x/feed' }], {
      dateCreated: new Date('2026-07-12T00:00:00.000Z'),
    });
    expect(stamped).toContain('<dateCreated>Sun, 12 Jul 2026 00:00:00 GMT</dateCreated>');

    const bare = buildOpml([{ title: 'A', xmlUrl: 'https://x/feed' }]);
    expect(bare).not.toContain('dateCreated');
  });

  it('produces a well-formed empty document for no subscriptions', () => {
    const xml = buildOpml([]);
    expect(xml).toContain('<body>\n\n  </body>');
  });
});
