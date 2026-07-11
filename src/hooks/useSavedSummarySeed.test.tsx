import { describe, expect, it } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { IsRestoringProvider, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DataSourceProvider } from '../lib/data/context';
import { MockDataSource } from '../lib/data/MockDataSource';
import { useSavedSummarySeed } from './useSavedSummarySeed';
import { CAPABILITIES_QUERY_KEY } from './useCapabilities';
import type { Capabilities } from '../lib/data/DataSource';

const ALLOWED: Capabilities = { family: false, admin: false, allowlistArmed: false };
// Armed allowlist, caller not family → useFullTextAllowed is false.
const OFF_LIST: Capabilities = { family: false, admin: false, allowlistArmed: true };

function Harness() {
  useSavedSummarySeed();
  return null;
}

function mount(
  qc: QueryClient,
  source: MockDataSource,
  opts: { restoring?: boolean } = {},
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <IsRestoringProvider value={opts.restoring ?? false}>
        <DataSourceProvider source={source}>{children}</DataSourceProvider>
      </IsRestoringProvider>
    </QueryClientProvider>
  );
  return render(<Harness />, { wrapper });
}

/** Put a home-feed page in the cache whose row for `id` carries `aiSummary`, AND
 * cache a matching `['item', id]` detail (the offline lock warms this; the seed
 * requires it to be present and content-matching). getItem omits ai_summary, so
 * the detail carries none — only content_html/title are matched. */
async function setFeedRow(
  qc: QueryClient,
  source: MockDataSource,
  id: string,
  aiSummary: string | null,
) {
  const base = (await source.getItem(id))!;
  qc.setQueryData(['feed', 'home'], {
    pages: [{ items: [{ ...base, item: { ...base.item, aiSummary } }] }],
    pageParams: [null],
  });
  qc.setQueryData(['item', id], { ...base, item: { ...base.item, aiSummary: null } });
}

function newClient(caps: Capabilities = ALLOWED) {
  // gcTime Infinity so an observer-less ['summary', id] (there's no reader
  // mounted here) isn't garbage-collected mid-test — these assert seeding logic,
  // not GC (the offline lock's retention is covered in its own suite).
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
  qc.setQueryData(CAPABILITIES_QUERY_KEY, caps);
  return qc;
}

