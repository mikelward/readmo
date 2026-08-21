import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
import { AddFeedError, type DiscoveredFeed } from '../lib/data/DataSource';
import type { AddFeedErrorKind } from '../lib/data/DataSource';
import { FeedsPage } from './FeedsPage';
import { POPULAR_FEEDS, RECOMMENDED_FEEDS } from '../lib/popularFeeds';
import { PUBLISHERS, publisherForUrl } from '../lib/feedSections';

/** A source whose subscribe() returns a feed with no siteUrl or meaningful
 * title — simulating a silent server-side refresh failure (the edge function
 * ran but couldn't reach the feed, so title/site_url stayed null in the DB). */
class RefreshFailSource extends MockDataSource {
  async subscribe(feedUrl: string): ReturnType<MockDataSource['subscribe']> {
    const feed = await super.subscribe(feedUrl);
    return { ...feed, siteUrl: null, url: '', title: 'Untitled feed' };
  }
}

/** A source whose discovery finds nothing — the case where the input is a
 * plain web page that neither is a feed nor advertises one. */
class NoFeedSource extends MockDataSource {
  async discover(): Promise<DiscoveredFeed[]> {
    return [];
  }
}

/** A source whose discovery fails with a specific, classified reason. */
class FailingDiscoverSource extends MockDataSource {
  constructor(private readonly kind: AddFeedErrorKind) {
    super(`test-${Math.random()}`);
  }
  async discover(): Promise<DiscoveredFeed[]> {
    throw new AddFeedError(this.kind);
  }
}

/** A source whose discovery advertises several per-section feeds, like a news
 * site exposing Sport / World news feeds alongside its main feed. URLs
 * containing "dead" fail discovery, so a second submit can error while a
 * picker from an earlier multi-feed site is still open. */
class MultiFeedSource extends MockDataSource {
  async discover(url: string): Promise<DiscoveredFeed[]> {
    if (url.includes('dead')) throw new AddFeedError('unreachable');
    const base = url.includes('://') ? url.replace(/\/$/, '') : `https://${url}`;
    return [
      { url: `${base}/feed`, title: 'Top stories', siteUrl: base, sampleTitles: ['Lead story'] },
      { url: `${base}/sport/feed`, title: 'Sport', siteUrl: base, sampleTitles: ['Big match'] },
      { url: `${base}/world/feed`, title: 'World news', siteUrl: base, sampleTitles: ['Global'] },
    ];
  }
}

/** Multi-feed discovery that blocks until the test opens the gate, so a URL
 * edit can be interleaved while discovery is still in flight. `completed`
 * resolves once the (released) discover() body returns. */
class GatedMultiSource extends MockDataSource {
  private openGate!: () => void;
  private markDone!: () => void;
  private gate = new Promise<void>((r) => (this.openGate = r));
  readonly completed = new Promise<void>((r) => (this.markDone = r));
  async discover(url: string): Promise<DiscoveredFeed[]> {
    await this.gate;
    const base = url.includes('://') ? url.replace(/\/$/, '') : `https://${url}`;
    const out: DiscoveredFeed[] = [
      { url: `${base}/feed`, title: 'Top stories', siteUrl: base, sampleTitles: [] },
      { url: `${base}/sport/feed`, title: 'Sport', siteUrl: base, sampleTitles: [] },
    ];
    this.markDone();
    return out;
  }
  release() {
    this.openGate();
  }
}

/** Multi-feed discovery whose subscribe() rejects for the "world" section,
 * to exercise partial-failure handling across a multi-feed selection. */
class PartialSubscribeSource extends MultiFeedSource {
  async subscribe(feedUrl: string, folder: string | null = null) {
    if (feedUrl.includes('/world/')) throw new AddFeedError('feed-auth');
    return super.subscribe(feedUrl, folder);
  }
}

/** Curated subscribe whose feed comes back with a fallback title (forcing the
 * setTitleOverride path) and whose setTitleOverride blocks until released, so a
 * field edit can be interleaved while that await is pending. */
class GatedTitleOverrideSource extends MockDataSource {
  private openGate!: () => void;
  private markDone!: () => void;
  private gate = new Promise<void>((r) => (this.openGate = r));
  readonly completed = new Promise<void>((r) => (this.markDone = r));
  async subscribe(feedUrl: string, folder: string | null = null) {
    const feed = await super.subscribe(feedUrl, folder);
    // Fallback title → onSuccess takes the awaited setTitleOverride branch.
    return { ...feed, title: 'Untitled feed' };
  }
  async setTitleOverride(feedId: Parameters<MockDataSource['setTitleOverride']>[0], title: string | null) {
    await this.gate;
    await super.setTitleOverride(feedId, title);
    this.markDone();
  }
  release() {
    this.openGate();
  }
}

