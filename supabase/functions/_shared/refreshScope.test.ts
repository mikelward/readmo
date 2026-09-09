// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { feedsToRefresh } from './refreshScope.ts';

describe('feedsToRefresh', () => {
  it('refreshes the caller’s subscribed feeds', () => {
    expect(
      feedsToRefresh({ subscribedFeedIds: ['a', 'b'], feedId: null, isAdmin: false }),
    ).toEqual(['a', 'b']);
  });

  it('refreshes a subscribed feed regardless of admin status', () => {
    expect(
      feedsToRefresh({ subscribedFeedIds: ['a'], feedId: 'a', isAdmin: false }),
    ).toEqual(['a']);
  });

  it('lets an admin refresh a named feed they don’t subscribe to', () => {
    expect(
      feedsToRefresh({ subscribedFeedIds: [], feedId: 'x', isAdmin: true }),
    ).toEqual(['x']);
  });

  it('refuses a non-admin refreshing a feed they don’t subscribe to', () => {
    expect(
      feedsToRefresh({ subscribedFeedIds: [], feedId: 'x', isAdmin: false }),
    ).toEqual([]);
  });

  it('does not turn a no-feedId admin call into an all-system poll', () => {
    // "Refresh all my subscriptions" with none → nothing, even for an admin.
    expect(
      feedsToRefresh({ subscribedFeedIds: [], feedId: null, isAdmin: true }),
    ).toEqual([]);
  });
});
