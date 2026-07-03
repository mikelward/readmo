// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { feedHealth, isUnhealthy, FEED_HEALTH_LABEL } from './feedHealth';
import type {
  AdminFeedStatus,
  AdminFeedSampleItem,
  FulltextDownloadStatus,
} from './data/DataSource';

function sample(over: Partial<AdminFeedSampleItem> = {}): AdminFeedSampleItem {
  return {
    id: 'i1',
    title: 'An article',
    hasFullContent: false,
    downloadStatus: null,
    downloadHttpStatus: null,
    downloadError: null,
    downloadRobotsRule: null,
    downloadAttemptedAt: null,
    ...over,
  };
}

function feed(over: Partial<AdminFeedStatus> = {}): AdminFeedStatus {
  return {
    id: 'f1',
    title: 'A feed',
    siteUrl: 'https://example.com',
    faviconUrl: null,
    lastFetchedAt: null,
    errorCount: 0,
    lastError: null,
    subscriberCount: 0,
    fetchFailed: false,
    parked: false,
    sample: null,
    ...over,
  };
}

describe('feedHealth', () => {
  it('reports poll-failed first, even with a healthy sample', () => {
    expect(
      feedHealth(
        feed({
          fetchFailed: true,
          errorCount: 3,
          sample: sample({ hasFullContent: true }),
        }),
      ),
    ).toBe('poll-failed');
  });

  it('reports not-tried when there is no recorded attempt (no sample)', () => {
    expect(feedHealth(feed({ sample: null }))).toBe('not-tried');
  });

  it('treats a cached body as downloaded regardless of a null status', () => {
    expect(feedHealth(feed({ sample: sample({ hasFullContent: true }) }))).toBe(
      'downloaded',
    );
  });

  it('treats a recorded ok as downloaded even without hasFullContent', () => {
    expect(
      feedHealth(feed({ sample: sample({ downloadStatus: 'ok' }) })),
    ).toBe('downloaded');
  });

  it.each<[FulltextDownloadStatus, string]>([
    ['auth', 'blocked'],
    ['unreachable', 'unreachable'],
    ['empty', 'empty'],
  ])('maps a %s download to %s', (status, expected) => {
    expect(feedHealth(feed({ sample: sample({ downloadStatus: status }) }))).toBe(
      expected,
    );
  });

  it('falls back to not-tried for a sample with no status and no body', () => {
    expect(feedHealth(feed({ sample: sample() }))).toBe('not-tried');
  });
});

describe('isUnhealthy', () => {
  it('counts poll-failed, blocked, and unreachable as unhealthy', () => {
    expect(isUnhealthy('poll-failed')).toBe(true);
    expect(isUnhealthy('blocked')).toBe(true);
    expect(isUnhealthy('unreachable')).toBe(true);
  });

  it('treats informational and success states as healthy', () => {
    for (const h of ['empty', 'not-tried', 'downloaded'] as const) {
      expect(isUnhealthy(h)).toBe(false);
    }
  });
});

describe('FEED_HEALTH_LABEL', () => {
  it('has a US-English label for every status', () => {
    expect(FEED_HEALTH_LABEL).toMatchObject({
      'poll-failed': 'Poll failed',
      'not-tried': 'Not tried',
      downloaded: 'Downloaded',
      blocked: 'Blocked',
      unreachable: 'Unreachable',
      empty: 'Empty',
    });
  });
});
