import { describe, expect, it } from 'vitest';
import {
  fullTextStaleTime,
  htmlTextLength,
  isFullTextSettled,
  looksTruncated,
  TRUNCATION_TEXT_THRESHOLD,
  type FullTextResult,
} from './fullText';

const longBody = `<p>${'word '.repeat(200)}</p>`; // ~1000 chars of text

describe('fullTextStaleTime', () => {
  const stale = (data: FullTextResult) => fullTextStaleTime({ state: { data } });

  it('caches terminal outcomes forever (re-fetching cannot change them)', () => {
    expect(stale({ status: 'ok', contentHtml: '<p>x</p>' })).toBe(Infinity);
    expect(stale({ status: 'empty', contentHtml: null })).toBe(Infinity);
    expect(stale({ status: 'auth', contentHtml: null })).toBe(Infinity);
  });

  it('keeps transient/changeable outcomes stale so the next open retries', () => {
    // unreachable: the fetch may succeed later. retryable empty: an allowlist
    // denial a later change (operator adds this caller) should un-stick.
    expect(stale({ status: 'unreachable', contentHtml: null })).toBe(0);
    expect(stale({ status: 'empty', contentHtml: null, retryable: true })).toBe(0);
  });

  it('treats a query with no data as stale', () => {
    expect(fullTextStaleTime({ state: {} })).toBe(0);
  });
});

describe('isFullTextSettled', () => {
  it('settles terminal results so the offline warmer stops re-fetching', () => {
    expect(isFullTextSettled({ status: 'ok', contentHtml: '<p>x</p>' })).toBe(true);
    expect(isFullTextSettled({ status: 'empty', contentHtml: null })).toBe(true);
    expect(isFullTextSettled({ status: 'auth', contentHtml: null })).toBe(true);
  });

  it('leaves transient and retryable results unsettled (re-prefetched later)', () => {
    expect(isFullTextSettled({ status: 'unreachable', contentHtml: null })).toBe(false);
    expect(
      isFullTextSettled({ status: 'empty', contentHtml: null, retryable: true }),
    ).toBe(false);
  });
});

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
