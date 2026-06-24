import { describe, expect, it } from 'vitest';
import {
  FULLTEXT_VERSION,
  fullTextQueryKey,
  htmlTextLength,
  looksTruncated,
  TRUNCATION_TEXT_THRESHOLD,
} from './fullText';

const longBody = `<p>${'word '.repeat(200)}</p>`; // ~1000 chars of text

describe('htmlTextLength', () => {
  it('counts visible text, not markup', () => {
    expect(htmlTextLength('<p><strong>hi</strong> there</p>')).toBe('hi there'.length);
  });

  it('treats entities and whitespace as a single space', () => {
    expect(htmlTextLength('<p>a&amp;b\n\n  c</p>')).toBe('a b c'.length);
  });

  it('is zero for empty/whitespace-only', () => {
    expect(htmlTextLength('')).toBe(0);
    expect(htmlTextLength('<p>   </p>')).toBe(0);
  });
});

describe('looksTruncated', () => {
  it('is true for an empty body', () => {
    expect(looksTruncated({ contentHtml: '', fullContentHtml: null })).toBe(true);
  });

  it('is true for a short excerpt', () => {
    expect(
      looksTruncated({ contentHtml: '<p>Read the rest on our site…</p>', fullContentHtml: null }),
    ).toBe(true);
  });

  it('is false for a long body', () => {
    expect(looksTruncated({ contentHtml: longBody, fullContentHtml: null })).toBe(false);
  });

  it('is false once a full body is cached, even if the feed body is short', () => {
    expect(
      looksTruncated({ contentHtml: '<p>stub</p>', fullContentHtml: '<p>full</p>' }),
    ).toBe(false);
  });

  it('uses the documented threshold', () => {
    const justUnder = `<p>${'x'.repeat(TRUNCATION_TEXT_THRESHOLD - 1)}</p>`;
    const justOver = `<p>${'x'.repeat(TRUNCATION_TEXT_THRESHOLD + 1)}</p>`;
    expect(looksTruncated({ contentHtml: justUnder, fullContentHtml: null })).toBe(true);
    expect(looksTruncated({ contentHtml: justOver, fullContentHtml: null })).toBe(false);
  });
});

describe('fullTextQueryKey', () => {
  it('scopes the key to the item id and the extractor version', () => {
    // The version in the key is what invalidates a persisted (staleTime:Infinity)
    // full-text result when FULLTEXT_VERSION is bumped — a stale body lives under
    // the old key and is never read.
    expect(fullTextQueryKey('item-1')).toEqual(['fulltext', 'item-1', FULLTEXT_VERSION]);
  });

  it('FULLTEXT_VERSION is a positive integer', () => {
    expect(Number.isInteger(FULLTEXT_VERSION)).toBe(true);
    expect(FULLTEXT_VERSION).toBeGreaterThan(0);
  });
});
