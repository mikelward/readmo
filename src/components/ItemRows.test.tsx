import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemRows } from './ItemRows';
import { MarkUnread } from './icons';
import { MockDataSource } from '../lib/data/MockDataSource';
import {
  SHOW_ROW_FAVICON_KEY,
  resetReadingPrefsCacheForTest,
} from '../hooks/useReadingPrefs';
import type { FeedItem } from '../lib/types';

async function sampleItems(n = 3): Promise<FeedItem[]> {
  const source = new MockDataSource(`test-${Math.random()}`);
  const page = await source.getHomeItems();
  return page.items.slice(0, n);
}

/** Turn the off-by-default "show feed icons on articles" setting on for a test
 * before rendering, so non-grouped rows render their favicon. */
function enableRowFavicons(): void {
  window.localStorage.setItem(SHOW_ROW_FAVICON_KEY, '1');
  resetReadingPrefsCacheForTest();
}

function withFavicon(items: FeedItem[]): FeedItem[] {
  return items.map((fi) => ({
    ...fi,
    feed: { ...fi.feed, faviconUrl: 'https://example.com/favicon.ico' },
  }));
}

describe('ItemRows', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });
  afterEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });

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

    // Each header precedes its keyed row in document order (the header and the
    // row now live in the same section container, header first).
    const firstRow = container.querySelector(
      `[data-item-id="${items[0].item.id}"]`,
    )!;
    expect(
      headerEls[0].compareDocumentPosition(firstRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(headerEls).toHaveLength(2);
  });

  it('renders the feed favicon to the left of the name when provided', async () => {
    const items = await sampleItems(2);
    const headers = new Map([
      [
        items[0].item.id,
        {
          feedId: items[0].item.feedId,
          title: 'Iconned Feed',
          faviconUrl: 'https://example.com/favicon.ico',
        },
      ],
      // No favicon → no <img> for this section.
      [items[1].item.id, { feedId: items[1].item.feedId, title: 'Plain Feed' }],
    ]);
    const { container } = renderWithProviders(
      <ItemRows items={items} emptyLabel="Nothing here." groupHeaders={headers} />,
    );
    const favicons = container.querySelectorAll<HTMLImageElement>(
      '.item-list__group-favicon',
    );
    expect(favicons).toHaveLength(1);
    expect(favicons[0]).toHaveAttribute('src', 'https://example.com/favicon.ico');
    // Decorative: empty alt + aria-hidden so it isn't announced or focusable.
    expect(favicons[0]).toHaveAttribute('alt', '');
    expect(favicons[0]).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows no per-row favicon in the flat view by default (setting off)', async () => {
    const items = withFavicon(await sampleItems(2));
    const { container } = renderWithProviders(
      <ItemRows items={items} emptyLabel="Nothing here." />,
    );
    expect(container.querySelectorAll('.item-row__favicon')).toHaveLength(0);
  });

  it('shows a per-row favicon in the flat view when the setting is on', async () => {
    enableRowFavicons();
    const items = withFavicon(await sampleItems(2));
    const { container } = renderWithProviders(
      <ItemRows items={items} emptyLabel="Nothing here." />,
    );
    const favicons = container.querySelectorAll<HTMLImageElement>('.item-row__favicon');
    expect(favicons).toHaveLength(2);
    expect(favicons[0]).toHaveAttribute('src', 'https://example.com/favicon.ico');
    expect(favicons[0]).toHaveAttribute('alt', '');
    expect(favicons[0]).toHaveAttribute('aria-hidden', 'true');
  });

  it('omits per-row favicons in group-by-feed view even with the setting on — the header carries the icon', async () => {
    enableRowFavicons();
    const items = withFavicon(await sampleItems(2));
    const headers = new Map([
      [
        items[0].item.id,
        {
          feedId: items[0].item.feedId,
          title: 'Grouped Feed',
          faviconUrl: 'https://example.com/favicon.ico',
        },
      ],
    ]);
    const { container } = renderWithProviders(
      <ItemRows items={items} emptyLabel="Nothing here." groupHeaders={headers} />,
    );
    expect(container.querySelectorAll('.item-row__favicon')).toHaveLength(0);
    expect(
      container.querySelectorAll('.item-list__group-favicon').length,
    ).toBeGreaterThan(0);
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
