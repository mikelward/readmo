// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  markFeedReaderOpen,
  consumeFeedReaderReturn,
  resetFeedReaderReturnForTest,
} from './feedReaderReturn';

afterEach(() => resetFeedReaderReturnForTest());

describe('feedReaderReturn', () => {
  it('returns false when no reader open was recorded', () => {
    expect(consumeFeedReaderReturn('home-all')).toBe(false);
  });

  it('reports the return once for the matching view, then clears', () => {
    markFeedReaderOpen('home-all');
    // First consume from the matching view is the Back-return.
    expect(consumeFeedReaderReturn('home-all')).toBe(true);
    // Consumed — a second mount of the same view refetches normally.
    expect(consumeFeedReaderReturn('home-all')).toBe(false);
  });

  it('only matches the view the reader was opened from', () => {
    markFeedReaderOpen('feed-a');
    // A different view mounting doesn't consume feed-a's pending return…
    expect(consumeFeedReaderReturn('feed-b')).toBe(false);
    // …so feed-a still sees its return when it mounts.
    expect(consumeFeedReaderReturn('feed-a')).toBe(true);
  });

  it('keeps only the most recent open (single pending slot)', () => {
    markFeedReaderOpen('feed-a');
    markFeedReaderOpen('feed-b');
    expect(consumeFeedReaderReturn('feed-a')).toBe(false);
    expect(consumeFeedReaderReturn('feed-b')).toBe(true);
  });

  it('reset clears any pending return', () => {
    markFeedReaderOpen('home-all');
    resetFeedReaderReturnForTest();
    expect(consumeFeedReaderReturn('home-all')).toBe(false);
  });
});
