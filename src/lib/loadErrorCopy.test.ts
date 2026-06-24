import { describe, it, expect } from 'vitest';
import { loadFailureCopy, presentableDetail, errorMessage } from './loadErrorCopy';

const FEED = { action: 'fetching the feed list', noun: 'items' };

describe('loadFailureCopy', () => {
  it('blames the connection (not the server) when the device is offline', () => {
    const copy = loadFailureCopy('offline', new Error('Failed to fetch'), FEED);
    expect(copy.headline).toMatch(/offline/i);
    expect(copy.headline).not.toMatch(/server/i);
    expect(copy.detail).toBeNull();
  });

  it('honors an offline override (the reader’s pin-for-offline copy)', () => {
    const copy = loadFailureCopy('offline', new Error('x'), {
      action: 'fetching this article',
      noun: 'this article',
      offline: 'This article isn’t saved offline. Pin it while online to keep a copy.',
    });
    expect(copy.headline).toMatch(/pin it while online/i);
  });

  it('says the server isn’t responding only when the backend is unreachable', () => {
    const copy = loadFailureCopy('backend-unreachable', null, FEED);
    expect(copy.headline).toMatch(/isn’t responding/i);
    expect(copy.detail).toBeNull();
  });

  it('hides the internal empty-confirm sentinel behind the unreachable copy', () => {
    const sentinel = new Error(
      'feed read returned empty but the backend is unreachable — refusing to claim caught up off a possible cache hit',
    );
    const copy = loadFailureCopy('backend-unreachable', sentinel, FEED);
    expect(copy.headline).toMatch(/isn’t responding/i);
    expect(copy.detail).toBeNull();
  });

  it('names the action and surfaces a curated detail when online and errored', () => {
    const copy = loadFailureCopy(
      'online',
      new Error('Could not find the function public.feed_items in the schema cache'),
      FEED,
    );
    expect(copy.headline).toBe('Unexpected response fetching the feed list.');
    expect(copy.headline).not.toMatch(/isn’t responding/i);
    expect(copy.detail).toBe(
      'Could not find the function public.feed_items in the schema cache',
    );
  });

  it('falls back to a generic line when online with no error object', () => {
    const copy = loadFailureCopy('online', null, FEED);
    expect(copy.headline).toMatch(/couldn’t load items/i);
    expect(copy.detail).toBeNull();
  });
});

describe('presentableDetail', () => {
  it('returns the trimmed error message (same text we log)', () => {
    expect(presentableDetail(new Error('  feed_items: column does not exist  '))).toBe(
      'feed_items: column does not exist',
    );
  });

  it('returns null when there is nothing readable', () => {
    expect(presentableDetail(undefined)).toBeNull();
    expect(presentableDetail(new Error(''))).toBeNull();
    expect(presentableDetail(new Error('   '))).toBeNull();
  });
});

describe('errorMessage', () => {
  it('reads Error.message, raw strings, and PostgREST-style objects', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain failure')).toBe('plain failure');
    expect(errorMessage({ message: 'permission denied for table items' })).toBe(
      'permission denied for table items',
    );
    expect(errorMessage(undefined)).toBeNull();
  });
});
