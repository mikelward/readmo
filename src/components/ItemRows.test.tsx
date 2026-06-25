import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemRows } from './ItemRows';
import { MarkUnread } from './icons';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { FeedItem } from '../lib/types';

async function sampleItems(n = 3): Promise<FeedItem[]> {
  const source = new MockDataSource(`test-${Math.random()}`);
  const page = await source.getHomeItems();
  return page.items.slice(0, n);
}

describe('ItemRows', () => {
  it('shows skeletons while loading and no rows or empty state', () => {
    const { container } = renderWithProviders(
      <ItemRows items={[]} isLoading emptyLabel="Nothing here." />,
    );
    expect(container.querySelectorAll('.item-list__skeleton').length).toBeGreaterThan(0);
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('item-row')).toHaveLength(0);
  });

  it('renders the empty label when there are no items', () => {
    renderWithProviders(<ItemRows items={[]} emptyLabel="Nothing here." />);
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });

  it('renders a row per item', async () => {
    const items = await sampleItems(3);
    renderWithProviders(<ItemRows items={items} emptyLabel="Nothing here." />);
    expect(screen.getAllByTestId('item-row')).toHaveLength(3);
  });

  it('wires a per-item right action', async () => {
    const user = userEvent.setup();
    const items = await sampleItems(1);
    const toggled: string[] = [];
    renderWithProviders(
      <ItemRows
        items={items}
        emptyLabel="Nothing here."
        rightAction={(fi) => ({
          label: 'Mark unread',
          icon: <MarkUnread />,
          testId: 'row-action',
          onToggle: () => toggled.push(fi.item.id),
        })}
      />,
    );
    await user.click(screen.getByTestId('row-action'));
    expect(toggled).toEqual([items[0].item.id]);
  });

  it('renders a group header before the item it is keyed to (group-by-feed)', async () => {
    const items = await sampleItems(3);
    const headers = new Map<string, string>([
      [items[0].item.id, 'First Feed'],
      [items[2].item.id, 'Second Feed'],
    ]);
    const { container } = renderWithProviders(
      <ItemRows items={items} emptyLabel="Nothing here." groupHeaders={headers} />,
    );
    const headerEls = container.querySelectorAll('.item-list__group-header');
    expect([...headerEls].map((el) => el.textContent)).toEqual([
      'First Feed',
      'Second Feed',
    ]);
    // Decorative (the feed name is also on each row's meta line).
    expect(headerEls[0]).toHaveAttribute('aria-hidden', 'true');

    // Each header sits immediately before its keyed row in document order.
    const firstHeader = headerEls[0];
    const firstRow = container.querySelector(
      `[data-item-id="${items[0].item.id}"]`,
    );
    expect(firstHeader.nextElementSibling).toBe(firstRow);

    // A row with no header entry doesn't get one.
    expect(container.querySelectorAll('.item-list__group-header')).toHaveLength(2);
  });
});
