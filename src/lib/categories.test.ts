// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { orderCategories } from './categories';

describe('orderCategories', () => {
  it('sinks a generic "News" tag behind the specific ones', () => {
    // The Verge's actual tag order on an article about ride-sharing.
    expect(orderCategories(['News', 'Ride-sharing', 'Transportation'])).toEqual([
      'Ride-sharing',
      'Transportation',
      'News',
    ]);
  });

  it('matches "news" case- and whitespace-insensitively, keeping the publisher spelling', () => {
    expect(orderCategories(['news', 'Space'])).toEqual(['Space', 'news']);
    expect(orderCategories([' NEWS ', 'Space'])).toEqual(['Space', ' NEWS ']);
  });

  it('only demotes the whole tag, not one that merely contains "news"', () => {
    expect(orderCategories(['Tech News', 'Space'])).toEqual(['Tech News', 'Space']);
    expect(orderCategories(['Newsletters', 'Space'])).toEqual(['Newsletters', 'Space']);
  });

  it('keeps the publisher order otherwise, and within each group', () => {
    expect(orderCategories(['Transportation', 'Ride-sharing'])).toEqual([
      'Transportation',
      'Ride-sharing',
    ]);
    expect(orderCategories(['News', 'Cars', 'news', 'Tesla'])).toEqual([
      'Cars',
      'Tesla',
      'News',
      'news',
    ]);
  });

  it('leaves an all-generic list alone rather than emptying it', () => {
    expect(orderCategories(['News'])).toEqual(['News']);
  });

  it('tolerates a missing or empty list (pre-categories cache entries)', () => {
    expect(orderCategories(undefined)).toEqual([]);
    expect(orderCategories([])).toEqual([]);
  });

  it('does not mutate the input', () => {
    const input = ['News', 'Space'];
    orderCategories(input);
    expect(input).toEqual(['News', 'Space']);
  });
});
