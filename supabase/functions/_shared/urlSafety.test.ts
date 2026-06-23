// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { looksTokenized } from './urlSafety.ts';

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
