import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders as baseRender } from '../test/renderWithProviders';
import { ArticleSummary } from './ArticleSummary';
import { MockDataSource } from '../lib/data/MockDataSource';
import { CAPABILITIES_QUERY_KEY } from '../hooks/useCapabilities';
import type { SummaryResult } from '../lib/summary';
import type { Capabilities } from '../lib/data/DataSource';

const ITEM_ID = 'item-1';

// useFullTextAllowed is closed until capabilities RESOLVE to allowed (a
// signed-out caller is never allowlisted), so seed a disarmed (open-to-all)
// capability set — the summary card only shows for an allowed caller. Shadows
// the shared helper so every render below runs on the allowed path.
const ALLOWED_CAPS: Capabilities = { family: false, admin: false, allowlistArmed: false };
function renderWithProviders(
  ui: ReactElement,
  opts: { route?: string; source?: MockDataSource; queryClient?: QueryClient } = {},
) {
  const queryClient =
    opts.queryClient ??
    new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  if (queryClient.getQueryData(CAPABILITIES_QUERY_KEY) === undefined) {
    queryClient.setQueryData(CAPABILITIES_QUERY_KEY, ALLOWED_CAPS);
  }
  return baseRender(ui, { ...opts, queryClient });
}

describe('ArticleSummary', () => {
  it('auto-generates for an article pinned before opening', async () => {
    renderWithProviders(<ArticleSummary id={ITEM_ID} online autoGenerate />);
    const body = await screen.findByTestId('article-summary-body');
    expect(body.textContent).toMatch(/one sentence/i);
    expect(screen.getByText('Summary by Gemini')).toBeInTheDocument();
  });

  it('renders a bulleted summary as a list', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.getSummary = async (): Promise<SummaryResult> => ({
      status: 'ok',
      summary: '- First point\n- Second point',
    });
    renderWithProviders(<ArticleSummary id={ITEM_ID} online autoGenerate />, { source });
    const body = await screen.findByTestId('article-summary-body');
    const items = body.querySelectorAll('ul.markdown-list > li');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe('First point');
    expect(items[1].textContent).toBe('Second point');
  });

  it('renders a summary delivered on the item row instantly — no fetch, no spinner', async () => {
    // The allowlisted ride-along (feed_items, 0058): the gist arrives ON the
    // item, so the reader shows it immediately without the `summary` Edge call
    // or the "Summarizing…" placeholder.
    const source = new MockDataSource(`test-${Math.random()}`);
    let called = false;
    source.getSummary = async (): Promise<SummaryResult> => {
      called = true;
      return { status: 'ok', summary: 'should not be fetched' };
    };
    renderWithProviders(
      <ArticleSummary
        id={ITEM_ID}
        online
        autoGenerate
        cachedSummary="A cached gist from the row."
      />,
      { source },
    );
    const body = await screen.findByTestId('article-summary-body');
    expect(body.textContent).toBe('A cached gist from the row.');
    expect(screen.getByText('Summary by Gemini')).toBeInTheDocument();
    expect(called).toBe(false);
    expect(screen.queryByTestId('article-summary-loading')).not.toBeInTheDocument();
  });

  it('paints an already-cached summary while capabilities are still loading (no flash)', async () => {
    // Cold boot: capabilities haven't resolved yet, but the pinned summary is
    // already in the React Query cache (prewarmed / offline-lock warmed). The
    // OPTIMISTIC display gate shows it immediately instead of blanking to
    // "Summarizing…" until caps resolve (the 500 ms–1 s flash). The conservative
    // FETCH gate still fires nothing while caps load.
    const source = new MockDataSource(`test-${Math.random()}`);
    let called = false;
    source.getSummary = async (): Promise<SummaryResult> => {
      called = true;
      return { status: 'ok', summary: 'should not be fetched' };
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    // Summary cached; capabilities deliberately NOT set (still loading).
    queryClient.setQueryData(['summary', ITEM_ID], { status: 'ok', summary: 'Prewarmed gist.' });
    baseRender(<ArticleSummary id={ITEM_ID} online autoGenerate />, { source, queryClient });
    // Painted instantly from cache — no spinner, and no Edge call.
    expect(screen.getByTestId('article-summary-body').textContent).toBe('Prewarmed gist.');
    expect(screen.queryByTestId('article-summary-loading')).not.toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('drops a cached summary once capabilities resolve to a denial', async () => {
    // The optimistic gate is open only while caps are UNKNOWN; a resolved denial
    // (armed allowlist, off-list) still hides a cached summary — same boundary the
    // conservative gate enforced, just without the cold-boot flash.
    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    queryClient.setQueryData(['summary', ITEM_ID], { status: 'ok', summary: 'Gated gist.' });
    queryClient.setQueryData(CAPABILITIES_QUERY_KEY, {
      family: false,
      admin: false,
      allowlistArmed: true,
    });
    baseRender(<ArticleSummary id={ITEM_ID} online autoGenerate />, { source, queryClient });
    expect(screen.queryByTestId('article-summary-body')).toBeNull();
  });

  it('shows the row summary even offline (it is bundled with the pinned item)', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    let called = false;
    source.getSummary = async (): Promise<SummaryResult> => {
      called = true;
      return { status: 'ok', summary: 'x' };
    };
    renderWithProviders(
      <ArticleSummary
        id={ITEM_ID}
        online={false}
        autoGenerate
        cachedSummary="An offline gist."
      />,
      { source },
    );
    expect(await screen.findByTestId('article-summary-body')).toHaveTextContent(
      'An offline gist.',
    );
    // Not the "not available offline" card — we HAVE it — and no fetch.
    expect(screen.queryByTestId('article-summary-offline')).not.toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('seeds the row summary into the retained ["summary", id] cache as a viaRow entry', async () => {
    // The gist is shown from the row, but it's also durably seeded into
    // ['summary', id] — the key useOfflineCacheLock retains — so it survives the
    // GC-able feed cache being evicted. Flagged viaRow (provisional).
    const source = new MockDataSource(`test-${Math.random()}`);
    const { queryClient } = renderWithProviders(
      <ArticleSummary id={ITEM_ID} online autoGenerate cachedSummary="A row gist." />,
      { source },
    );
    await screen.findByTestId('article-summary-body');
    await waitFor(() =>
      expect(queryClient.getQueryData(['summary', ITEM_ID])).toEqual({
        status: 'ok',
        summary: 'A row gist.',
        viaRow: true,
      }),
    );
  });

  it('replaces a stale non-ok cached result with the row seed (offline shows the gist, not the failure)', async () => {
    // A prior transient failure is cached under ['summary', id]. The row is now
    // delivering a gist, so the seed must overwrite the failure — otherwise a
    // later offline open would serve "not available" over the gist we're showing.
    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    queryClient.setQueryData(['summary', ITEM_ID], { status: 'unreachable', summary: null });
    renderWithProviders(
      <ArticleSummary id={ITEM_ID} online autoGenerate cachedSummary="The delivered gist." />,
      { source, queryClient },
    );
    await screen.findByTestId('article-summary-body');
    await waitFor(() =>
      expect(queryClient.getQueryData(['summary', ITEM_ID])).toEqual({
        status: 'ok',
        summary: 'The delivered gist.',
        viaRow: true,
      }),
    );
  });

  it('does not clobber a real fetched summary with a row seed', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const real = { status: 'ok', summary: 'The real fetched summary.' };
    queryClient.setQueryData(['summary', ITEM_ID], real);
    renderWithProviders(
      <ArticleSummary id={ITEM_ID} online autoGenerate cachedSummary="A different row gist." />,
      { source, queryClient },
    );
    await screen.findByTestId('article-summary-body');
    // The settled fetched summary is protected — the seed effect leaves it as-is.
    await waitFor(() =>
      expect(queryClient.getQueryData(['summary', ITEM_ID])).toEqual(real),
    );
  });

  it('revalidates a viaRow seed on an unpinned (favorite) open and graduates it', async () => {
    // A favorite (autoGenerate false) whose feed row was GC'd keeps only a viaRow
    // seed. Opening it online must still re-check the server so a publisher edit
    // self-heals — the seed shows immediately, then graduates to the fetched one.
    const source = new MockDataSource(`test-${Math.random()}`);
    let calls = 0;
    source.getSummary = async (): Promise<SummaryResult> => {
      calls += 1;
      return { status: 'ok', summary: 'Fresh graduated summary.' };
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    queryClient.setQueryData(['summary', ITEM_ID], {
      status: 'ok',
      summary: 'Stale seed.',
      viaRow: true,
    });
    renderWithProviders(<ArticleSummary id={ITEM_ID} online autoGenerate={false} />, {
      source,
      queryClient,
    });
    await waitFor(() =>
      expect(screen.getByTestId('article-summary-body')).toHaveTextContent(
        'Fresh graduated summary.',
      ),
    );
    expect(calls).toBeGreaterThanOrEqual(1);
    // Graduated to a durable fetched summary (no longer viaRow).
    expect(queryClient.getQueryData(['summary', ITEM_ID])).toEqual({
      status: 'ok',
      summary: 'Fresh graduated summary.',
    });
  });

  it('keeps a viaRow seed when a revalidation transiently fails (stale beats empty)', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    let called = false;
    source.getSummary = async (): Promise<SummaryResult> => {
      called = true;
      return { status: 'unreachable', summary: null };
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    queryClient.setQueryData(['summary', ITEM_ID], {
      status: 'ok',
      summary: 'Retained gist.',
      viaRow: true,
    });
    renderWithProviders(<ArticleSummary id={ITEM_ID} online autoGenerate={false} />, {
      source,
      queryClient,
    });
    expect(await screen.findByTestId('article-summary-body')).toHaveTextContent(
      'Retained gist.',
    );
    await waitFor(() => expect(called).toBe(true));
    // The transient failure preserved the gist — no error card, still the seed.
    await waitFor(() =>
      expect(queryClient.getQueryData(['summary', ITEM_ID])).toEqual({
        status: 'ok',
        summary: 'Retained gist.',
        viaRow: true,
      }),
    );
    expect(screen.queryByTestId('article-summary-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('article-summary-body')).toHaveTextContent('Retained gist.');
  });

  it('serves a retained viaRow seed offline when the feed row is gone (stale beats empty)', async () => {
    // The feed row has been GC'd (no cachedSummary), so useSummary falls to the
    // query — offline, disabled, but the retained seed is still there. It shows,
    // with no "not available offline" card and no fetch.
    const source = new MockDataSource(`test-${Math.random()}`);
    let called = false;
    source.getSummary = async (): Promise<SummaryResult> => {
      called = true;
      return { status: 'ok', summary: 'fresh' };
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    queryClient.setQueryData(['summary', ITEM_ID], {
      status: 'ok',
      summary: 'A retained gist.',
      viaRow: true,
    });
    renderWithProviders(<ArticleSummary id={ITEM_ID} online={false} autoGenerate />, {
      source,
      queryClient,
    });
    expect(await screen.findByTestId('article-summary-body')).toHaveTextContent(
      'A retained gist.',
    );
    expect(screen.queryByTestId('article-summary-offline')).not.toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('offers a Generate button (no call) for an unpinned article until clicked', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    let called = false;
    const orig = source.getSummary.bind(source);
    source.getSummary = (id) => {
      called = true;
      return orig(id);
    };
    renderWithProviders(
      <ArticleSummary id={ITEM_ID} online autoGenerate={false} />,
      { source },
    );

    // Nothing generated yet: just the button.
    const button = await screen.findByTestId('article-summary-generate');
    expect(button).toHaveTextContent('Generate summary');
    expect(called).toBe(false);
    expect(screen.queryByTestId('article-summary-body')).not.toBeInTheDocument();

    // Clicking it generates and shows the summary.
    await userEvent.click(button);
    const body = await screen.findByTestId('article-summary-body');
    expect(body.textContent).toMatch(/one sentence/i);
    expect(called).toBe(true);
    expect(screen.queryByTestId('article-summary-generate')).not.toBeInTheDocument();
  });

  it('does not leak a manual request to the next item on navigation', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const calledFor: string[] = [];
    source.getSummary = async (id): Promise<SummaryResult> => {
      calledFor.push(id);
      return { status: 'ok', summary: `summary for ${id}` };
    };
    const { rerender } = renderWithProviders(
      <ArticleSummary id="item-a" online autoGenerate={false} />,
      { source },
    );

    // Ask for item-a's summary via the button.
    await userEvent.click(await screen.findByTestId('article-summary-generate'));
    await screen.findByTestId('article-summary-body');
    expect(calledFor).toEqual(['item-a']);

    // Navigate to a different unpinned item reusing the same instance: the
    // trigger is keyed to item-a, so item-b must NOT auto-generate — it offers
    // its own button instead.
    rerender(<ArticleSummary id="item-b" online autoGenerate={false} />);
    expect(await screen.findByTestId('article-summary-generate')).toBeInTheDocument();
    expect(calledFor).not.toContain('item-b');
  });

  it('does not call the summary endpoint or offer a button while offline', () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    let called = false;
    const orig = source.getSummary.bind(source);
    source.getSummary = (id) => {
      called = true;
      return orig(id);
    };
    renderWithProviders(
      <ArticleSummary id={ITEM_ID} online={false} autoGenerate={false} />,
      { source },
    );
    expect(screen.queryByTestId('article-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('article-summary-generate')).not.toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('stays silent on a soft failure (e.g. off-allowlist / nothing to summarize)', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.getSummary = async (): Promise<SummaryResult> => ({
      status: 'empty',
      summary: null,
      retryable: true,
    });
    renderWithProviders(<ArticleSummary id={ITEM_ID} online autoGenerate />, { source });
    // Give the (resolved-empty) query a chance to settle, then assert no card.
    await waitFor(() =>
      expect(screen.queryByTestId('article-summary-body')).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('Summary by Gemini')).not.toBeInTheDocument();
    // And no lingering button — a settled soft failure isn't re-offerable here.
    expect(screen.queryByTestId('article-summary-generate')).not.toBeInTheDocument();
  });

  it('shows a Retry card when a requested generation cannot reach the service', async () => {
    // A transient `unreachable` is the one soft failure the user explicitly
    // asked for (pinned auto-run or the Generate button), so it must not
    // vanish silently — the button is already gone by then, leaving no way to
    // try again.
    const source = new MockDataSource(`test-${Math.random()}`);
    let calls = 0;
    source.getSummary = async (): Promise<SummaryResult> => {
      calls += 1;
      return calls === 1
        ? { status: 'unreachable', summary: null }
        : { status: 'ok', summary: 'It worked on retry.' };
    };
    renderWithProviders(<ArticleSummary id={ITEM_ID} online autoGenerate />, { source });

    const errorCard = await screen.findByTestId('article-summary-error');
    expect(errorCard).toHaveTextContent('Could not summarize.');

    await userEvent.click(screen.getByTestId('article-summary-retry'));
    const body = await screen.findByTestId('article-summary-body');
    expect(body.textContent).toBe('It worked on retry.');
    expect(calls).toBe(2);
    expect(screen.queryByTestId('article-summary-error')).not.toBeInTheDocument();
  });

  it('explains a missing summary on a pinned article opened offline', async () => {
    // Pinned articles promise a prewarmed summary; offline with nothing cached
    // the card says so instead of rendering nothing. No fetch is attempted.
    const source = new MockDataSource(`test-${Math.random()}`);
    let called = false;
    source.getSummary = async (): Promise<SummaryResult> => {
      called = true;
      return { status: 'ok', summary: 'should not be fetched' };
    };
    renderWithProviders(
      <ArticleSummary id={ITEM_ID} online={false} autoGenerate />,
      { source },
    );
    const offline = await screen.findByTestId('article-summary-offline');
    expect(offline).toHaveTextContent('Summary not available offline.');
    expect(called).toBe(false);
    expect(screen.queryByTestId('article-summary-retry')).not.toBeInTheDocument();
  });

  it('re-offers the Generate button over a cached `unavailable` (key configured later)', async () => {
    // An `unavailable` cached while GOOGLE_API_KEY was unset must not freeze the
    // article summaryless forever: on a later unpinned open the Generate button
    // comes back (matching the first-open behavior an unconfigured deployment
    // shows anyway), so once the operator sets the key one click recovers it.
    const source = new MockDataSource(`test-${Math.random()}`);
    let called = false;
    source.getSummary = async (): Promise<SummaryResult> => {
      called = true;
      return { status: 'ok', summary: 'Works now that the key is set.' };
    };
    const queryClient = new QueryClient();
    queryClient.setQueryData(['summary', ITEM_ID], {
      status: 'unavailable',
      summary: null,
    } satisfies SummaryResult);
    renderWithProviders(
      <ArticleSummary id={ITEM_ID} online autoGenerate={false} />,
      { source, queryClient },
    );

    const button = await screen.findByTestId('article-summary-generate');
    expect(called).toBe(false); // the button itself spends nothing
    await userEvent.click(button);
    const body = await screen.findByTestId('article-summary-body');
    expect(body.textContent).toBe('Works now that the key is set.');
    expect(called).toBe(true);
  });

  it('stays silent when the service is not configured (unavailable)', async () => {
    // `unavailable` (GOOGLE_API_KEY unset) is an operator condition, not a
    // user-actionable one — Retry would not help, so the card stays silent by
    // design, unlike the transient `unreachable`.
    const source = new MockDataSource(`test-${Math.random()}`);
    source.getSummary = async (): Promise<SummaryResult> => ({
      status: 'unavailable',
      summary: null,
    });
    renderWithProviders(<ArticleSummary id={ITEM_ID} online autoGenerate />, { source });
    await waitFor(() =>
      expect(screen.queryByTestId('article-summary-loading')).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId('article-summary-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('article-summary-body')).not.toBeInTheDocument();
  });
});
