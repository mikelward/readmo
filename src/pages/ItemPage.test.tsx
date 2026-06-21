import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
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
