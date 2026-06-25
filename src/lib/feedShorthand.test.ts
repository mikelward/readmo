import { describe, expect, it } from 'vitest';
import { expandFeedShorthand } from './feedShorthand';

describe('expandFeedShorthand', () => {
  it('expands a bare subreddit shorthand to a full reddit.com URL', () => {
    expect(expandFeedShorthand('r/programming')).toBe(
      'https://www.reddit.com/r/programming',
    );
  });

  it('accepts a leading slash', () => {
    expect(expandFeedShorthand('/r/programming')).toBe(
      'https://www.reddit.com/r/programming',
    );
  });

  it('trims surrounding whitespace before matching', () => {
    expect(expandFeedShorthand('  r/news  ')).toBe(
      'https://www.reddit.com/r/news',
    );
  });

  it('lowercases only the r/u/user prefix, preserving the subreddit case', () => {
    expect(expandFeedShorthand('R/AskReddit')).toBe(
      'https://www.reddit.com/r/AskReddit',
    );
  });

  it('keeps a sort tail intact for the server to derive', () => {
    expect(expandFeedShorthand('r/news/top')).toBe(
      'https://www.reddit.com/r/news/top',
    );
  });

  it('keeps a search query tail intact', () => {
    expect(expandFeedShorthand('r/news/search?q=cats')).toBe(
      'https://www.reddit.com/r/news/search?q=cats',
    );
  });

  it('expands the user shorthand (both u/ and user/)', () => {
    expect(expandFeedShorthand('u/spez')).toBe('https://www.reddit.com/u/spez');
    expect(expandFeedShorthand('user/spez')).toBe(
      'https://www.reddit.com/user/spez',
    );
  });

  it('expands a multireddit path', () => {
    expect(expandFeedShorthand('user/alice/m/tech')).toBe(
      'https://www.reddit.com/user/alice/m/tech',
    );
  });

  it('leaves a full URL unchanged (apart from trimming)', () => {
    expect(expandFeedShorthand('https://example.com/feed')).toBe(
      'https://example.com/feed',
    );
    expect(expandFeedShorthand('  https://example.com/feed  ')).toBe(
      'https://example.com/feed',
    );
  });

  it('leaves an existing reddit.com URL unchanged', () => {
    expect(expandFeedShorthand('reddit.com/r/programming')).toBe(
      'reddit.com/r/programming',
    );
  });

  it('does not mistake a hostname whose first label is r/u/user', () => {
    // The dot before the slash means it is a host, not a shorthand prefix.
    expect(expandFeedShorthand('r.jina.ai/feed')).toBe('r.jina.ai/feed');
    expect(expandFeedShorthand('u.example.com')).toBe('u.example.com');
  });

  it('leaves a bare domain unchanged for the existing https:// path', () => {
    expect(expandFeedShorthand('example.com')).toBe('example.com');
  });

  it('does not expand a dangling prefix with no name', () => {
    expect(expandFeedShorthand('r/')).toBe('r/');
    expect(expandFeedShorthand('r')).toBe('r');
  });

  it('returns empty string for blank input', () => {
    expect(expandFeedShorthand('   ')).toBe('');
  });
});