/** Multi-feed discovery (resolves immediately) whose subscribe() blocks until
 * released, so a field edit can be interleaved while a subscribe is in flight. */
class GatedSubscribeSource extends MultiFeedSource {
  private openGate!: () => void;
  private markDone!: () => void;
  private gate = new Promise<void>((r) => (this.openGate = r));
  readonly completed = new Promise<void>((r) => (this.markDone = r));
  async subscribe(feedUrl: string, folder: string | null = null) {
    await this.gate;
    const feed = await super.subscribe(feedUrl, folder);
    this.markDone();
    return feed;
  }
  release() {
    this.openGate();
  }
}

/** Like {@link GatedMultiSource} but discovery rejects once released, so a
 * superseded *failure* can be interleaved with a field edit. */
class GatedFailSource extends MockDataSource {
  private openGate!: () => void;
  private markDone!: () => void;
  private gate = new Promise<void>((r) => (this.openGate = r));
  readonly completed = new Promise<void>((r) => (this.markDone = r));
  async discover(): Promise<DiscoveredFeed[]> {
    await this.gate;
    this.markDone();
    throw new AddFeedError('unreachable');
  }
  release() {
    this.openGate();
  }
}

async function addFeed(url: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Feed name or URL'), url);
  await user.click(screen.getByRole('button', { name: /^Add$/ }));
}

