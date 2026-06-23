import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { FeedItem } from '../lib/types';
import type { FullTextResult } from '../lib/fullText';
import { ItemPage } from './ItemPage';

function renderReader(source: MockDataSource, id = 'item-1') {
  return renderWithProviders(
    <Routes>
      <Route path="/item/:id" element={<ItemPage />} />
    </Routes>,
    { source, route: `/item/${id}` },
  );
}

describe('ItemPage (reader)', () => {
  it('renders the article and marks it opened on view', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    await screen.findByTestId('open-original');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    await waitFor(() => {
      expect(source.stateStore.get('item-1').opened).toBe(true);
    });
  });

  it('pins from the reader action bar', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    const pin = await screen.findByTestId('reader-pin');
    await user.click(pin);
    expect(source.stateStore.get('item-1').pinned).toBe(true);
  });

  it('renders the toolbar at the bottom too and pins from it', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    const pin = await screen.findByTestId('reader-pin-bottom');
    expect(screen.getByTestId('open-original-bottom')).toBeInTheDocument();
    await user.click(pin);
    expect(source.stateStore.get('item-1').pinned).toBe(true);
  });

  it('renders the toolbar at the bottom with a back-to-top button and pins from it', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    const pin = await screen.findByTestId('reader-pin-bottom');
    expect(screen.getByTestId('open-original-bottom')).toBeInTheDocument();
    expect(screen.getByTestId('reader-back-to-top')).toBeInTheDocument();
    await user.click(pin);
    expect(source.stateStore.get('item-1').pinned).toBe(true);
  });

  it('Done marks the item done and clears pinned (exclusivity)', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true);
    renderReader(source);
    const done = await screen.findByTestId('reader-done');
    await user.click(done);
    const state = source.stateStore.get('item-1');
    expect(state.done).toBe(true);
    expect(state.pinned).toBe(false);
  });
});

describe('ItemPage reading mode', () => {
  it('auto-fetches the full article for a truncated feed body and shows a toggle', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    // The seed item-1 body is a short stub, so reading mode is fetched
    // automatically and its (fuller) body is shown by default.
    await screen.findByText(/full article text/);
    // A toggle appears to flip back to the feed's own body.
    expect(await screen.findByTestId('reader-view-toggle')).toHaveTextContent(
      'Show feed version',
    );
  });

  it('toggles between the reading view and the feed version', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderReader(source);
    await screen.findByText(/full article text/);
    const toggle = screen.getByTestId('reader-view-toggle');

    await user.click(toggle); // → feed version
    expect(screen.queryByText(/full article text/)).not.toBeInTheDocument();
    // The original feed body is still present.
    expect(screen.getByText(/visible creases/)).toBeInTheDocument();
    expect(toggle).toHaveTextContent('Show reading view');

    await user.click(toggle); // → reading view again
    expect(await screen.findByText(/full article text/)).toBeInTheDocument();
  });

  it('falls back to the feed body and explains when the article needs sign-in', async () => {
    class AuthSource extends MockDataSource {
      async fetchFullText(): Promise<FullTextResult> {
        return { status: 'auth', contentHtml: null };
      }
    }
    const source = new AuthSource(`test-${Math.random()}`);
    renderReader(source);
    const note = await screen.findByTestId('fulltext-error');
    expect(note).toHaveTextContent(/sign in/i);
    // The feed body is still rendered so the reader isn't left empty.
    expect(screen.getByText(/visible creases/)).toBeInTheDocument();
  });

  it('offers a retry for a transient failure and recovers on retry', async () => {
    const user = userEvent.setup();
    class FlakySource extends MockDataSource {
      calls = 0;
      async fetchFullText(): Promise<FullTextResult> {
        this.calls += 1;
        return this.calls === 1
          ? { status: 'unreachable', contentHtml: null }
          : { status: 'ok', contentHtml: '<p>recovered full body</p>' };
      }
    }
    const source = new FlakySource(`test-${Math.random()}`);
    renderReader(source);
    // First attempt failed transiently: feed body stays, a retry is offered.
    const retry = await screen.findByTestId('fulltext-retry');
    expect(screen.getByText(/visible creases/)).toBeInTheDocument();

    await user.click(retry);
    expect(await screen.findByText(/recovered full body/)).toBeInTheDocument();
  });

  it('offers a manual "Get full article" control for an untruncated feed', async () => {
    const user = userEvent.setup();
    // A feed item whose own body is already long enough not to look truncated.
    class LongBodySource extends MockDataSource {
      async getItem(id: string): Promise<FeedItem | null> {
        const fi = await super.getItem(id);
        if (fi) {
          fi.item = { ...fi.item, contentHtml: `<p>${'plenty of words '.repeat(60)}</p>` };
        }
        return fi;
      }
    }
    const source = new LongBodySource(`test-${Math.random()}`);
    renderReader(source);
    const get = await screen.findByTestId('fulltext-get');
    // No auto-fetch happened — the toggle isn't present yet.
    expect(screen.queryByTestId('reader-view-toggle')).not.toBeInTheDocument();

    await user.click(get);
    expect(await screen.findByText(/full article text/)).toBeInTheDocument();
  });
});
