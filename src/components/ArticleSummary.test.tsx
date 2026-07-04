import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { ArticleSummary } from './ArticleSummary';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { SummaryResult } from '../lib/summary';

const ITEM_ID = 'item-1';

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
});
