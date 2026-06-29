import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import { ArticleSummary } from './ArticleSummary';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { SummaryResult } from '../lib/summary';

const ITEM_ID = 'item-1';

describe('ArticleSummary', () => {
  it('shows the AI summary once it resolves for an opened article', async () => {
    renderWithProviders(<ArticleSummary id={ITEM_ID} online />);
    const body = await screen.findByTestId('article-summary-body');
    expect(body.textContent).toMatch(/one sentence/i);
    expect(screen.getByText('Summary by Gemini')).toBeInTheDocument();
  });

  it('shows for an unpinned article — pinning is not required (allowlist-only)', async () => {
    // The item is never pinned; an allowlisted user still gets the summary.
    renderWithProviders(<ArticleSummary id={ITEM_ID} online />);
    expect(await screen.findByTestId('article-summary-body')).toBeInTheDocument();
  });

  it('does not call the summary endpoint while offline', () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    let called = false;
    const orig = source.getSummary.bind(source);
    source.getSummary = (id) => {
      called = true;
      return orig(id);
    };
    renderWithProviders(<ArticleSummary id={ITEM_ID} online={false} />, {
      source,
    });
    expect(screen.queryByTestId('article-summary')).not.toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('stays silent on a soft failure (e.g. off-allowlist / nothing to summarize)', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.getSummary = async (): Promise<SummaryResult> => ({
      status: 'empty',
      summary: null,
      retryable: true,
    });
    renderWithProviders(<ArticleSummary id={ITEM_ID} online />, { source });
    // Give the (resolved-empty) query a chance to settle, then assert no card.
    await waitFor(() =>
      expect(screen.queryByTestId('article-summary-body')).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('Summary by Gemini')).not.toBeInTheDocument();
  });
});
