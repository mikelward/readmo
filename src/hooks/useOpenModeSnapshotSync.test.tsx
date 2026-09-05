import { beforeEach, describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { useOpenModeSnapshotSync } from './useOpenModeSnapshotSync';
import {
  readOpenModeSnapshot,
  resetOpenModeSnapshotForTest,
} from '../lib/openModeSnapshot';
import type { Subscription } from '../lib/types';

// The mock auth path's signed-in flag (Supabase is unconfigured under test),
// matching the sibling hook tests.
const MOCK_SIGNED_IN_KEY = 'readmo:mock-signed-in';

function rows(flags: Partial<Subscription>): Array<{ subscription: Subscription }> {
  return [
    {
      subscription: {
        feedId: 'feed-hn',
        folder: null,
        titleOverride: null,
        muted: false,
        openOriginal: false,
        openNewshacker: false,
        markDoneOnOpen: false,
        listLayout: null,
        sort: 0,
        ...flags,
      },
    },
  ];
}

function Mount() {
  useOpenModeSnapshotSync();
  return null;
}

/** A subscriptions READ completing — what the hook watches for. `setQueryData`
 * is deliberately not this: a manual cache write is either a restore or the
 * Feeds page patching the list for the UI, and neither is the server answering. */
async function landRead(
  client: QueryClient,
  data: Array<{ subscription: Subscription }>,
) {
  await act(async () => {
    await client.fetchQuery({
      queryKey: ['subscriptions'],
      queryFn: async () => data,
      staleTime: 0,
    });
  });
}

function mount(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <Mount />
    </QueryClientProvider>,
  );
}