describe('FeedsPage — popular feed autocomplete', () => {
  it('shows matching suggestions as the user types', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedsPage />);
    await user.type(screen.getByLabelText('Feed name or URL'), 'bbc news');
    const listbox = await screen.findByRole('listbox');
    // Scope to the suggestion listbox: BBC News is also a seeded subscription in
    // the feed list below, so an unscoped query would match twice.
    expect(within(listbox).getByText('BBC News')).toBeTruthy();
  });

  it('shows the recommended feeds in the dropdown when the empty field is focused', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedsPage />);
    // Nothing until the user interacts.
    expect(screen.queryByRole('listbox')).toBeNull();
    // Focusing the empty field offers the curated starter set as suggestions.
    await user.click(screen.getByLabelText('Feed name or URL'));
    const listbox = await screen.findByRole('listbox');
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(RECOMMENDED_FEEDS.length);
    for (const feed of RECOMMENDED_FEEDS) {
      expect(within(listbox).getByText(feed.name)).toBeTruthy();
    }
  });

  it('replaces the recommended set with typed matches once the user types', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedsPage />);
    await user.type(screen.getByLabelText('Feed name or URL'), 'wsj');
    const listbox = await screen.findByRole('listbox');
    // The fuzzy (acronym) match takes over from the starter set.
    expect(within(listbox).getByText('Wall Street Journal')).toBeTruthy();
    // A recommended-only entry that doesn't match "wsj" is no longer shown.
    expect(within(listbox).queryByText(RECOMMENDED_FEEDS[0].name)).toBeNull();
  });

  it('subscribes via a recommended suggestion picked from the focus dropdown', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const discoverSpy = vi.spyOn(source, 'discover');
    const before = (await source.getSubscriptions()).length;
    renderWithProviders(<FeedsPage />, { source });
    const input = screen.getByLabelText('Feed name or URL') as HTMLInputElement;
    // A single-feed recommended entry (one that isn't a sectioned publisher, so
    // it subscribes directly rather than opening the section picker).
    const recommended = RECOMMENDED_FEEDS.find((f) => !publisherForUrl(f.feedUrl))!;
    // Focus → recommended dropdown → pick fills the feed URL → Add subscribes.
    await user.click(input);
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText(recommended.name));
    expect(input.value).toBe(recommended.feedUrl);
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByText(`Subscribed to ${recommended.name}`);
    // Curated picks bypass discovery.
    expect(discoverSpy).not.toHaveBeenCalled();
    expect((await source.getSubscriptions()).length).toBe(before + 1);
  });

  it('scrolls the active suggestion into view on arrow-key navigation', async () => {
    // jsdom doesn't implement scrollIntoView; stub it on the prototype.
    const scrollSpy = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      const user = userEvent.setup();
      renderWithProviders(<FeedsPage />);
      const input = screen.getByLabelText('Feed name or URL');
      await user.click(input);
      await screen.findByRole('listbox');
      scrollSpy.mockClear();
      await user.keyboard('{ArrowDown}');
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it('re-scrolls the persisted active index into view when the dropdown remounts', async () => {
    // jsdom doesn't implement scrollIntoView; stub it on the prototype.
    const scrollSpy = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      const user = userEvent.setup();
      renderWithProviders(<FeedsPage />);
      const input = screen.getByLabelText('Feed name or URL');
      await user.click(input);
      await screen.findByRole('listbox');
      await user.keyboard('{ArrowDown}{ArrowDown}');
      // Blur closes (unmounts) the dropdown after its debounce, without
      // resetting activeIdx. fireEvent.blur() only dispatches the event
      // without moving focus, which would make the next user.click() on the
      // still-focused input a no-op focus-wise — call the real DOM method so
      // document.activeElement actually moves, same as a real blur.
      act(() => input.blur());
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
      scrollSpy.mockClear();
      // Refocusing remounts the dropdown at the persisted activeIdx; the
      // newly-mounted list must be scrolled to that row too, not just left at
      // the top.
      await user.click(input);
      await screen.findByRole('listbox');
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it('uses the "Feed name or URL" placeholder on the Add-a-feed input', () => {
    renderWithProviders(<FeedsPage />);
    expect(screen.getByPlaceholderText('Feed name or URL')).toBeTruthy();
  });

  it('resolves a typed feed name to its catalog feed on Add (no dropdown pick)', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const discoverSpy = vi.spyOn(source, 'discover');
    renderWithProviders(<FeedsPage />, { source });
    // The field says it accepts a name, so typing "wsj" and pressing Add without
    // picking a suggestion must resolve to Wall Street Journal, not be sent to
    // discover() as a bogus URL.
    await user.type(screen.getByLabelText('Feed name or URL'), 'wsj');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByText('Subscribed to Wall Street Journal');
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('resolves an exact dotted catalog name on Add (e.g. "The A.V. Club")', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const discoverSpy = vi.spyOn(source, 'discover');
    renderWithProviders(<FeedsPage />, { source });
    // A catalog name containing dots must resolve by exact name, not be sent to
    // discovery as a URL just because it has a ".".
    await user.type(screen.getByLabelText('Feed name or URL'), 'The A.V. Club');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByText('Subscribed to The A.V. Club');
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('still sends a URL-shaped entry to discovery, not name resolution', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const discoverSpy = vi.spyOn(source, 'discover');
    renderWithProviders(<FeedsPage />, { source });
    // A dotted/host-shaped entry must go through discovery as before.
    await user.type(screen.getByLabelText('Feed name or URL'), 'example.com/blog');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByText(/^Subscribed to /);
    expect(discoverSpy).toHaveBeenCalled();
  });

  it('shows the type-a-site/topic/country helper text under the Add-a-feed input', () => {
    renderWithProviders(<FeedsPage />);
    expect(
      screen.getByText('Type a site, a topic, or a country code to see suggestions.'),
    ).toBeTruthy();
  });

  it('matches a topic by category', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedsPage />);
    await user.type(screen.getByLabelText('Feed name or URL'), 'science');
    const listbox = await screen.findByRole('listbox');
    // "science" appears in no Science-category feed's *name*, so a hit proves
    // the category field is being searched.
    const scienceFeed = POPULAR_FEEDS.find(
      (f) => f.category === 'Science' && !f.name.toLowerCase().includes('science'),
    )!;
    expect(within(listbox).getByText(scienceFeed.name)).toBeTruthy();
  });

  it('matches an acronym to a multi-word feed (WSJ → Wall Street Journal)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedsPage />);
    await user.type(screen.getByLabelText('Feed name or URL'), 'WSJ');
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Wall Street Journal')).toBeTruthy();
  });

  it('matches a country code via the feed URL', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedsPage />);
    await user.type(screen.getByLabelText('Feed name or URL'), '.com.au');
    const listbox = await screen.findByRole('listbox');
    // An Australian outlet whose name doesn't contain the code is found only
    // because its .com.au feed URL matches.
    expect(within(listbox).getByText('Brisbane Times')).toBeTruthy();
  });

  it('fills the feed URL when a suggestion is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedsPage />);
    const input = screen.getByLabelText('Feed name or URL') as HTMLInputElement;
    await user.type(input, 'bbc news');
    // Scope to the suggestion listbox: BBC News is also a seeded subscription in
    // the feed list below, so an unscoped query would match twice.
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText('BBC News'));
    const bbcFeed = POPULAR_FEEDS.find((f) => f.name === 'BBC News')!;
    expect(input.value).toBe(bbcFeed.feedUrl);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('selects a suggestion with keyboard navigation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedsPage />);
    const input = screen.getByLabelText('Feed name or URL') as HTMLInputElement;
    await user.type(input, 'bbc news');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{Enter}');
    // After Enter, the input should have the first suggestion's feedUrl.
    const bbcFeed = POPULAR_FEEDS.find((f) => f.name === 'BBC News')!;
    expect(input.value).toBe(bbcFeed.feedUrl);
  });

  it('subscribes directly without calling discover when a suggestion is selected', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const discoverSpy = vi.spyOn(source, 'discover');
    renderWithProviders(<FeedsPage />, { source });
    const input = screen.getByLabelText('Feed name or URL') as HTMLInputElement;
    // A single-feed catalog entry (not a sectioned publisher) subscribes
    // straight through without discovery and without the section picker.
    await user.type(input, 'ars technica');
    await user.click(await screen.findByText('Ars Technica'));
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByText(/^Subscribed to /);
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('uses the curated name as title override when the server refresh fails to populate the feed', async () => {
    const user = userEvent.setup();
    const source = new RefreshFailSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });
    const input = screen.getByLabelText('Feed name or URL') as HTMLInputElement;
    // A single-feed catalog entry takes the direct curated-subscribe path.
    await user.type(input, 'ars technica');
    await user.click(await screen.findByText('Ars Technica'));
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    // Toast should use the known name, not "Untitled feed".
    await screen.findByText(/^Subscribed to Ars Technica/);
    // Subscription list should show the curated name, not "Untitled feed".
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Actions for Ars Technica' })).toBeTruthy();
    });
  });

  it('pins the curated name even when the publisher returns its own real title', async () => {
    // Regression for The Economist's /latest/rss.xml, whose channel title is
    // literally "Latest Updates". The user picked "The Economist" from the
    // curated list; that brand label must win over the publisher's title.
    class RealTitleSource extends MockDataSource {
      async subscribe(feedUrl: string): ReturnType<MockDataSource['subscribe']> {
        const feed = await super.subscribe(feedUrl);
        return { ...feed, title: 'Latest Updates' };
      }
    }
    const user = userEvent.setup();
    const source = new RealTitleSource(`test-${Math.random()}`);
    const setSpy = vi.spyOn(source, 'setTitleOverride');
    renderWithProviders(<FeedsPage />, { source });
    const input = screen.getByLabelText('Feed name or URL') as HTMLInputElement;
    await user.type(input, 'the economist');
    await user.click(await screen.findByText('The Economist'));
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByText(/^Subscribed to The Economist/);
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), 'The Economist');
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Actions for The Economist' }),
      ).toBeTruthy();
    });
    expect(screen.queryByText('Latest Updates')).toBeNull();
  });

  it('preserves a user rename when re-adding the same curated feed', async () => {
    // Regression: subscribe() is idempotent, so picking the same curated entry
    // again must not overwrite a per-row rename the user applied earlier.
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    // Pre-subscribe to a single-feed catalog entry (bypasses the curated-name
    // pin so the existing row has a null override at the start of the test,
    // matching the case the bug report describes).
    const arsFeed = POPULAR_FEEDS.find((f) => f.name === 'Ars Technica')!;
    const created = await source.subscribe(arsFeed.feedUrl);
    await source.setTitleOverride(created.id, 'My News');
    renderWithProviders(<FeedsPage />, { source });

    const setSpy = vi.spyOn(source, 'setTitleOverride');

    // Re-add via the curated suggestion. subscribe() returns the existing
    // feed; the override must NOT be touched.
    const input = screen.getByLabelText('Feed name or URL') as HTMLInputElement;
    await user.type(input, 'ars technica');
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText('Ars Technica'));
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByText(/^Subscribed to Ars Technica/);

    expect(setSpy).not.toHaveBeenCalled();
    const after = (await source.getSubscriptions()).find(
      (s) => s.feed.id === created.id,
    );
    expect(after?.subscription.titleOverride).toBe('My News');
  });

  it('closes the dropdown on Escape', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedsPage />);
    await user.type(screen.getByLabelText('Feed name or URL'), 'bbc news');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('FeedsPage — Add a feed', () => {
  it('shows a "no feed found" message and does not subscribe when discovery is empty', async () => {
    const source = new NoFeedSource(`test-${Math.random()}`);
    const before = (await source.getSubscriptions()).length;
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('https://example.com/not-a-feed');

    expect(await screen.findByText('No feed found at that URL.')).toBeTruthy();
    // The bad URL must NOT become an (empty, "Untitled") subscription.
    expect(await source.getSubscriptions()).toHaveLength(before);
  });

  it.each([
    ['signed-out', 'You’re signed out. Sign in again to add feeds.'],
    ['feed-auth', 'That feed requires a login, so it can’t be added.'],
    ['not-found', 'That URL could not be found (404).'],
    ['unreachable', 'Couldn’t reach that URL. Check the address and try again.'],
    ['unknown', 'Couldn’t add that feed. Please try again.'],
  ] as Array<[AddFeedErrorKind, string]>)(
    'surfaces the %s failure to the user',
    async (kind, message) => {
      const source = new FailingDiscoverSource(kind);
      renderWithProviders(<FeedsPage />, { source });

      await addFeed('https://example.com/whatever');

      expect(await screen.findByText(message)).toBeTruthy();
    },
  );

  it('expands a Reddit "r/sub" shorthand to a full reddit.com URL before discovery', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const discover = vi.spyOn(source, 'discover');
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('r/programming');

    await screen.findByText(/^Subscribed to /);
    // Discovery is handed the expanded URL, not the raw shorthand.
    expect(discover).toHaveBeenCalledWith('https://www.reddit.com/r/programming');
  });

  it('reflects the expanded Reddit shorthand in the box when a picker opens', async () => {
    // A multi-feed discovery leaves the box populated (no auto-subscribe/clear),
    // so the box should show the expanded URL the user is choosing feeds for.
    const source = new MultiFeedSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('r/programming');

    await screen.findByRole('group', { name: /choose feeds/i });
    expect(screen.getByLabelText('Feed name or URL')).toHaveProperty(
      'value',
      'https://www.reddit.com/r/programming',
    );
  });

  it('subscribes to the discovered feed and confirms by title', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const before = (await source.getSubscriptions()).length;
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('https://example.com/blog');

    await screen.findByText(/^Subscribed to /);
    await waitFor(async () => {
      expect((await source.getSubscriptions()).length).toBe(before + 1);
    });
  });

  it('subscribes directly without a picker when discovery finds a single feed', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('https://example.com/blog');

    await screen.findByText(/^Subscribed to /);
    // A single candidate must not pop the picker.
    expect(screen.queryByRole('group', { name: /choose feeds/i })).toBeNull();
  });

  it('opens a picker (without subscribing) when discovery finds multiple feeds', async () => {
    const source = new MultiFeedSource(`test-${Math.random()}`);
    const before = (await source.getSubscriptions()).length;
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('https://news.example.com');

    expect(await screen.findByRole('group', { name: /choose feeds/i })).toBeTruthy();
    expect(screen.getByText('Sport')).toBeTruthy();
    expect(screen.getByText('World news')).toBeTruthy();
    // Nothing is subscribed until the user confirms a selection.
    expect((await source.getSubscriptions()).length).toBe(before);
    // Subscribe is disabled until at least one feed is checked.
    expect(screen.getByRole('button', { name: /^Subscribe$/ })).toHaveProperty('disabled', true);
  });

  it('subscribes to every selected feed from the picker', async () => {
    const user = userEvent.setup();
    const source = new MultiFeedSource(`test-${Math.random()}`);
    const before = (await source.getSubscriptions()).length;
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('https://news.example.com');
    await screen.findByRole('group', { name: /choose feeds/i });

    await user.click(screen.getByText('Sport'));
    await user.click(screen.getByText('World news'));
    await user.click(screen.getByRole('button', { name: /^Subscribe to 2$/ }));

    await screen.findByText('Subscribed to 2 feeds');
    await waitFor(async () => {
      expect((await source.getSubscriptions()).length).toBe(before + 2);
    });
    // Picker closes after a successful subscribe.
    expect(screen.queryByRole('group', { name: /choose feeds/i })).toBeNull();
  });

  it('clears an open picker when the URL field is edited', async () => {
    const user = userEvent.setup();
    const source = new MultiFeedSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('https://news.example.com');
    await screen.findByRole('group', { name: /choose feeds/i });

    // Typing a new query invalidates the picker (it was discovered for the old
    // URL); it must not linger with an enabled Subscribe button.
    await user.type(screen.getByLabelText('Feed name or URL'), 'x');

    expect(screen.queryByRole('group', { name: /choose feeds/i })).toBeNull();
  });

  it('ignores a slow discovery result after the URL field is edited', async () => {
    const user = userEvent.setup();
    const source = new GatedMultiSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });

    // Submit site A; discovery blocks on the gate.
    await addFeed('https://news.example.com');
    // Edit the URL while discovery is still in flight — this supersedes the
    // request (bumps the discovery token).
    await user.type(screen.getByLabelText('Feed name or URL'), 'x');

    // Release the now-stale discovery and let its mutation settle.
    await act(async () => {
      source.release();
      await source.completed;
      // Flush the microtask react-query uses to invoke onSuccess.
      await Promise.resolve();
    });

    // The stale result must be discarded: no picker for the abandoned site A.
    expect(screen.queryByRole('group', { name: /choose feeds/i })).toBeNull();
  });

  it('suppresses a superseded discovery error after the URL field is edited', async () => {
    const user = userEvent.setup();
    const source = new GatedFailSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });

    // Submit site A; discovery blocks, then will reject.
    await addFeed('https://news.example.com');
    // Edit the URL while discovery is in flight, superseding the request.
    await user.type(screen.getByLabelText('Feed name or URL'), 'x');

    await act(async () => {
      source.release();
      await source.completed.catch(() => {});
      await Promise.resolve();
    });

    // The stale failure must not toast over the user's new add context.
    expect(
      screen.queryByText('Couldn’t reach that URL. Check the address and try again.'),
    ).toBeNull();
  });

  it('clears a stale picker when a new discovery fails', async () => {
    const user = userEvent.setup();
    const source = new MultiFeedSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });

    // Open a picker for site A.
    await addFeed('https://news.example.com');
    await screen.findByRole('group', { name: /choose feeds/i });

    // Submit a different URL that fails discovery; the site-A picker must not
    // linger (it would otherwise be subscribable under the new input).
    const input = screen.getByLabelText('Feed name or URL') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'https://dead.example.com');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    expect(
      await screen.findByText('Couldn’t reach that URL. Check the address and try again.'),
    ).toBeTruthy();
    expect(screen.queryByRole('group', { name: /choose feeds/i })).toBeNull();
  });

  it('subscribes the successful feeds when one selected feed fails', async () => {
    const user = userEvent.setup();
    const source = new PartialSubscribeSource(`test-${Math.random()}`);
    const before = (await source.getSubscriptions()).length;
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('https://news.example.com');
    await screen.findByRole('group', { name: /choose feeds/i });

    // Sport subscribes; World news (the "/world/" URL) rejects.
    await user.click(screen.getByText('Sport'));
    await user.click(screen.getByText('World news'));
    await user.click(screen.getByRole('button', { name: /^Subscribe to 2$/ }));

    // The committed one must be surfaced and the failure reported, not dropped.
    await screen.findByText('Subscribed to 1 feed; 1 couldn’t be added');
    await waitFor(async () => {
      expect((await source.getSubscriptions()).length).toBe(before + 1);
    });
    expect(screen.queryByRole('group', { name: /choose feeds/i })).toBeNull();
  });

  it('keeps the picker open and reports the error when every selected feed fails', async () => {
    const user = userEvent.setup();
    const source = new PartialSubscribeSource(`test-${Math.random()}`);
    const before = (await source.getSubscriptions()).length;
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('https://news.example.com');
    await screen.findByRole('group', { name: /choose feeds/i });

    await user.click(screen.getByText('World news'));
    await user.click(screen.getByRole('button', { name: /^Subscribe$/ }));

    expect(await screen.findByText('That feed requires a login, so it can’t be added.')).toBeTruthy();
    expect((await source.getSubscriptions()).length).toBe(before);
    // Nothing committed: leave the picker up so the user can adjust and retry.
    expect(screen.queryByRole('group', { name: /choose feeds/i })).toBeTruthy();
  });

  it('does not clobber a newly typed URL when an in-flight subscribe completes', async () => {
    const user = userEvent.setup();
    const source = new GatedSubscribeSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('https://news.example.com');
    await screen.findByRole('group', { name: /choose feeds/i });
    await user.click(screen.getByText('Sport'));
    await user.click(screen.getByRole('button', { name: /^Subscribe$/ }));

    // Subscribe is in flight (gated). The field stays editable, so the user
    // starts the next URL before it finishes.
    const input = screen.getByLabelText('Feed name or URL') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'https://other.example.com');

    await act(async () => {
      source.release();
      await source.completed;
      await Promise.resolve();
    });

    // The stale completion must not wipe the newer input.
    expect(input.value).toBe('https://other.example.com');
  });

  it('does not clobber a newly typed URL when a title override resolves late', async () => {
    const user = userEvent.setup();
    const source = new GatedTitleOverrideSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });

    // Select a curated suggestion and add it; subscribe resolves with a
    // fallback title, so onSuccess awaits the (gated) setTitleOverride. A
    // single-feed entry (not a sectioned publisher) takes the direct path.
    const input = screen.getByLabelText('Feed name or URL') as HTMLInputElement;
    await user.type(input, 'ars technica');
    await user.click(await screen.findByText('Ars Technica'));
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    // While the title override is pending, the user starts the next URL.
    await user.clear(input);
    await user.type(input, 'https://other.example.com');

    await act(async () => {
      source.release();
      await source.completed;
      await Promise.resolve();
    });

    // The token must be re-checked after the await, so the resumed handler
    // doesn't wipe the newer input.
    expect(input.value).toBe('https://other.example.com');
  });

  it('disables the picker checkboxes while a subscribe is in flight', async () => {
    const user = userEvent.setup();
    const source = new GatedSubscribeSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('https://news.example.com');
    const picker = await screen.findByRole('group', { name: /choose feeds/i });
    await user.click(screen.getByText('Sport'));
    await user.click(screen.getByRole('button', { name: /^Subscribe$/ }));

    // The request snapshotted the selection; the picker checkboxes must lock so
    // the visible selection can't drift from what's being committed.
    for (const box of within(picker).getAllByRole('checkbox')) {
      expect(box).toHaveProperty('disabled', true);
    }

    // Let the in-flight subscribe settle so no timer/promise outlives the test.
    await act(async () => {
      source.release();
      await source.completed;
      await Promise.resolve();
    });
  });

  it('closes the picker without subscribing when cancelled', async () => {
    const user = userEvent.setup();
    const source = new MultiFeedSource(`test-${Math.random()}`);
    const before = (await source.getSubscriptions()).length;
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('https://news.example.com');
    await screen.findByRole('group', { name: /choose feeds/i });
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));

    expect(screen.queryByRole('group', { name: /choose feeds/i })).toBeNull();
    expect((await source.getSubscriptions()).length).toBe(before);
  });

  it('shows the real feed title in the subscription list after subscribing via URL (non-curated)', async () => {
    // Regression: feed-meta invalidation must happen unconditionally, not only
    // when a curated title override is applied.  A subscribe via typed URL that
    // returns a proper title from the server should appear in the list without
    // the user having to reload.
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });

    await addFeed('https://example.com/rss');

    await screen.findByText(/^Subscribed to /);
    // The subscriptions list re-renders; the server-returned title must appear
    // rather than staying blank or showing "Untitled feed".
    await waitFor(() => {
      expect(screen.queryByText('Untitled feed')).toBeNull();
    });
    const subs = await source.getSubscriptions();
    expect(subs.length).toBeGreaterThan(0);
  });
});

