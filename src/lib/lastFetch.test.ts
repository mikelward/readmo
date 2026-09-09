import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetLastFeedFetchForTests,
  formatLastFeedFetch,
  getLastFeedFetch,
  recordFeedFetch,
} from './lastFetch';

describe('last feed fetch record', () => {
  afterEach(() => _resetLastFeedFetchForTests());

  it('starts empty and formats as "not yet"', () => {
    expect(getLastFeedFetch()).toBeNull();
    expect(formatLastFeedFetch(null)).toBe('not yet');
  });

  it('records a success with no error text', () => {
    recordFeedFetch(true);
    const last = getLastFeedFetch();
    expect(last?.ok).toBe(true);
    expect(last?.error).toBeNull();
    expect(formatLastFeedFetch(last, last!.at)).toBe('just now · ok');
  });

  it('records a failure with the server message inline (readable on a phone)', () => {
    recordFeedFetch(false, new Error('429: rate limited'));
    const last = getLastFeedFetch();
    expect(last?.ok).toBe(false);
    expect(formatLastFeedFetch(last, last!.at)).toBe(
      'just now · failed: 429: rate limited',
    );
  });

  it('formats a message-less failure without a dangling colon', () => {
    recordFeedFetch(false, undefined);
    const last = getLastFeedFetch();
    expect(formatLastFeedFetch(last, last!.at)).toBe('just now · failed');
  });

  it('keeps only the most recent outcome', () => {
    recordFeedFetch(false, new Error('boom'));
    recordFeedFetch(true);
    expect(getLastFeedFetch()?.ok).toBe(true);
  });
});
