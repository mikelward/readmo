import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemRow } from './ItemRow';
import { PushPinFilled } from './icons';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { FeedItem } from '../lib/types';

const FEED_ITEM: FeedItem = {
  item: {
    id: 'item-1',
    feedId: 'feed-1',
    guid: 'g1',
    url: 'https://example.com/post',
    title: 'A test headline',
    author: 'Jane Doe',
    publishedAt: Date.now() - 2 * 60 * 60 * 1000,
    contentHtml: '<p>Body</p>',
    summary: null,
    enclosures: [],
  },
  feed: {
    id: 'feed-1',
    url: 'https://example.com/feed',
    siteUrl: 'https://example.com',
    title: 'Example Blog',
    faviconUrl: null,
    errorCount: 0,
    lastError: null,
    parked: false,
  },
};

describe('ItemRow', () => {
  it('renders the title and display-only meta (source · age · author)', () => {
    renderWithProviders(<ItemRow feedItem={FEED_ITEM} />);
    expect(screen.getByTestId('item-title')).toHaveTextContent('A test headline');
    const meta = screen.getByTestId('item-meta');
    expect(meta).toHaveTextContent('Example Blog');
    expect(meta).toHaveTextContent('Jane Doe');
    expect(meta).toHaveTextContent('2h');
  });

  it('toggles Pin via the right-side button and reflects aria-pressed', async () => {
    const user = userEvent.setup();
    const { source } = renderWithProviders(<ItemRow feedItem={FEED_ITEM} />);
    const pin = screen.getByTestId('pin-btn');
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    await user.click(pin);
    expect(source.stateStore.get('item-1').pinned).toBe(true);
    expect(screen.getByTestId('pin-btn')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shields a pinned row: swipe hints read "Pinned" on both edges', () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true);
    renderWithProviders(<ItemRow feedItem={FEED_ITEM} />, { source });
    expect(screen.getByTestId('swipe-hint-pinned-left')).toBeInTheDocument();
    expect(screen.getByTestId('swipe-hint-pinned-right')).toBeInTheDocument();
  });

  it('renders a library inverse action instead of the pin button', async () => {
    const user = userEvent.setup();
    const { source } = renderWithProviders(
      <ItemRow
        feedItem={FEED_ITEM}
        enableSwipe={false}
        rightAction={{
          label: 'Unpin',
          icon: <PushPinFilled />,
          testId: 'library-action-pinned',
          onToggle: () => source.stateStore.set('item-1', 'pinned', false),
        }}
      />,
    );
    expect(screen.queryByTestId('pin-btn')).not.toBeInTheDocument();
    const btn = screen.getByTestId('library-action-pinned');
    expect(btn).toHaveAttribute('aria-label', 'Unpin');
    await user.click(btn);
    expect(source.stateStore.get('item-1').pinned).toBe(false);
  });

  it('opens the row menu and exposes Pin/Hide actions', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ItemRow feedItem={FEED_ITEM} />);
    const body = screen.getByTestId('item-title');
    body.focus();
    await user.keyboard(' '); // Space opens the row menu
    const menu = await screen.findByTestId('item-row-menu');
    expect(within(menu).getByTestId('item-row-menu-pin')).toBeInTheDocument();
    expect(within(menu).getByTestId('item-row-menu-hide')).toBeInTheDocument();
  });

  it('suppresses Pin and Hide in the menu on a hidden row', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'hidden', true);
    renderWithProviders(
      <ItemRow feedItem={FEED_ITEM} enableSwipe={false} onShare={() => {}} />,
      { source },
    );
    const body = screen.getByTestId('item-title');
    body.focus();
    await user.keyboard(' ');
    const menu = await screen.findByTestId('item-row-menu');
    // Pinning a hidden row would clear `hidden` and reintroduce the item —
    // suppressed per the hide-shields-pin rule.
    expect(within(menu).queryByTestId('item-row-menu-pin')).toBeNull();
    expect(within(menu).queryByTestId('item-row-menu-hide')).toBeNull();
    // Share is still available.
    expect(within(menu).getByTestId('item-row-menu-share')).toBeInTheDocument();
  });
});
