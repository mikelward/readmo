// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { looksTokenized, looksTokenizedAllowingQuery, redactUrl } from './urlSafety.ts';

describe('looksTokenized — ordinary article URLs pass (false)', () => {
  it.each([
    'https://example.com/news/the-best-laptops-you-can-buy-right-now',
    'https://example.com/2026/06/23/webb-telescope-captures-galaxy',
    'https://example.com/p/123456',
    'https://example.com/article/9f86d081-884c-7d65-9a2f-eaa0c55ad015', // hyphenated UUID
    'https://example.com/blog/container-queries-are-finally-everywhere',
    'https://example.com/pneumonoultramicroscopicsilicovolcanoconiosis', // long real word
    'https://example.com/',
  ])('%s', (url) => {
    expect(looksTokenized(url)).toBe(false);
  });
});

describe('looksTokenized — token-bearing URLs are skipped (true)', () => {
  it.each([
    'https://example.com/read/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', // JWT-ish base64url
    'https://example.com/s/9f86d081884c7d659a2feaa0c55ad015', // 32-char hex blob
    'https://example.com/article/123?token=abc123secret', // query string
    'https://user:pass@example.com/article/1', // credentials
    'https://example.com/a/' + 'A1b2'.repeat(20), // very long mixed run
    'not a url',
  ])('%s', (url) => {
    expect(looksTokenized(url)).toBe(true);
  });

  it('flags a slug whose part is a long hex blob', () => {
    expect(
      looksTokenized('https://example.com/a/9f86d081884c7d659a2feaa0c55ad015-thumb'),
    ).toBe(true);
  });
});

describe('looksTokenizedAllowingQuery — short-integer query values allowed (false)', () => {
  it.each([
    'https://cdn.vox-cdn.com/uploads/icon.png?w=150&h=150&crop=1', // image resize params
    'https://example.com/favicon.png?v=3', // cache-buster
    'https://example.com/icon.png', // no query
    'https://example.com/assets/site-logo.svg?width=64',
    'https://images.example.com/i.png?w=2048&h=1536&q=80&dpr=2', // all numeric
  ])('%s', (url) => {
    expect(looksTokenizedAllowingQuery(url)).toBe(false);
  });
});

describe('looksTokenizedAllowingQuery — non-integer query values rejected (true)', () => {
  it.each([
    'https://cdn.example.com/i.png?token=abc123', // credential key, non-int value
    'https://cdn.example.com/i.png?token=1234', // integer value, but credential key
    'https://cdn.example.com/i.png?subscriber_id=1234', // integer value, per-user key
    'https://cdn.example.com/i.png?uid=42&w=150', // one non-image key
    'https://cdn.example.com/i.png?key=mysecret',
    'https://cdn.example.com/i.png?apikey=x&w=100', // one non-int value
    'https://cdn.example.com/i.png?sessionid=abc123',
    'https://cdn.example.com/i.png?accesskey=abc123',
    'https://cdn.example.com/i.png?fit=crop', // benign-looking string value, still rejected
    'https://cdn.example.com/i.png?v=0123456789abcdef0123456789abcdef', // hex token value
    'https://cdn.example.com/i.png?v=AbCdEfGhIjKlMnOpQrSt123456%2F%2B', // standard-base64 value
    'https://cdn.example.com/i.png?w=150;token=abc123', // embedded ; token (value not integer)
    'https://cdn.example.com/i.png?w=150%3Btoken%3Dabc123', // encoded ; equivalent
    'https://cdn.example.com/i.png?cb=1719600000000', // 13-digit timestamp (too long)
    'https://user:pass@cdn.example.com/i.png', // credentials
    'https://example.com/s/9f86d081884c7d659a2feaa0c55ad015/icon.png', // tokenized path segment
    'https://cdn.example.com/icon.png;jsessionid=abc123?w=150', // matrix-param in path
    'not a url',
  ])('%s', (url) => {
    expect(looksTokenizedAllowingQuery(url)).toBe(true);
  });
});

describe('redactUrl — strips everything that could carry a token', () => {
  it('keeps scheme + host', () => {
    expect(redactUrl('https://example.com/feed.xml')).toBe('https://example.com');
  });
  it('drops the query string (?token=…)', () => {
    expect(redactUrl('https://example.com/feed?token=secret')).toBe('https://example.com');
  });
  it('drops the path even when it embeds a hex token', () => {
    expect(redactUrl('https://example.com/feeds/9f86d081884c7d659a2feaa0c55ad015.xml')).toBe(
      'https://example.com',
    );
  });
  it('drops credentials', () => {
    expect(redactUrl('https://user:pass@example.com/feed.xml')).toBe('https://example.com');
  });
  it('keeps a non-default port (still part of host)', () => {
    expect(redactUrl('https://example.com:8443/feed.xml')).toBe('https://example.com:8443');
  });
  it('returns a placeholder for unparseable input rather than the raw string', () => {
    expect(redactUrl('not a url')).toBe('<unparseable-url>');
    expect(redactUrl('')).toBe('<no-url>');
    expect(redactUrl(null)).toBe('<no-url>');
    expect(redactUrl(undefined)).toBe('<no-url>');
  });
});
