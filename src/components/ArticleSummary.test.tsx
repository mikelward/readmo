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
