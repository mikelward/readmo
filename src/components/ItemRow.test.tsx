import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
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
    commentsUrl: null,
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

  it('shows the article domain next to the feed name when they differ', () => {
    const aggregatorItem: FeedItem = {
      item: { ...FEED_ITEM.item, url: 'https://www.thedrive.com/news/story' },
      feed: {
        ...FEED_ITEM.feed,
        title: 'Hacker News',
        url: 'https://news.ycombinator.com/rss',
        siteUrl: 'https://news.ycombinator.com',
      },
    };
    renderWithProviders(<ItemRow feedItem={aggregatorItem} />);
    const meta = screen.getByTestId('item-meta');
    expect(meta).toHaveTextContent('Hacker News · thedrive.com');
  });

  it('does not repeat the feed domain for a same-site feed', () => {
    renderWithProviders(<ItemRow feedItem={FEED_ITEM} />);
    const meta = screen.getByTestId('item-meta');
    // example.com article on the example.com feed → no redundant domain.
    expect(meta).toHaveTextContent('Example Blog');
    expect(meta).not.toHaveTextContent('example.com');
  });

  it('links the row body to the in-app reader by default', () => {
    renderWithProviders(<ItemRow feedItem={FEED_ITEM} />);
    const body = screen.getByTestId('item-title');
    expect(body).toHaveAttribute('href', '/item/item-1');
    expect(body).not.toHaveAttribute('target');
  });

  describe('open original', () => {
    it('links the row body straight to the source website in a new tab', () => {
      renderWithProviders(<ItemRow feedItem={FEED_ITEM} openOriginal />);
      const body = screen.getByTestId('item-title');
      expect(body).toHaveAttribute('href', 'https://example.com/post');
      expect(body).toHaveAttribute('target', '_blank');
      expect(body.getAttribute('rel')).toContain('noopener');
    });

    it('marks the item opened (not done) when the row body is tapped', async () => {
      const user = userEvent.setup();
      const { source } = renderWithProviders(
        <ItemRow feedItem={FEED_ITEM} openOriginal />,
      );
      await user.click(screen.getByTestId('item-title'));
      expect(source.stateStore.get('item-1').opened).toBe(true);
      expect(source.stateStore.get('item-1').done).toBe(false);
    });

    it('adds an Open original button to the left of the Pin button', () => {
      renderWithProviders(<ItemRow feedItem={FEED_ITEM} openOriginal />);
      // Pin stays; Open original is added.
      expect(screen.getByTestId('pin-btn')).toBeInTheDocument();
      const openBtn = screen.getByTestId('open-original-btn');
      expect(openBtn).toHaveAttribute('aria-label', 'Open A test headline on its website');
      // Open original sits before Pin in DOM order (to its left).
      const buttons = screen.getAllByRole('button');
      expect(buttons.indexOf(openBtn)).toBeLessThan(
        buttons.indexOf(screen.getByTestId('pin-btn')),
      );
    });

    it('opens the source and marks opened when the Open original button is clicked', async () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      const user = userEvent.setup();
      const { source } = renderWithProviders(
        <ItemRow feedItem={FEED_ITEM} openOriginal />,
      );
      await user.click(screen.getByTestId('open-original-btn'));
      expect(openSpy).toHaveBeenCalledWith(
        'https://example.com/post',
        '_blank',
        'noopener,noreferrer',
      );
      expect(source.stateStore.get('item-1').opened).toBe(true);
      expect(source.stateStore.get('item-1').done).toBe(false);
      openSpy.mockRestore();
    });

    it('keeps Pin and the wide-viewport Done button alongside Open original', () => {
      restoreMatchMedia = stubWideViewport(true);
      renderWithProviders(<ItemRow feedItem={FEED_ITEM} openOriginal />);
      expect(screen.getByTestId('done-btn')).toBeInTheDocument();
      expect(screen.getByTestId('pin-btn')).toBeInTheDocument();
      expect(screen.getByTestId('open-original-btn')).toBeInTheDocument();
    });

    it('keeps the library inverse action (no Open original button) on library rows', () => {
      renderWithProviders(
        <ItemRow
          feedItem={FEED_ITEM}
          openOriginal
          enableSwipe={false}
          rightAction={{
            label: 'Unpin',
            icon: <PushPinFilled />,
            testId: 'library-action-pinned',
            onToggle: () => {},
          }}
        />,
      );
      // The row body still opens the source…
      expect(screen.getByTestId('item-title')).toHaveAttribute('target', '_blank');
      // …but the contextual right-side action is preserved, not replaced.
      expect(screen.getByTestId('library-action-pinned')).toBeInTheDocument();
      expect(screen.queryByTestId('open-original-btn')).not.toBeInTheDocument();
    });

    it('falls back to the in-app reader when the item URL is not a safe http URL', () => {
      const feedItem: FeedItem = {
        ...FEED_ITEM,
        item: { ...FEED_ITEM.item, url: 'javascript:alert(1)' },
      };
      renderWithProviders(<ItemRow feedItem={feedItem} openOriginal />);
      const body = screen.getByTestId('item-title');
      expect(body).toHaveAttribute('href', '/item/item-1');
      expect(body).not.toHaveAttribute('target');
      // No safe URL ⇒ no Open-original button either; the Pin button stays.
      expect(screen.queryByTestId('open-original-btn')).not.toBeInTheDocument();
      expect(screen.getByTestId('pin-btn')).toBeInTheDocument();
    });
  });

  describe('open on newshacker', () => {
    // A Hacker News feed item: guid is the HN discussion link, url the article.
    const HN_FEED_ITEM: FeedItem = {
      item: {
        ...FEED_ITEM.item,
        guid: 'https://news.ycombinator.com/item?id=42662903',
        url: 'https://example.com/the-article',
      },
      feed: {
        ...FEED_ITEM.feed,
        url: 'https://news.ycombinator.com/rss',
        siteUrl: 'https://news.ycombinator.com',
        title: 'Hacker News',
      },
    };

    it('links the row body to the newshacker discussion in a new tab', () => {
      renderWithProviders(<ItemRow feedItem={HN_FEED_ITEM} openNewshacker />);
      const body = screen.getByTestId('item-title');
      expect(body).toHaveAttribute('href', 'https://newshacker.app/item/42662903');
      expect(body).toHaveAttribute('target', '_blank');
      expect(body.getAttribute('rel')).toContain('noopener');
    });

    it('adds an Open-on-newshacker button (not the open-original one)', () => {
      renderWithProviders(<ItemRow feedItem={HN_FEED_ITEM} openNewshacker />);
      const btn = screen.getByTestId('open-newshacker-btn');
      expect(btn).toHaveAttribute('aria-label', 'Open A test headline on newshacker');
      expect(screen.queryByTestId('open-original-btn')).not.toBeInTheDocument();
      expect(screen.getByTestId('pin-btn')).toBeInTheDocument();
    });

    it('opens the newshacker discussion and marks opened when the button is clicked', async () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      const user = userEvent.setup();
      const { source } = renderWithProviders(
        <ItemRow feedItem={HN_FEED_ITEM} openNewshacker />,
      );
      await user.click(screen.getByTestId('open-newshacker-btn'));
      expect(openSpy).toHaveBeenCalledWith(
        'https://newshacker.app/item/42662903',
        '_blank',
        'noopener,noreferrer',
      );
      expect(source.stateStore.get('item-1').opened).toBe(true);
      expect(source.stateStore.get('item-1').done).toBe(false);
      openSpy.mockRestore();
    });

    it('open original wins when both modes are set (a legacy open_original write)', () => {
      // A current client never sets both (setOpenMode is atomic); the both-true
      // state only comes from a legacy open_original-only client, so the row
      // honors that as "open original" rather than letting stale newshacker win.
      renderWithProviders(
        <ItemRow feedItem={HN_FEED_ITEM} openOriginal openNewshacker />,
      );
      expect(screen.getByTestId('item-title')).toHaveAttribute(
        'href',
        'https://example.com/the-article',
      );
      expect(screen.getByTestId('open-original-btn')).toBeInTheDocument();
      expect(screen.queryByTestId('open-newshacker-btn')).not.toBeInTheDocument();
    });

    it('derives the link from the structured commentsUrl when present', () => {
      // List rows (feed_items RPC) carry comments_url; article link/guid are not
      // HN, so commentsUrl is the only structured source.
      const withComments: FeedItem = {
        item: {
          ...HN_FEED_ITEM.item,
          guid: 'https://example.com/the-article',
          url: 'https://example.com/the-article',
          commentsUrl: 'https://news.ycombinator.com/item?id=42662903',
          contentHtml: '<p>No HN link in the body.</p>',
        },
        feed: HN_FEED_ITEM.feed,
      };
      renderWithProviders(<ItemRow feedItem={withComments} openNewshacker />);
      expect(screen.getByTestId('item-title')).toHaveAttribute(
        'href',
        'https://newshacker.app/item/42662903',
      );
      expect(screen.getByTestId('open-newshacker-btn')).toBeInTheDocument();
    });

    it('derives the link from the stored description HTML for the official HN feed', () => {
      // Official news.ycombinator.com/rss shape: link/guid are the article; the
      // discussion id lives only in the stored description (contentHtml).
      const officialShape: FeedItem = {
        item: {
          ...HN_FEED_ITEM.item,
          guid: 'https://example.com/the-article',
          url: 'https://example.com/the-article',
          contentHtml:
            '<a href="https://news.ycombinator.com/item?id=44390000">Comments</a>',
        },
        feed: HN_FEED_ITEM.feed,
      };
      renderWithProviders(<ItemRow feedItem={officialShape} openNewshacker />);
      expect(screen.getByTestId('item-title')).toHaveAttribute(
        'href',
        'https://newshacker.app/item/44390000',
      );
      expect(screen.getByTestId('open-newshacker-btn')).toBeInTheDocument();
    });

    it('falls back to the in-app reader when the item has no Hacker News id', () => {
      // A non-HN item (plain guid/url) in newshacker mode can't build a link.
      renderWithProviders(<ItemRow feedItem={FEED_ITEM} openNewshacker />);
      const body = screen.getByTestId('item-title');
      expect(body).toHaveAttribute('href', '/item/item-1');
      expect(body).not.toHaveAttribute('target');
      expect(screen.queryByTestId('open-newshacker-btn')).not.toBeInTheDocument();
      expect(screen.getByTestId('pin-btn')).toBeInTheDocument();
    });
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

  describe('swipe-right dismissal', () => {
    // jsdom ships no real PointerEvent constructor, so Testing Library's
    // fireEvent.pointerDown drops pointerType from the init dict — and the
    // swipe hook reads pointerType + clientX/clientY off the event. Build a
    // plain Event and copy the pointer fields onto it (same shape as the
    // TooltipButton test's `dispatch` helper).
    function dispatchPointer(
      target: Element,
      type: 'pointerdown' | 'pointermove' | 'pointerup',
      x: number,
    ) {
      const evt = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(evt, {
        pointerId: 1,
        pointerType: 'touch',
        clientX: x,
        clientY: 24,
        button: 0,
        isPrimary: true,
      });
      target.dispatchEvent(evt);
    }

    function swipeRight(target: Element) {
      // SWIPE_RATIO * width must clear SWIPE_MIN_PX (56). jsdom's
      // getBoundingClientRect reports width 0 by default; stub it on the
      // pointerdown-recorded element so the threshold is 125px and travel
      // 200px to clear it. The dx > dy * ANGLE_RATIO (1.2) gate also passes
      // since dy = 0.
      Object.defineProperty(target, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          width: 500, height: 48, top: 0, left: 0, right: 500, bottom: 48,
          x: 0, y: 0, toJSON: () => ({}),
        }),
      });
      act(() => {
        dispatchPointer(target, 'pointerdown', 50);
        dispatchPointer(target, 'pointermove', 250);
        dispatchPointer(target, 'pointerup', 250);
      });
    }

    it('snaps the row back to rest when the dismissal is rolled back (undo)', async () => {
      // If the data layer keeps the row mounted after the swipe (refetch
      // delayed/failed) and the toolbar Undo flips `done` back to false,
      // the dismissed visual state must clear so the row reappears in
      // place — otherwise the same component stays invisible.
      vi.useFakeTimers();
      try {
        const source = new MockDataSource(`test-${Math.random()}`);
        renderWithProviders(<ItemRow feedItem={FEED_ITEM} />, { source });
        const article = screen.getByTestId('item-row');
        swipeRight(article);
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(source.stateStore.get(FEED_ITEM.item.id).done).toBe(true);
        // The row is mid-dismissal — translated off + opacity 0.
        expect(article.getAttribute('style') ?? '').toMatch(/translate3d/);

        // Undo (the toolbar would call restoreLast on the store; here we
        // flip the flag directly for unit-test focus).
        act(() => {
          source.stateStore.set(FEED_ITEM.item.id, 'done', false);
        });
        // After the rollback the effect clears the dismissal state, so
        // the row no longer carries the off-screen transform.
        expect(article.getAttribute('style') ?? '').not.toMatch(/translate3d/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('runs handleHide and marks the item done after the exit animation', async () => {
      // Regression: a rollback-reset effect that fires too eagerly (before
      // the hook's 200ms timer commits the swipe) would `reset()` the hook
      // and clear its pending timer, so `handleHide` would never run and
      // the row would snap back without mutating state. The fix gates the
      // reset on having observed a true→false transition of `done`; this
      // test asserts the normal swipe path still commits.
      vi.useFakeTimers();
      try {
        const source = new MockDataSource(`test-${Math.random()}`);
        renderWithProviders(<ItemRow feedItem={FEED_ITEM} />, { source });
        const article = screen.getByTestId('item-row');
        swipeRight(article);
        // Past EXIT_DURATION_MS the hook's timer fires handleHide, which
        // sets done in the store. The parent would now unmount the row;
        // we just assert commit at the data layer.
        act(() => {
          vi.advanceTimersByTime(250);
        });
        expect(source.stateStore.get(FEED_ITEM.item.id).done).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
