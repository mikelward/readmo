// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { toItemRow } from './itemRow.ts';
import type { ParsedFeed } from './parser.ts';

type ParsedItem = ParsedFeed['items'][number];

function makeItem(overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    guid: 'g1',
    url: 'https://example.com/a',
    commentsUrl: null,
    title: 'A title',
    author: null,
    publishedAt: null,
    contentHtml: '<p>Body</p>',
    summary: null,
    enclosures: [],
    categories: [],
    ...overrides,
  };
}

describe('toItemRow — categories', () => {
  it('carries the parsed categories through unchanged', () => {
    const row = toItemRow(makeItem({ categories: ['Podcasts', 'Economics'] }), null);
    expect(row.categories).toEqual(['Podcasts', 'Economics']);
  });

  it('defaults to an empty array when the parsed item has none', () => {
    const row = toItemRow(makeItem(), null);
    expect(row.categories).toEqual([]);
  });
});
