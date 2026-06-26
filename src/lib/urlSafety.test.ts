import { describe, expect, it } from 'vitest';
import { looksTokenized } from './urlSafety';

describe('looksTokenized', () => {
  it('lets ordinary article URLs through', () => {
    for (const url of [
      'https://example.com/2026/06/26/some-readable-slug',
      'https://example.com/article/12345',
      'https://blog.example.com/posts/why-rss-still-matters',
      // Hyphenated UUID path segment is a readable slug shape, not a raw blob.
      'https://example.com/p/3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    ]) {
      expect(looksTokenized(url), url).toBe(false);
    }
  });

  it('flags URLs that may carry a secret', () => {
    for (const url of [
      // Any query string is refused outright.
      'https://example.com/article?token=abc123',
      'https://example.com/feed?auth=xyz',
      // Embedded credentials.
      'https://user:pass@example.com/article',
      // Long hex blob in the path (md5/sha-style).
      'https://example.com/a/0123456789abcdef0123456789abcdef',
      // base64url-ish high-entropy token segment (mixed case + digits).
      'https://example.com/s/aGVsbG8gd29ybGQgdGhpcyBpcyB0b2tlbg',
      // Hex blob as one part of an otherwise slug-shaped segment.
      'https://example.com/i/0123456789abcdef0123456789abcdef-thumb',
    ]) {
      expect(looksTokenized(url), url).toBe(true);
    }
  });

  it('fails closed on an unparseable URL', () => {
    expect(looksTokenized('not a url')).toBe(true);
  });
});
