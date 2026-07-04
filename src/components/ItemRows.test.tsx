import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemRows } from './ItemRows';
import { MarkUnread } from './icons';
import { MockDataSource } from '../lib/data/MockDataSource';
import {
  SHOW_ROW_FAVICON_KEY,
  SHOW_GROUP_FAVICON_KEY,
  resetReadingPrefsCacheForTest,
} from '../hooks/useReadingPrefs';
import type { FeedItem } from '../lib/types';

async function sampleItems(n = 3): Promise<FeedItem[]> {
  const source = new MockDataSource(`test-${Math.random()}`);
  const page = await source.getHomeItems();
  return page.items.slice(0, n);
}

/** Turn the off-by-default "show icons on articles" setting on for a test
 * before rendering, so non-grouped rows render their favicon. */
function enableRowFavicons(): void {
  window.localStorage.setItem(SHOW_ROW_FAVICON_KEY, '1');
  resetReadingPrefsCacheForTest();
}

/** Turn the on-by-default "show icons on groups" setting off for a test before
 * rendering, so group headers omit their favicon. */
function disableGroupFavicons(): void {
  window.localStorage.setItem(SHOW_GROUP_FAVICON_KEY, '0');
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

  it('shows a labeled loading indicator while loading, not rows or the empty state', () => {
    renderWithProviders(
      <ItemRows items={[]} isLoading emptyLabel="Nothing here." />,
    );
    const loading = screen.getByTestId('loading-state');
    expect(loading).toHaveTextContent(/loading/i);
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
    // Read the name element specifically: the header also holds a decorative,
    // aria-hidden initials badge whose letters would otherwise join textContent.
    const names = container.querySelectorAll('.item-list__group-header .item-list__group-title');
    expect([...names].map((el) => el.textContent)).toEqual([
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
      'img.item-list__group-favicon',
    );
    expect(favicons).toHaveLength(1);
    expect(favicons[0]).toHaveAttribute('src', 'https://example.com/favicon.ico');
    // Decorative: empty alt + aria-hidden so it isn't announced or focusable.
    expect(favicons[0]).toHaveAttribute('alt', '');
    expect(favicons[0]).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws an initials badge for a header without its own icon', async () => {
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
      // No favicon of its own → its initials badge fills the slot so its name
      // lines up with the iconned sibling above (no blank placeholder).
      [items[1].item.id, { feedId: items[1].item.feedId, title: 'Plain Feed' }],
    ]);
    const { container } = renderWithProviders(
      <ItemRows items={items} emptyLabel="Nothing here." groupHeaders={headers} />,
    );
    // The iconned feed shows a real <img>; the plain one an initials badge.
    expect(container.querySelectorAll('img.item-list__group-favicon')).toHaveLength(1);
    const badge = container.querySelector('.item-list__group-favicon.favicon--initials');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('PF');
    expect(
      container.querySelectorAll('.item-list__group-favicon-placeholder'),
    ).toHaveLength(0);
  });

  it('omits group-header favicons (and the reserved slot) when "show icons on groups" is off', async () => {
    disableGroupFavicons();
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
      [items[1].item.id, { feedId: items[1].item.feedId, title: 'Plain Feed' }],
    ]);
    const { container } = renderWithProviders(
      <ItemRows items={items} emptyLabel="Nothing here." groupHeaders={headers} />,
    );
    // Neither a real icon nor a reserved placeholder — the setting hides them all.
    expect(container.querySelectorAll('.item-list__group-favicon')).toHaveLength(0);
    expect(
      container.querySelectorAll('.item-list__group-favicon-placeholder'),
    ).toHaveLength(0);
    // The section still renders its header + rows.
    expect(container.querySelectorAll('.item-list__group-header')).toHaveLength(2);
  });

  it('falls back to an initials badge when a group favicon fails to load', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const items = await sampleItems(2);
    const headers = new Map([
      [
        items[0].item.id,
        {
          feedId: items[0].item.feedId,
          title: 'Working Icon',
          faviconUrl: 'https://example.com/favicon.ico',
        },
      ],
      // Has a favicon URL, but it 404s / is bot-blocked and won't load — it's
      // replaced by the feed's initials badge (fills the slot, no left snap).
      [
        items[1].item.id,
        {
          feedId: items[1].item.feedId,
          title: 'Broken Icon',
          faviconUrl: 'https://blocked.example/favicon.ico',
        },
      ],
    ]);
    const { container } = renderWithProviders(
      <ItemRows items={items} emptyLabel="Nothing here." groupHeaders={headers} />,
    );
    const broken = container.querySelector<HTMLImageElement>(
      'img.item-list__group-favicon[src="https://blocked.example/favicon.ico"]',
    )!;
    fireEvent.error(broken);
    // The broken img is replaced by the feed's initials badge.
    const badge = container.querySelector('.item-list__group-favicon.favicon--initials');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('BI');
    // The working sibling still shows its real img.
    expect(
      container.querySelector('img.item-list__group-favicon[src="https://example.com/favicon.ico"]'),
    ).not.toBeNull();
  });

  it('draws initials badges (no blank placeholder) for headers with no resolved icon', async () => {
    const items = await sampleItems(2);
    const headers = new Map([
      [items[0].item.id, { feedId: items[0].item.feedId, title: 'First Feed' }],
      [items[1].item.id, { feedId: items[1].item.feedId, title: 'Second Feed' }],
    ]);
    const { container } = renderWithProviders(
      <ItemRows items={items} emptyLabel="Nothing here." groupHeaders={headers} />,
    );
    expect(
      container.querySelectorAll('.item-list__group-favicon-placeholder'),
    ).toHaveLength(0);
    const badges = container.querySelectorAll('.item-list__group-favicon.favicon--initials');
    expect(Array.from(badges).map((b) => b.textContent)).toEqual(['FF', 'SF']);
  });

  it('tags a dark-monochrome group favicon (vox.com) for dark-mode inversion', async () => {
    const items = await sampleItems(2);
    const headers = new Map([
      [
        items[0].item.id,
        {
          feedId: items[0].item.feedId,
          title: 'Vox',
          faviconUrl: 'https://www.vox.com/favicon.ico',
        },
      ],
      // A full-color logo stays untouched — no invert class.
      [
        items[1].item.id,
        {
          feedId: items[1].item.feedId,
          title: 'The Verge',
          faviconUrl: 'https://www.theverge.com/favicon.ico',
        },
      ],
    ]);
    const { container } = renderWithProviders(
      <ItemRows items={items} emptyLabel="Nothing here." groupHeaders={headers} />,
    );
    const favicons = container.querySelectorAll<HTMLImageElement>(
      '.item-list__group-favicon',
    );
    expect(favicons).toHaveLength(2);
    const vox = [...favicons].find((f) => f.src.includes('vox.com'))!;
    const verge = [...favicons].find((f) => f.src.includes('theverge.com'))!;
    expect(vox).toHaveClass('favicon--invert-dark');
    expect(verge).not.toHaveClass('favicon--invert-dark');
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

  it('links the feed name/icon to that feed and does not collapse on tap', async () => {
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
    const link = screen.getByTestId('group-link');
    // Points at the single-feed view for this feed…
    expect(link).toHaveAttribute('href', `/feed/${items[0].item.feedId}`);
    expect(link).toHaveAccessibleName('View Alpha Feed');
    expect(link).toContainElement(screen.getByText('Alpha Feed'));
    // …and tapping the name navigates rather than toggling the section.
    await userEvent.setup().click(link);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('collapses when the space beside the feed name is tapped', async () => {
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
    // The count + whitespace region (aria-hidden, pointer-only) toggles the
    // section, so tapping anywhere on the row that isn't the name or an action
    // still collapses it.
    const rest = screen.getByTestId('group-collapse-rest');
    expect(rest).toHaveAttribute('aria-hidden', 'true');
    // Non-focusable (a plain div, not a button): an aria-hidden control that can
    // still take focus on pointer activation would strand a screen reader on a
    // control removed from the a11y tree. The chevron button is the keyboard/AT
    // collapse control; this region is a pointer-only convenience.
    expect(rest.tagName).toBe('DIV');
    await userEvent.setup().click(rest);
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