describe('useSavedSummarySeed', () => {
  it('seeds a favorited item’s summary from the cached feed row (viaRow)', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'favorite', true);
    const qc = newClient();
    await setFeedRow(qc, source, 'item-1', 'Row gist.');
    mount(qc, source);
    await waitFor(() =>
      expect(qc.getQueryData(['summary', 'item-1'])).toEqual({
        status: 'ok',
        summary: 'Row gist.',
        viaRow: true,
      }),
    );
  });

  it('re-seeds when a saved item’s row gains a gist on a later feed refresh', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'favorite', true);
    const qc = newClient();
    await setFeedRow(qc, source, 'item-1', null); // no gist yet
    mount(qc, source);
    await act(async () => {});
    expect(qc.getQueryData(['summary', 'item-1'])).toBeUndefined();

    // A refresh brings the gist — the feed-cache subscription re-seeds it.
    await act(async () => {
      await setFeedRow(qc, source, 'item-1', 'Late gist.');
    });
    await waitFor(() =>
      expect(qc.getQueryData(['summary', 'item-1'])).toEqual({
        status: 'ok',
        summary: 'Late gist.',
        viaRow: true,
      }),
    );
  });

  it('seeds an item newly favorited after mount', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = newClient();
    await setFeedRow(qc, source, 'item-1', 'Row gist.');
    mount(qc, source);
    await act(async () => {});
    expect(qc.getQueryData(['summary', 'item-1'])).toBeUndefined(); // not saved yet

    await act(async () => {
      source.stateStore.set('item-1', 'favorite', true);
    });
    await waitFor(() =>
      expect(qc.getQueryData(['summary', 'item-1'])).toMatchObject({
        summary: 'Row gist.',
        viaRow: true,
      }),
    );
  });

  it('does not seed when the retained item detail is fresher than the row (content mismatch)', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'favorite', true);
    const qc = newClient();
    const base = (await source.getItem('item-1'))!;
    // Feed row: OLD body + old gist.
    qc.setQueryData(['feed', 'home'], {
      pages: [
        {
          items: [
            { ...base, item: { ...base.item, contentHtml: '<p>old body</p>', aiSummary: 'Old gist.' } },
          ],
        },
      ],
      pageParams: [null],
    });
    // Retained ['item', id]: FRESH body (refreshed by a prior online open).
    qc.setQueryData(['item', 'item-1'], {
      ...base,
      item: { ...base.item, contentHtml: '<p>new body</p>' },
    });
    mount(qc, source);
    await act(async () => {});
    // The stale row gist is NOT seeded over the fresh body; left for revalidation.
    expect(qc.getQueryData(['summary', 'item-1'])).toBeUndefined();
  });

  it('seeds when the retained item detail matches the row', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'favorite', true);
    const qc = newClient();
    const base = (await source.getItem('item-1'))!;
    qc.setQueryData(['feed', 'home'], {
      pages: [{ items: [{ ...base, item: { ...base.item, aiSummary: 'Matching gist.' } }] }],
      pageParams: [null],
    });
    qc.setQueryData(['item', 'item-1'], base); // same content as the row
    mount(qc, source);
    await waitFor(() =>
      expect(qc.getQueryData(['summary', 'item-1'])).toEqual({
        status: 'ok',
        summary: 'Matching gist.',
        viaRow: true,
      }),
    );
  });

  it('waits for the retained detail before seeding, then seeds when it warms matching', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'favorite', true);
    const qc = newClient();
    const base = (await source.getItem('item-1'))!;
    // Feed row has a gist, but the offline lock hasn't warmed ['item', id] yet.
    qc.setQueryData(['feed', 'home'], {
      pages: [{ items: [{ ...base, item: { ...base.item, aiSummary: 'Row gist.' } }] }],
      pageParams: [null],
    });
    mount(qc, source);
    await act(async () => {});
    expect(qc.getQueryData(['summary', 'item-1'])).toBeUndefined(); // waited — no detail

    // The lock warms a matching detail → the 'item' update re-runs the seed.
    await act(async () => {
      qc.setQueryData(['item', 'item-1'], { ...base, item: { ...base.item, aiSummary: null } });
    });
    await waitFor(() =>
      expect(qc.getQueryData(['summary', 'item-1'])).toEqual({
        status: 'ok',
        summary: 'Row gist.',
        viaRow: true,
      }),
    );
  });

  it('does not seed a stale row when the detail warms fresher (async-warm case)', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'favorite', true);
    const qc = newClient();
    const base = (await source.getItem('item-1'))!;
    qc.setQueryData(['feed', 'home'], {
      pages: [
        {
          items: [
            { ...base, item: { ...base.item, contentHtml: '<p>old body</p>', aiSummary: 'Old gist.' } },
          ],
        },
      ],
      pageParams: [null],
    });
    mount(qc, source);
    await act(async () => {});
    expect(qc.getQueryData(['summary', 'item-1'])).toBeUndefined(); // no detail yet → waited

    // The lock warms a FRESHER detail (edited body) → still no seed (mismatch),
    // and nothing stale was seeded earlier that could leak.
    await act(async () => {
      qc.setQueryData(['item', 'item-1'], {
        ...base,
        item: { ...base.item, contentHtml: '<p>new body</p>' },
      });
    });
    await act(async () => {});
    expect(qc.getQueryData(['summary', 'item-1'])).toBeUndefined();
  });

  it('drops a stale viaRow seed when the retained detail refreshes to mismatch the row', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'favorite', true);
    const qc = newClient();
    const base = (await source.getItem('item-1'))!;
    // Row + matching detail → seeds a viaRow gist.
    qc.setQueryData(['feed', 'home'], {
      pages: [{ items: [{ ...base, item: { ...base.item, aiSummary: 'Gist v1.' } }] }],
      pageParams: [null],
    });
    qc.setQueryData(['item', 'item-1'], { ...base, item: { ...base.item, aiSummary: null } });
    mount(qc, source);
    await waitFor(() =>
      expect(qc.getQueryData(['summary', 'item-1'])).toMatchObject({
        summary: 'Gist v1.',
        viaRow: true,
      }),
    );

    // The detail is refreshed to an edited body — the still-persisted row now
    // mismatches it, so the stale seed is dropped rather than shown over the body.
    await act(async () => {
      qc.setQueryData(['item', 'item-1'], {
        ...base,
        item: { ...base.item, contentHtml: '<p>edited body</p>' },
      });
    });
    await waitFor(() => expect(qc.getQueryData(['summary', 'item-1'])).toBeUndefined());
  });

  it('does not clobber a real fetched summary', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'favorite', true);
    const qc = newClient();
    await setFeedRow(qc, source, 'item-1', 'Row gist.');
    const real = { status: 'ok', summary: 'The real fetched summary.' };
    qc.setQueryData(['summary', 'item-1'], real);
    mount(qc, source);
    await act(async () => {});
    expect(qc.getQueryData(['summary', 'item-1'])).toEqual(real);
  });

  it('does not seed an item that is neither pinned nor favorited', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const qc = newClient();
    await setFeedRow(qc, source, 'item-1', 'Row gist.');
    mount(qc, source);
    await act(async () => {});
    expect(qc.getQueryData(['summary', 'item-1'])).toBeUndefined();
  });

  it('does not seed while the persisted cache is still restoring', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'favorite', true);
    const qc = newClient();
    await setFeedRow(qc, source, 'item-1', 'Row gist.');
    mount(qc, source, { restoring: true });
    await act(async () => {});
    expect(qc.getQueryData(['summary', 'item-1'])).toBeUndefined();
  });

  it('does not seed for an off-allowlist caller', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'favorite', true);
    const qc = newClient(OFF_LIST);
    await setFeedRow(qc, source, 'item-1', 'Row gist.');
    mount(qc, source);
    await act(async () => {});
    expect(qc.getQueryData(['summary', 'item-1'])).toBeUndefined();
  });
});
