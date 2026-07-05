import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '../test/renderWithProviders';
import { ItemRow } from './ItemRow';
import { PushPinFilled } from './icons';
import { MockDataSource } from '../lib/data/MockDataSource';
import { consumeDoneMirrorSuppression } from '../lib/newshackerMirrorSuppress';
import { recallHackerNewsItemId } from '../lib/newshackerItemIds';
import {
  HIDE_SPORTS_SPOILERS_KEY,
  LIST_LAYOUT_KEY,
  resetReadingPrefsCacheForTest,
} from '../hooks/useReadingPrefs';
import type { FeedItem } from '../lib/types';

/** Surfaces the router's current path so a test can assert in-app navigation
 * (the reader button) without a real route tree. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

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
    spoilerFreeTitle: null,
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

  it('does not render a row favicon by default (group-by-feed: header carries it)', () => {
    // Default showFavicon=false models the group-by-feed view, where the icon
    // lives on the section header so it isn't repeated on every row.
    const withIcon: FeedItem = {
      item: FEED_ITEM.item,
      feed: { ...FEED_ITEM.feed, faviconUrl: 'https://example.com/favicon.ico' },
    };
    const { container } = renderWithProviders(<ItemRow feedItem={withIcon} />);
    expect(container.querySelector('.item-row__favicon')).toBeNull();
  });

  it('renders the feed favicon on the row when showFavicon is set (non-grouped views)', () => {
    const withIcon: FeedItem = {
      item: FEED_ITEM.item,
      feed: { ...FEED_ITEM.feed, faviconUrl: 'https://example.com/favicon.ico' },
    };
    renderWithProviders(<ItemRow feedItem={withIcon} showFavicon />);
    const favicon = screen.getByTestId('item-favicon');
    expect(favicon).toHaveAttribute('src', 'https://example.com/favicon.ico');
    // Decorative: empty alt + aria-hidden so it adds no accessible name.
    expect(favicon).toHaveAttribute('alt', '');
    expect(favicon).toHaveAttribute('aria-hidden', 'true');
    // It sits inside the meta line, before the source text.
    expect(screen.getByTestId('item-meta')).toContainElement(favicon);
  });

  it('falls back to an initials badge when a present icon fails to load', () => {
    // An invalid/404 favicon URL that errors in the browser is replaced by the
    // feed's initials badge — no broken glyph, no blank box, no left snap.
    const withIcon: FeedItem = {
      item: FEED_ITEM.item,
      feed: { ...FEED_ITEM.feed, faviconUrl: 'https://example.com/favicon.ico' },
    };
    renderWithProviders(<ItemRow feedItem={withIcon} showFavicon />);
    act(() => {
      screen.getByTestId('item-favicon').dispatchEvent(new Event('error'));
    });
    const badge = screen.getByTestId('item-favicon');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).toHaveClass('favicon--initials');
    expect(badge.textContent).toBe('EB'); // "Example Blog"
  });

  it('shows an initials badge when showFavicon is set but the feed has no icon', () => {
    // faviconUrl null (poller hasn't resolved one) → draw the feed's initials on
    // a color badge (fills the same 16px slot, keeps rows aligned) rather than a
    // blank placeholder.
    const { container } = renderWithProviders(
      <ItemRow feedItem={FEED_ITEM} showFavicon />,
    );
    expect(container.querySelector('img.item-row__favicon')).toBeNull();
    expect(container.querySelector('.item-row__favicon-placeholder')).toBeNull();
    const badge = container.querySelector('.item-row__favicon.favicon--initials');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('EB');
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

    it('adds an Open in reader button to the left of the Pin button', () => {
      renderWithProviders(<ItemRow feedItem={FEED_ITEM} openOriginal />);
      // Pin stays; the reader shortcut is added (the row body opens the source,
      // so this button is the row's path back to the in-app reader).
      expect(screen.getByTestId('pin-btn')).toBeInTheDocument();
      const openBtn = screen.getByTestId('open-reader-btn');
      expect(openBtn).toHaveAttribute('aria-label', 'Open A test headline in reader');
      // The reader button sits before Pin in DOM order (to its left).
      const buttons = screen.getAllByRole('button');
      expect(buttons.indexOf(openBtn)).toBeLessThan(
        buttons.indexOf(screen.getByTestId('pin-btn')),
      );
    });

    it('opens the in-app reader (not a new tab) when the reader button is clicked', async () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      const user = userEvent.setup();
      const { source } = renderWithProviders(
        <>
          <ItemRow feedItem={FEED_ITEM} openOriginal />
          <LocationProbe />
        </>,
      );
      await user.click(screen.getByTestId('open-reader-btn'));
      // Navigates in-app rather than opening the source in a new tab…
      expect(screen.getByTestId('location')).toHaveTextContent('/item/item-1');
      expect(openSpy).not.toHaveBeenCalled();
      // …and marks the item opened, like a reader-mode row-body tap.
      expect(source.stateStore.get('item-1').opened).toBe(true);
      expect(source.stateStore.get('item-1').done).toBe(false);
      openSpy.mockRestore();
    });

    it('keeps Pin and the wide-viewport Done button alongside the reader button', () => {
      restoreMatchMedia = stubWideViewport(true);
      renderWithProviders(<ItemRow feedItem={FEED_ITEM} openOriginal />);
      expect(screen.getByTestId('done-btn')).toBeInTheDocument();
      expect(screen.getByTestId('pin-btn')).toBeInTheDocument();
      expect(screen.getByTestId('open-reader-btn')).toBeInTheDocument();
    });

    it('keeps the library inverse action (no reader button) on library rows', () => {
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
      expect(screen.queryByTestId('open-reader-btn')).not.toBeInTheDocument();
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
      // Body already goes to the reader ⇒ no separate reader button; Pin stays.
      expect(screen.queryByTestId('open-reader-btn')).not.toBeInTheDocument();
      expect(screen.getByTestId('pin-btn')).toBeInTheDocument();
    });
  });

  describe('mark done when opening', () => {
    it('marks the item done when an open-original row body is tapped', async () => {
      const user = userEvent.setup();
      const { source } = renderWithProviders(
        <ItemRow feedItem={FEED_ITEM} openOriginal markDoneOnOpen />,
      );
      await user.click(screen.getByTestId('item-title'));
      expect(source.stateStore.get('item-1').opened).toBe(true);
      expect(source.stateStore.get('item-1').done).toBe(true);
    });

    it('marks the item done when a newshacker row body is tapped', async () => {
      const user = userEvent.setup();
      const hn: FeedItem = {
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
      const { source } = renderWithProviders(
        <ItemRow feedItem={hn} openNewshacker markDoneOnOpen />,
      );
      // The row body links to the newshacker discussion in the same tab.
      const body = screen.getByTestId('item-title');
      expect(body).toHaveAttribute('href', 'https://newshacker.app/item/42662903');
      expect(body).not.toHaveAttribute('target');
      // Rendering an HN row remembers its numeric id for the mirror, so an
      // unpin/un-dismiss can still resolve it after visibility is cleared.
      expect(recallHackerNewsItemId('item-1')).toBe(42662903);
      await user.click(body);
      expect(source.stateStore.get('item-1').opened).toBe(true);
      expect(source.stateStore.get('item-1').done).toBe(true);
      // Opening ON newshacker is a handoff: the Done mirror is suppressed so it
      // isn't swept to Done on newshacker as the user arrives there.
      expect(consumeDoneMirrorSuppression('item-1')).toBe(true);
    });

    it('does NOT mark done when opening the in-app reader (reader-mode body tap)', async () => {
      const user = userEvent.setup();
      const { source } = renderWithProviders(<ItemRow feedItem={FEED_ITEM} markDoneOnOpen />);
      // Reader-mode row body links to the in-app reader, not an external tab.
      expect(screen.getByTestId('item-title')).toHaveAttribute('href', '/item/item-1');
      await user.click(screen.getByTestId('item-title'));
      expect(source.stateStore.get('item-1').opened).toBe(true);
      expect(source.stateStore.get('item-1').done).toBe(false);
    });

    it('unpins a pinned item when opening marks it done (mutation shield)', async () => {
      const user = userEvent.setup();
      const { source } = renderWithProviders(
        <ItemRow feedItem={FEED_ITEM} openOriginal markDoneOnOpen />,
      );
      source.stateStore.set('item-1', 'pinned', true);
      await user.click(screen.getByTestId('item-title'));
      expect(source.stateStore.get('item-1').done).toBe(true);
      expect(source.stateStore.get('item-1').pinned).toBe(false);
      // Opening the ORIGINAL source is a real completion, not a handoff — its
      // Done is NOT suppressed and still mirrors.
      expect(consumeDoneMirrorSuppression('item-1')).toBe(false);
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

    it('links the row body to the newshacker discussion in the same tab (no new-tab hardening)', () => {
      // newshacker is our own sibling app, so it opens in the same tab (making
      // Readmo newshacker's back target) without the untrusted-link
      // noopener/noreferrer that source URLs get.
      renderWithProviders(<ItemRow feedItem={HN_FEED_ITEM} openNewshacker />);
      const body = screen.getByTestId('item-title');
      expect(body).toHaveAttribute('href', 'https://newshacker.app/item/42662903');
      expect(body).not.toHaveAttribute('target');
      expect(body).not.toHaveAttribute('rel');
    });

    it('adds the same Open in reader button as open-original mode', () => {
      renderWithProviders(<ItemRow feedItem={HN_FEED_ITEM} openNewshacker />);
      const btn = screen.getByTestId('open-reader-btn');
      expect(btn).toHaveAttribute('aria-label', 'Open A test headline in reader');
      expect(screen.getByTestId('pin-btn')).toBeInTheDocument();
    });

    it('opens the in-app reader from the button while the body still goes to newshacker', async () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      const user = userEvent.setup();
      const { source } = renderWithProviders(
        <>
          <ItemRow feedItem={HN_FEED_ITEM} openNewshacker />
          <LocationProbe />
        </>,
      );
      // Row body opens the newshacker discussion in the same tab…
      expect(screen.getByTestId('item-title')).toHaveAttribute(
        'href',
        'https://newshacker.app/item/42662903',
      );
      // …but the dedicated button navigates to the in-app reader instead.
      await user.click(screen.getByTestId('open-reader-btn'));
      expect(screen.getByTestId('location')).toHaveTextContent('/item/item-1');
      expect(openSpy).not.toHaveBeenCalled();
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
      // Both external modes resolve to the same single reader-shortcut button.
      expect(screen.getByTestId('open-reader-btn')).toBeInTheDocument();
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
      expect(screen.getByTestId('open-reader-btn')).toBeInTheDocument();
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
      expect(screen.getByTestId('open-reader-btn')).toBeInTheDocument();
    });

    it('falls back to the in-app reader when the item has no Hacker News id', () => {
      // A non-HN item (plain guid/url) in newshacker mode can't build a link.
      renderWithProviders(<ItemRow feedItem={FEED_ITEM} openNewshacker />);
      const body = screen.getByTestId('item-title');
      expect(body).toHaveAttribute('href', '/item/item-1');
      expect(body).not.toHaveAttribute('target');
      // Body already goes to the reader ⇒ no separate reader button; Pin stays.
      expect(screen.queryByTestId('open-reader-btn')).not.toBeInTheDocument();
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

  describe('spoiler-free headline', () => {
    const SPOILER_ITEM: FeedItem = {
      ...FEED_ITEM,
      item: {
        ...FEED_ITEM.item,
        title: 'Man Utd beat Arsenal 3-1 to go top',
        spoilerFreeTitle: 'EPL MNU v ARS spoiler',
      },
    };

    beforeEach(() => {
      window.localStorage.clear();
      resetReadingPrefsCacheForTest();
    });
    afterEach(() => {
      window.localStorage.clear();
      resetReadingPrefsCacheForTest();
    });

    it('shows the rewrite and a marker when the setting is on (default) and caller allowed', () => {
      // Default provider stack: signed-out → default capabilities → allowed;
      // the setting defaults on.
      renderWithProviders(<ItemRow feedItem={SPOILER_ITEM} />);
      expect(screen.getByTestId('item-title')).toHaveTextContent('EPL MNU v ARS spoiler');
      expect(screen.getByTestId('item-title')).not.toHaveTextContent('3-1');
      const flag = screen.getByTestId('item-spoiler-flag');
      expect(flag).toHaveAttribute('title', 'Man Utd beat Arsenal 3-1 to go top');
      // The marker is not an interactive control (adds no tap zone — guardrail #2).
      expect(within(flag).queryByRole('button')).toBeNull();
      expect(within(flag).queryByRole('link')).toBeNull();
    });

    it('shows the original headline and no marker when the setting is off', () => {
      window.localStorage.setItem(HIDE_SPORTS_SPOILERS_KEY, '0');
      resetReadingPrefsCacheForTest();
      renderWithProviders(<ItemRow feedItem={SPOILER_ITEM} />);
      expect(screen.getByTestId('item-title')).toHaveTextContent('Man Utd beat Arsenal 3-1 to go top');
      expect(screen.queryByTestId('item-spoiler-flag')).toBeNull();
    });

    it('shows the original headline (no marker) when no rewrite is cached', () => {
      renderWithProviders(<ItemRow feedItem={FEED_ITEM} />);
      expect(screen.getByTestId('item-title')).toHaveTextContent('A test headline');
      expect(screen.queryByTestId('item-spoiler-flag')).toBeNull();
    });
  });

  describe('article layout variants', () => {
    afterEach(() => {
      window.localStorage.clear();
      resetReadingPrefsCacheForTest();
    });

    function renderLayout(layout: string, feedItem: FeedItem = FEED_ITEM) {
      window.localStorage.setItem(LIST_LAYOUT_KEY, layout);
      resetReadingPrefsCacheForTest();
      renderWithProviders(<ItemRow feedItem={feedItem} />);
    }

    const PROXIED_IMG =
      '/api/img?url=' + encodeURIComponent('https://cdn.example.com/lead.jpg');
    const withImage: FeedItem = {
      item: {
        ...FEED_ITEM.item,
        contentHtml: `<p>Body text of the article.</p><img src="${PROXIED_IMG}" alt="">`,
      },
      feed: FEED_ITEM.feed,
    };

    it("title-only (default) shows neither an excerpt nor a thumbnail", () => {
      renderLayout('title', withImage);
      expect(screen.queryByTestId('item-excerpt')).toBeNull();
      expect(screen.queryByTestId('item-lead-image')).toBeNull();
    });

    it('excerpt layout shows a plain-text preview of the feed body', () => {
      renderLayout('excerpt', withImage);
      const excerpt = screen.getByTestId('item-excerpt');
      expect(excerpt).toHaveTextContent('Body text of the article.');
      // The excerpt layout carries no image.
      expect(screen.queryByTestId('item-lead-image')).toBeNull();
    });

    it('excerpt layout hides the preview behind a placeholder when the headline is a spoiler', () => {
      // Default provider stack: allowed + "Hide sports spoilers" on → the
      // rewrite is shown, so the body would repeat the hidden result.
      const spoiler: FeedItem = {
        item: {
          ...FEED_ITEM.item,
          title: 'Man Utd beat Arsenal 3-1 to go top',
          spoilerFreeTitle: 'EPL MNU v ARS spoiler',
          contentHtml: '<p>Man Utd beat Arsenal 3-1 at Old Trafford.</p>',
        },
        feed: FEED_ITEM.feed,
      };
      renderLayout('excerpt', spoiler);
      const excerpt = screen.getByTestId('item-excerpt');
      expect(excerpt).toHaveTextContent('Spoilers hidden. Tap to see article.');
      // The real body — and the scoreline in it — never renders.
      expect(excerpt).not.toHaveTextContent('3-1');
      expect(excerpt).toHaveClass('item-row__excerpt--spoiler');
    });

    it('excerpt layout shows the real preview when spoiler hiding is off', () => {
      window.localStorage.setItem(HIDE_SPORTS_SPOILERS_KEY, '0');
      const spoiler: FeedItem = {
        item: {
          ...FEED_ITEM.item,
          title: 'Man Utd beat Arsenal 3-1 to go top',
          spoilerFreeTitle: 'EPL MNU v ARS spoiler',
          contentHtml: '<p>Man Utd beat Arsenal 3-1 at Old Trafford.</p>',
        },
        feed: FEED_ITEM.feed,
      };
      renderLayout('excerpt', spoiler);
      const excerpt = screen.getByTestId('item-excerpt');
      expect(excerpt).toHaveTextContent('Man Utd beat Arsenal 3-1 at Old Trafford.');
      expect(excerpt).not.toHaveClass('item-row__excerpt--spoiler');
    });

    it('thumbnail layout renders the content image inside the body link', () => {
      renderLayout('thumbnail', withImage);
      const img = screen.getByTestId('item-lead-image');
      expect(img).toHaveAttribute('src', PROXIED_IMG);
      // The image lives inside the stretched body link — no new tap zone.
      expect(screen.getByTestId('item-title')).toContainElement(img);
      // Thumbnail layout carries no excerpt.
      expect(screen.queryByTestId('item-excerpt')).toBeNull();
    });

    it('thumbnail layout collapses to no image when the item has none', () => {
      renderLayout('thumbnail', FEED_ITEM); // contentHtml is '<p>Body</p>', no image
      expect(screen.queryByTestId('item-lead-image')).toBeNull();
      // Still a normal, tappable row.
      expect(screen.getByTestId('item-title')).toHaveTextContent('A test headline');
    });
  });
});
