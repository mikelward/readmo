import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { FeedItem } from '../lib/types';
import { SearchPage } from './SearchPage';

// Search results resolve only when the test releases them, so the in-flight
// window (the state under test) is held open deterministically.
class GatedSearchSource extends MockDataSource {
  resolvers: Array<(items: FeedItem[]) => void> = [];
  override search(): Promise<FeedItem[]> {
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }
}

async function seedItem(): Promise<FeedItem> {
  const seed = new MockDataSource(`seed-${Math.random()}`);
  const fi = await seed.getItem('item-1');
  if (!fi) throw new Error('seed item missing');
  return fi;
}

describe('SearchPage', () => {
  it('shows the loading state, never "No matches.", while a search is in flight', async () => {
    const source = new GatedSearchSource(`test-${Math.random()}`);
    renderWithProviders(<SearchPage />, { route: '/search', source });

    fireEvent.change(screen.getByLabelText('Search'), {
      target: { value: 'phone' },
    });

    // In flight: the page must not affirmatively claim there are no matches.
    expect(screen.queryByText('No matches.')).toBeNull();
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    const item = await seedItem();
    await act(async () => source.resolvers[0]([item]));
    expect(await screen.findByText(item.item.title)).toBeInTheDocument();
  });

  it('keeps the previous results on screen while the next keystroke fetches', async () => {
    const source = new GatedSearchSource(`test-${Math.random()}`);
    renderWithProviders(<SearchPage />, { route: '/search', source });
    const input = screen.getByLabelText('Search');

    fireEvent.change(input, { target: { value: 'phone' } });
    const item = await seedItem();
    await act(async () => source.resolvers[0]([item]));
    expect(await screen.findByText(item.item.title)).toBeInTheDocument();

    // Narrow the query: while the new fetch is in flight the previous results
    // stay visible — no "No matches." flash, no blanking.
    fireEvent.change(input, { target: { value: 'phones' } });
    expect(screen.getByText(item.item.title)).toBeInTheDocument();
    expect(screen.queryByText('No matches.')).toBeNull();

    // Only a SETTLED empty result may claim there are no matches.
    await act(async () => source.resolvers[1]([]));
    expect(await screen.findByText('No matches.')).toBeInTheDocument();
  });

  it('does not let an empty settled result claim "No matches." for the next in-flight search', async () => {
    // keepPreviousData carries the empty array forward as a "successful"
    // placeholder (isLoading false), so the empty state must also gate on the
    // fetching/placeholder status.
    const source = new GatedSearchSource(`test-${Math.random()}`);
    renderWithProviders(<SearchPage />, { route: '/search', source });
    const input = screen.getByLabelText('Search');

    fireEvent.change(input, { target: { value: 'zzzz' } });
    await act(async () => source.resolvers[0]([]));
    expect(await screen.findByText('No matches.')).toBeInTheDocument();

    // Edit the query: the new search is in flight, so the settled miss of the
    // PREVIOUS query must not be presented as this one's result.
    fireEvent.change(input, { target: { value: 'phone' } });
    expect(screen.queryByText('No matches.')).toBeNull();
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    const item = await seedItem();
    await act(async () => source.resolvers[1]([item]));
    expect(await screen.findByText(item.item.title)).toBeInTheDocument();
  });
});