describe('FeedsPage — curated section picker', () => {
  const bbc = PUBLISHERS.find((p) => p.name === 'BBC')!;

  it('opens the section picker (main feed first) the moment a sectioned publisher is picked', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const discoverSpy = vi.spyOn(source, 'discover');
    renderWithProviders(<FeedsPage />, { source });

    // Tapping the suggestion itself opens the picker — no separate "Add" tap,
    // and no falling through to discovery on the exact feed URL it fills in.
    await user.type(screen.getByLabelText('Feed name or URL'), 'bbc news');
    // Scope to the suggestion listbox: BBC News is also a seeded subscription in
    // the feed list below, so an unscoped query would match twice.
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText('BBC News'));

    const picker = await screen.findByRole('group', { name: /choose feeds/i });
    // Every curated BBC section is offered, main feed first.
    for (const section of bbc.sections) {
      expect(within(picker).getByText(section.name)).toBeTruthy();
    }
    const labels = within(picker)
      .getAllByText(/^BBC /)
      .map((el) => el.textContent);
    expect(labels[0]).toBe(bbc.sections[0].name);
    // The picked section is pre-checked so the user's choice isn't lost, with
    // the rest one tap away. Subscribe is therefore enabled already.
    const newsCheckbox = within(picker)
      .getByText('BBC News')
      .closest('label')!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(newsCheckbox.checked).toBe(true);
    // Curated sections need no live discovery.
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('opens the picker with nothing pre-checked when picking the publisher main feed by site URL', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });

    // A whole-site add (typed site URL) selects no specific section, so the
    // Subscribe button stays disabled until the user checks something.
    await user.type(screen.getByLabelText('Feed name or URL'), 'bbc.com');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByRole('group', { name: /choose feeds/i });
    expect(screen.getByRole('button', { name: /^Subscribe$/ })).toHaveProperty('disabled', true);
  });

  it('opens the section picker when a publisher SITE URL is typed (no discovery, no Google News)', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const discoverSpy = vi.spyOn(source, 'discover');
    renderWithProviders(<FeedsPage />, { source });

    // Typing the bare site (the case that used to fall through to Google News).
    await user.type(screen.getByLabelText('Feed name or URL'), 'bbc.com');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    expect(await screen.findByRole('group', { name: /choose feeds/i })).toBeTruthy();
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('subscribes the selected sections and pins each section label', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const setSpy = vi.spyOn(source, 'setTitleOverride');
    const before = (await source.getSubscriptions()).length;
    renderWithProviders(<FeedsPage />, { source });

    await user.type(screen.getByLabelText('Feed name or URL'), 'bbc.com');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    const picker = await screen.findByRole('group', { name: /choose feeds/i });

    await user.click(within(picker).getByText('BBC World'));
    await user.click(within(picker).getByText('BBC Sport'));
    await user.click(screen.getByRole('button', { name: /^Subscribe to 2$/ }));

    await screen.findByText('Subscribed to 2 feeds');
    await waitFor(async () => {
      expect((await source.getSubscriptions()).length).toBe(before + 2);
    });
    // Each chosen section's label is pinned as the per-user title override, so
    // the rows read "BBC World"/"BBC Sport" rather than a generic channel title.
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), 'BBC World');
    expect(setSpy).toHaveBeenCalledWith(expect.any(String), 'BBC Sport');
  });

  it('subscribes directly to a pasted publisher FEED url (no section picker)', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const discoverSpy = vi.spyOn(source, 'discover');
    renderWithProviders(<FeedsPage />, { source });

    // A specific Guardian section feed lives on theguardian.com itself; pasting
    // it "meant that feed", so it must go straight to discovery/subscribe, not
    // expand to the whole-publisher section picker.
    await user.type(
      screen.getByLabelText('Feed name or URL'),
      'https://www.theguardian.com/world/rss',
    );
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    await screen.findByText(/^Subscribed to /);
    expect(screen.queryByRole('group', { name: /choose feeds/i })).toBeNull();
    expect(discoverSpy).toHaveBeenCalled();
  });

  it('clears the section picker when the URL field is edited', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });

    await user.type(screen.getByLabelText('Feed name or URL'), 'bbc.com');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByRole('group', { name: /choose feeds/i });

    await user.type(screen.getByLabelText('Feed name or URL'), 'x');
    expect(screen.queryByRole('group', { name: /choose feeds/i })).toBeNull();
  });
});

