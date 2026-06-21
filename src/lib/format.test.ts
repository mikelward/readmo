// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  extractDomain,
  formatDisplayDomain,
  formatItemMeta,
  formatTimeAgo,
  isSafeHttpUrl,
  pluralize,
} from './format';

describe('extractDomain', () => {
  it('returns hostname without www', () => {
    expect(extractDomain('https://www.example.com/path')).toBe('example.com');
  });

  it('handles subdomains', () => {
    expect(extractDomain('https://blog.example.com/foo')).toBe('blog.example.com');
  });

  it('returns empty string for missing or invalid url', () => {
    expect(extractDomain(undefined)).toBe('');
    expect(extractDomain('not a url')).toBe('');
  });
});

describe('isSafeHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isSafeHttpUrl('http://example.com/x')).toBe(true);
    expect(isSafeHttpUrl('https://example.com/x')).toBe(true);
  });

  it('rejects javascript: and data: schemes', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(
      false,
    );
    expect(isSafeHttpUrl('vbscript:msgbox(1)')).toBe(false);
  });

  it('rejects missing, relative, or malformed urls', () => {
    expect(isSafeHttpUrl(undefined)).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl('/relative/path')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });
});

describe('formatDisplayDomain', () => {
  it('returns empty string for missing or invalid url', () => {
    expect(formatDisplayDomain(undefined)).toBe('');
    expect(formatDisplayDomain('not a url')).toBe('');
  });

  it('strips leading www.', () => {
    expect(formatDisplayDomain('https://www.example.com/path')).toBe(
      'example.com',
    );
  });

  it('always trims leading subdomains to the registrable domain', () => {
    expect(formatDisplayDomain('https://blog.example.com/x')).toBe(
      'example.com',
    );
    expect(formatDisplayDomain('https://sport.bbc.co.uk/x')).toBe('bbc.co.uk');
  });

  it('trims old.reddit.com down to reddit.com', () => {
    expect(formatDisplayDomain('https://old.reddit.com/r/x')).toBe(
      'reddit.com',
    );
  });

  it('drops leading subdomains on long hostnames', () => {
    expect(formatDisplayDomain('https://fingfx.thomsonreuters.com/foo')).toBe(
      'thomsonreuters.com',
    );
  });

  it('preserves nested ccTLDs when trimming subdomains', () => {
    expect(formatDisplayDomain('https://news.entertainment.9news.com.au/x')).toBe(
      '9news.com.au',
    );
    expect(formatDisplayDomain('https://a.b.asahi.co.jp/x')).toBe('asahi.co.jp');
  });

  it('does not trim a nested-ccTLD hostname that is already minimal', () => {
    expect(formatDisplayDomain('https://9news.com.au/story')).toBe(
      '9news.com.au',
    );
  });

  it('preserves user subdomains on compound effective TLDs like github.io', () => {
    expect(formatDisplayDomain('https://jasoneckert.github.io/project')).toBe(
      'jasoneckert.github.io',
    );
  });

  it('ellipsizes when the registrable domain is itself too long', () => {
    const long = 'https://some-really-long-publishing-company.com/x';
    const out = formatDisplayDomain(long, 22);
    expect(out.length).toBeLessThanOrEqual(22);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('some-really-long-publ')).toBe(true);
  });

  it('ellipsizes the registrable domain itself when it exceeds maxLength', () => {
    expect(formatDisplayDomain('https://blog.example.com/x', 5)).toBe('exam…');
  });
});

describe('formatTimeAgo', () => {
  const now = new Date('2026-04-18T12:00:00Z');
  const nowS = Math.floor(now.getTime() / 1000);

  it('returns "just now" for < 1 minute', () => {
    expect(formatTimeAgo(nowS - 30, now)).toBe('just now');
  });

  it('returns minutes for < 1 hour', () => {
    expect(formatTimeAgo(nowS - 60 * 5, now)).toBe('5m');
  });

  it('returns hours for < 1 day', () => {
    expect(formatTimeAgo(nowS - 60 * 60 * 3, now)).toBe('3h');
  });

  it('returns days for < ~1 month', () => {
    expect(formatTimeAgo(nowS - 60 * 60 * 24 * 4, now)).toBe('4d');
  });

  it('returns months', () => {
    expect(formatTimeAgo(nowS - 60 * 60 * 24 * 60, now)).toBe('2mo');
  });

  it('returns years', () => {
    expect(formatTimeAgo(nowS - 60 * 60 * 24 * 400, now)).toBe('1y');
  });

  it('rolls 360–365 days over to "1y" instead of "12mo"', () => {
    expect(formatTimeAgo(nowS - 60 * 60 * 24 * 362, now)).toBe('1y');
    expect(formatTimeAgo(nowS - 60 * 60 * 24 * 359, now)).toBe('11mo');
  });

  it('clamps future times to "just now"', () => {
    expect(formatTimeAgo(nowS + 60, now)).toBe('just now');
  });
});

describe('pluralize', () => {
  it('returns singular for 1', () => {
    expect(pluralize(1, 'item')).toBe('item');
  });
  it('returns plural form otherwise', () => {
    expect(pluralize(0, 'item')).toBe('items');
    expect(pluralize(2, 'item')).toBe('items');
  });
});

describe('formatItemMeta', () => {
  const now = new Date('2026-04-18T12:00:00Z');
  const nowMs = now.getTime();

  it('joins source, age, and author with " · "', () => {
    expect(
      formatItemMeta(
        {
          source: 'The Verge',
          publishedAt: nowMs - 60 * 60 * 3 * 1000,
          author: 'Jane Doe',
        },
        now,
      ),
    ).toBe('The Verge · 3h · Jane Doe');
  });

  it('omits the author segment when missing or blank', () => {
    expect(
      formatItemMeta(
        { source: 'The Verge', publishedAt: nowMs - 60 * 60 * 1000 },
        now,
      ),
    ).toBe('The Verge · 1h');
    expect(
      formatItemMeta(
        { source: 'The Verge', publishedAt: nowMs - 60 * 60 * 1000, author: '  ' },
        now,
      ),
    ).toBe('The Verge · 1h');
  });

  it('omits the source segment when missing', () => {
    expect(
      formatItemMeta({ publishedAt: nowMs - 60 * 60 * 1000 }, now),
    ).toBe('1h');
  });

  it('omits the age segment when publishedAt is missing', () => {
    expect(formatItemMeta({ source: 'The Verge', author: 'Jane' }, now)).toBe(
      'The Verge · Jane',
    );
  });

  it('returns an empty string when nothing is present', () => {
    expect(formatItemMeta({}, now)).toBe('');
  });
});
