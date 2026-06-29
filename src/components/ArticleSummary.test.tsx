import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import { ArticleSummary } from './ArticleSummary';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { SummaryResult } from '../lib/summary';

const ITEM_ID = 'item-1';

describe('ArticleSummary', () => {
  it('shows the AI summary once it resolves when the item is pinned', async () => {
    renderWithProviders(<ArticleSummary id={ITEM_ID} pinned online />);
    const body = await screen.findByTestId('article-summary-body');
    expect(body.textContent).toMatch(/one sentence/i);
    expect(screen.getByText('Summary by Gemini')).toBeInTheDocument();
  });

  it('renders nothing when the item is not pinned (no summary call)', () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    let called = false;
    const orig = source.getSummary.bind(source);
    source.getSummary = (id) => {
      called = true;
      return orig(id);
    };
    renderWithProviders(<ArticleSummary id={ITEM_ID} pinned={false} online />, {
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
    renderWithProviders(<ArticleSummary id={ITEM_ID} pinned online />, { source });
    // Give the (resolved-empty) query a chance to settle, then assert no card.
    await waitFor(() =>
      expect(screen.queryByTestId('article-summary-body')).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('Summary by Gemini')).not.toBeInTheDocument();
  });
});