describe('FeedsPage — Subscriptions', () => {
  it('renders drag handles for reordering subscriptions', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });
    const handles = await screen.findAllByTestId('sub-drag-handle');
    expect(handles.length).toBeGreaterThan(0);
  });
});

describe('FeedsPage — OPML import', () => {
  /** Feed the hidden file input directly — the visible Import button just
   * proxies a click to it. */
  function uploadOpml(container: HTMLElement, contents: string) {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toBeTruthy();
    const file = new File([contents], 'subs.opml', { type: 'text/xml' });
    // jsdom's File doesn't implement the Blob.text() the handler reads;
    // supply it (the browser platform API, not app logic under test).
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(contents) });
    fireEvent.change(input!, { target: { files: [file] } });
  }

  it('shows the added/skipped toast after a successful import', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const { container } = renderWithProviders(<FeedsPage />, { source });
    await screen.findAllByTestId('sub-drag-handle'); // page settled

    uploadOpml(
      container,
      '<opml><body><outline type="rss" xmlUrl="https://imported.example.com/feed" /></body></opml>',
    );

    await screen.findByText('Imported 1, skipped 0');
  });

  it('surfaces an import failure instead of dying silently', async () => {
    // Regression: onImport had no catch and its caller doesn't await it, so a
    // rejected importOpml produced no toast, no list refresh, and an unhandled
    // rejection — the user had no idea whether anything was imported.
    class FailingImportSource extends MockDataSource {
      async importOpml(): Promise<{ added: number; skipped: number }> {
        throw new Error('server down');
      }
    }
    const source = new FailingImportSource(`test-${Math.random()}`);
    const { container } = renderWithProviders(<FeedsPage />, { source });
    await screen.findAllByTestId('sub-drag-handle');

    uploadOpml(container, '<opml><body></body></opml>');

    await screen.findByText('Import failed');
  });

  it('surfaces an export failure instead of dying silently', async () => {
    // Same shape as the import regression: onExport had no catch and its
    // caller doesn't await it, so a rejected exportOpml (offline, signed-out,
    // server down) produced no file, no toast — only an unhandled rejection in
    // a console a phone user can't see.
    class FailingExportSource extends MockDataSource {
      async exportOpml(): Promise<string> {
        throw new Error('server down');
      }
    }
    const source = new FailingExportSource(`test-${Math.random()}`);
    renderWithProviders(<FeedsPage />, { source });
    await screen.findAllByTestId('sub-drag-handle');

    fireEvent.click(screen.getByRole('button', { name: /export/i }));

    await screen.findByText('Export failed');
  });
});
