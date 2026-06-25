import { describe, expect, it, vi } from 'vitest';
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

  it('renders a static group header before the item it is keyed to', async () => {
    const items = await sampleItems(3);
    const headers = new Map([
      [items[0].item.id, { feedId: items[0].item.feedId, title: 'First Feed' }],
      [items[2].item.id, { feedId: items[2].item.feedId, title: 'Second Feed' }],
    ]);
    const { container } = renderWithProviders(
      <ItemRows items={items} emptyLabel="Nothing here." groupHeaders={headers} />,
    );
    const headerEls = container.querySelectorAll('.item-list__group-header');
    expect([...headerEls].map((el) => el.textContent)).toEqual([
      'First Feed',
      'Second Feed',
    ]);
    // No toggle handler → a static, decorative label (no button).
    expect(container.querySelector('[data-testid="group-toggle"]')).toBeNull();

    // Each header sits immediately before its keyed row in document order.
    const firstRow = container.querySelector(
      `[data-item-id="${items[0].item.id}"]`,
    );
    expect(headerEls[0].nextElementSibling).toBe(firstRow);
    expect(headerEls).toHaveLength(2);
  });

  it('renders a header toggle button and reports clicks (collapsible)', async () => {
    const items = await sampleItems(2);
    const onToggle = vi.fn();
    const headers = new Map([
      [items[0].item.id, { feedId: items[0].item.feedId, title: 'Alpha Feed' }],
    ]);
    renderWithProviders(
      <ItemRows
        items={items}
        emptyLabel="Nothing here."
        groupHeaders={headers}
        collapsedFeeds={new Set()}
        onToggleCollapse={onToggle}
      />,
    );
    const toggle = screen.getByTestId('group-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleName(/Alpha Feed: collapse feed/);
    await userEvent.setup().click(toggle);
    expect(onToggle).toHaveBeenCalledWith(items[0].item.feedId);
  });

  it('hides the rows of a collapsed feed but keeps its header', async () => {
    const items = await sampleItems(3); // three distinct seed feeds
    const headers = new Map(
      items.map((fi) => [fi.item.id, { feedId: fi.item.feedId, title: fi.feed.title }]),
    );
    const collapsedFeed = items[0].item.feedId;
    const { container } = renderWithProviders(
      <ItemRows
        items={items}
        emptyLabel="Nothing here."
        groupHeaders={headers}
        collapsedFeeds={new Set([collapsedFeed])}
        onToggleCollapse={vi.fn()}
      />,
    );
    // All three headers still render…
    expect(container.querySelectorAll('.item-list__group-header')).toHaveLength(3);
    // …but the collapsed feed's row is gone, while the others remain.
    expect(
      container.querySelector(`[data-item-id="${items[0].item.id}"]`),
    ).toBeNull();
    expect(
      container.querySelector(`[data-item-id="${items[1].item.id}"]`),
    ).not.toBeNull();
    // The collapsed header is marked and its toggle reads aria-expanded=false.
    const collapsedHeader = container.querySelector(
      '.item-list__group-header--collapsed',
    );
    expect(collapsedHeader).not.toBeNull();
    expect(
      collapsedHeader!.querySelector('[data-testid="group-toggle"]'),
    ).toHaveAttribute('aria-expanded', 'false');
  });
});
