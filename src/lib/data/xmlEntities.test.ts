import { describe, expect, it } from 'vitest';
import { decodeXmlEntities, escapeXml } from './xmlEntities';

describe('escapeXml / decodeXmlEntities', () => {
  it('round-trips URLs with query strings', () => {
    const url = 'https://example.com/feed?a=1&b=<2>&c="q"';
    expect(decodeXmlEntities(escapeXml(url))).toBe(url);
  });

  it('decodes named entities, &amp; last', () => {
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeXmlEntities('&apos;&#39;')).toBe("''");
  });

  it('decodes numeric character references (decimal and hex)', () => {
    // Regression: XML permits numeric references in attribute values and some
    // readers' OPML exporters emit them; undecoded, the import subscribed the
    // literally wrong URL (…a=1&#38;b=2) and the poller fetched a 404 forever.
    expect(decodeXmlEntities('https://example.com/feed?a=1&#38;b=2')).toBe(
      'https://example.com/feed?a=1&b=2',
    );
    expect(decodeXmlEntities('https://example.com/feed?a=1&#x26;b=2')).toBe(
      'https://example.com/feed?a=1&b=2',
    );
    expect(decodeXmlEntities('&#47;path&#x2F;x')).toBe('/path/x');
  });

  it('keeps an escaped ampersand from re-reading as a reference', () => {
    // A literal "&#38;" in the source escapes to "&amp;#38;" and must decode
    // back to the literal, not to "&".
    expect(decodeXmlEntities(escapeXml('a=1&#38;b'))).toBe('a=1&#38;b');
  });

  it('leaves invalid code points as literal text instead of throwing', () => {
    expect(decodeXmlEntities('&#0;')).toBe('&#0;');
    expect(decodeXmlEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeXmlEntities('&#1114112;')).toBe('&#1114112;'); // 0x10FFFF + 1
  });
});
