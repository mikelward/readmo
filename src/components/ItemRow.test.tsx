import { afterEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemRow } from './ItemRow';
import { PushPinFilled } from './icons';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { FeedItem } from '../lib/types';

function stubWideViewport(wide: boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width: 960px') ? wide : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

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
    fullContentHtml: null,
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
  let restoreMatchMedia: (() => void) | null = null;
  afterEach(() => {
    restoreMatchMedia?.();
    restoreMatchMedia = null;
  });

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

  it('does not render the wide-viewport Done button on narrow screens', () => {
    restoreMatchMedia = stubWideViewport(false);
    renderWithProviders(<ItemRow feedItem={FEED_ITEM} />);
    expect(screen.queryByTestId('done-btn')).not.toBeInTheDocument();
  });

  it('renders a wide-viewport Done button next to Pin on feed rows', async () => {
    restoreMatchMedia = stubWideViewport(true);
    const user = userEvent.setup();
    const { source } = renderWithProviders(<ItemRow feedItem={FEED_ITEM} />);
    const done = screen.getByTestId('done-btn');
    expect(done).toHaveAttribute('aria-pressed', 'false');
    // Sits before the Pin button in DOM order (left of it visually).
    const buttons = screen.getAllByRole('button');
    const doneIdx = buttons.indexOf(done);
    const pinIdx = buttons.indexOf(screen.getByTestId('pin-btn'));
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeLessThan(pinIdx);

    await user.click(done);
    expect(source.stateStore.get('item-1').done).toBe(true);
    expect(screen.getByTestId('done-btn')).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByTestId('done-btn'));
    expect(source.stateStore.get('item-1').done).toBe(false);
  });

  it('hides the wide-viewport Done button on library views (rightAction wins)', () => {
    restoreMatchMedia = stubWideViewport(true);
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(
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
      { source },
    );
    expect(screen.queryByTestId('done-btn')).not.toBeInTheDocument();
  });

  it('suppresses Done in the menu on a pinned row', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    source.stateStore.set('item-1', 'pinned', true);
    renderWithProviders(
      <ItemRow feedItem={FEED_ITEM} enableSwipe={false} onShare={() => {}} />,
      { source },
    );
    const body = screen.getByTestId('item-title');
    body.focus();
    await user.keyboard(' ');
    const menu = await screen.findByTestId('item-row-menu');
    // Pinned rows show Unpin instead of Pin, and Done is suppressed
    // (marking done clears pinned, which would silently unpin the item).
    expect(within(menu).getByTestId('item-row-menu-unpin')).toBeInTheDocument();
    expect(within(menu).queryByTestId('item-row-menu-hide')).toBeNull();
    // Share is still available.
    expect(within(menu).getByTestId('item-row-menu-share')).toBeInTheDocument();
  });
});