describe('useOpenModeSnapshotSync', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetOpenModeSnapshotForTest();
    // Supabase is unconfigured under test, so this is what "signed in" is on the
    // mock auth path — the gate every write here sits behind.
    window.localStorage.setItem(MOCK_SIGNED_IN_KEY, '1');
  });

  it('remembers a subscriptions read that lands with no rows mounted', async () => {
    // The Feeds page owns its own ['subscriptions'] query, so this is what a
    // mode flipped in Settings looks like from here: the read completes while no
    // article list exists.
    const client = new QueryClient();
    mount(client);
    await landRead(client, rows({ openNewshacker: true }));
    expect([...readOpenModeSnapshot().openNewshacker]).toEqual(['feed-hn']);
  });

  it('follows a later read, including one that turns a mode off', async () => {
    const client = new QueryClient();
    mount(client);
    await landRead(client, rows({ openNewshacker: true }));
    expect(readOpenModeSnapshot().openNewshacker.size).toBe(1);
    await landRead(client, rows({ openNewshacker: false }));
    expect(readOpenModeSnapshot().openNewshacker.size).toBe(0);
  });

  it('ignores a cache write that is not a completed read', async () => {
    // Restored persisted data and the Feeds page's own UI patch both land as
    // manual writes. The persisted blob is written on a throttle, so it can hold
    // an older list than the device remembers; taking either as an answer is how
    // a stale list would overwrite what is known.
    const client = new QueryClient();
    mount(client);
    await landRead(client, rows({ openNewshacker: true }));

    client.setQueryData(['subscriptions'], rows({ openNewshacker: false }));
    await waitFor(() =>
      expect(client.getQueryData(['subscriptions'])).toBeDefined(),
    );
    expect([...readOpenModeSnapshot().openNewshacker]).toEqual(['feed-hn']);
  });

  it('keeps what it remembered when the session has dropped', async () => {
    // A session can drop on its own (an offline token refresh), which is NOT a
    // sign-out — the caches are kept for the same user to come back to. The read
    // that runs meanwhile returns no rows under RLS; taking that as "no feed
    // opens externally" would wipe the snapshot they were kept for.
    const client = new QueryClient();
    mount(client);
    await landRead(client, rows({ openNewshacker: true }));

    // Flushed, so the subscriber is torn down before the read lands — the real
    // ordering, where the session drops first and the empty read follows.
    act(() => {
      window.localStorage.removeItem(MOCK_SIGNED_IN_KEY);
      window.dispatchEvent(new Event('readmo:auth-changed'));
    });
    await landRead(client, []);
    expect([...readOpenModeSnapshot().openNewshacker]).toEqual(['feed-hn']);
  });

  it('clears the modes when a signed-in read comes back empty', async () => {
    // Unsubscribing from the last feed, which really does mean nothing opens
    // externally — a saved article outlives its subscription and its row would
    // otherwise still find the flag.
    const client = new QueryClient();
    mount(client);
    await landRead(client, rows({ openNewshacker: true }));
    expect(readOpenModeSnapshot().openNewshacker.size).toBe(1);
    await landRead(client, []);
    expect(readOpenModeSnapshot().openNewshacker.size).toBe(0);
  });

  it('ignores every other query', async () => {
    const client = new QueryClient();
    mount(client);
    await act(async () => {
      await client.fetchQuery({
        queryKey: ['subscriptions', 'feed-hn'],
        queryFn: async () => rows({ openNewshacker: true }),
      });
      await client.fetchQuery({
        queryKey: ['feed', 'home'],
        queryFn: async () => rows({ openNewshacker: true }),
      });
    });
    expect(readOpenModeSnapshot().openNewshacker.size).toBe(0);
  });

  it('seeds from a restored cache when the device remembers nothing yet', async () => {
    // The upgrade case: a persisted ['subscriptions'] blob exists from before
    // this store did, so there is nothing remembered — and React Query counts a
    // restored result as fresh, so no read need follow it for staleTime, or ever
    // while offline. Without the seed every row opens in the reader until one
    // does.
    const client = new QueryClient();
    client.setQueryData(['subscriptions'], rows({ openNewshacker: true }));
    mount(client);
    await waitFor(() =>
      expect([...readOpenModeSnapshot().openNewshacker]).toEqual(['feed-hn']),
    );
  });

  it('seeds from a restore that lands after mount', async () => {
    // Restoring the persisted cache is asynchronous, so at mount there is
    // usually nothing there to seed from yet.
    const client = new QueryClient();
    mount(client);
    expect(readOpenModeSnapshot().openNewshacker.size).toBe(0);
    act(() => {
      client.setQueryData(['subscriptions'], rows({ openNewshacker: true }));
    });
    await waitFor(() =>
      expect([...readOpenModeSnapshot().openNewshacker]).toEqual(['feed-hn']),
    );
  });

  it('seeds once, and never over what is already remembered', async () => {
    // The seed fills an absence; it is not a second authority. Once anything is
    // stored — by the seed itself here — a later restore or UI patch is back to
    // being ignored, however new it looks.
    const client = new QueryClient();
    client.setQueryData(['subscriptions'], rows({ openNewshacker: true }));
    mount(client);
    await waitFor(() =>
      expect(readOpenModeSnapshot().openNewshacker.size).toBe(1),
    );

    act(() => {
      client.setQueryData(['subscriptions'], rows({ openNewshacker: false }));
    });
    await waitFor(() =>
      expect(client.getQueryData(['subscriptions'])).toBeDefined(),
    );
    expect([...readOpenModeSnapshot().openNewshacker]).toEqual(['feed-hn']);
  });

  it('does not seed while signed out', async () => {
    // Same reason the read path is gated: a cache present without a session is
    // not this account's answer to remember.
    window.localStorage.removeItem(MOCK_SIGNED_IN_KEY);
    const client = new QueryClient();
    client.setQueryData(['subscriptions'], rows({ openNewshacker: true }));
    mount(client);
    await waitFor(() =>
      expect(client.getQueryData(['subscriptions'])).toBeDefined(),
    );
    expect(readOpenModeSnapshot().openNewshacker.size).toBe(0);
  });

  it('stops following once unmounted', async () => {
    const client = new QueryClient();
    const { unmount } = mount(client);
    unmount();
    await landRead(client, rows({ openNewshacker: true }));
    expect(readOpenModeSnapshot().openNewshacker.size).toBe(0);
  });
});
