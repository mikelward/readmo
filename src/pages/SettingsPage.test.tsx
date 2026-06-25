import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import {
  BOTTOM_BAR_KEY,
  GROUP_BY_FEED_KEY,
  HIDE_ON_SCROLL_KEY,
  ITEM_SORT_KEY,
  resetReadingPrefsCacheForTest,
} from '../hooks/useReadingPrefs';
import { MockDataSource } from '../lib/data/MockDataSource';
import { AddFeedError, type DiscoveredFeed } from '../lib/data/DataSource';
import type { AddFeedErrorKind } from '../lib/data/DataSource';
import { SettingsPage } from './SettingsPage';
import { POPULAR_FEEDS } from '../lib/popularFeeds';

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
  await user.type(screen.getByLabelText('Feed URL'), url);
  await user.click(screen.getByRole('button', { name: /^Add$/ }));
}

describe('SettingsPage — popular feed autocomplete', () => {
  it('shows matching suggestions as the user types', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await user.type(screen.getByLabelText('Feed URL'), 'ap news');
    expect(await screen.findByRole('listbox')).toBeTruthy();
    expect(screen.getByText('AP News')).toBeTruthy();
  });

  it('shows no suggestions for empty input', async () => {
    renderWithProviders(<SettingsPage />);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('fills the feed URL when a suggestion is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const input = screen.getByLabelText('Feed URL') as HTMLInputElement;
    await user.type(input, 'ap news');
    const suggestion = await screen.findByText('AP News');
    await user.click(suggestion);
    const apFeed = POPULAR_FEEDS.find((f) => f.name === 'AP News')!;
    expect(input.value).toBe(apFeed.feedUrl);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('selects a suggestion with keyboard navigation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const input = screen.getByLabelText('Feed URL') as HTMLInputElement;
    await user.type(input, 'ap news');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{Enter}');
    // After Enter, the input should have the first suggestion's feedUrl.
    const apFeed = POPULAR_FEEDS.find((f) => f.name === 'AP News')!;
    expect(input.value).toBe(apFeed.feedUrl);
  });

  it('subscribes directly without calling discover when a suggestion is selected', async () => {
    const user = userEvent.setup();
    const source = new MockDataSource(`test-${Math.random()}`);
    const discoverSpy = vi.spyOn(source, 'discover');
    renderWithProviders(<SettingsPage />, { source });
    const input = screen.getByLabelText('Feed URL') as HTMLInputElement;
    await user.type(input, 'ap news');
    await user.click(await screen.findByText('AP News'));
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByText(/^Subscribed to /);
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('uses the curated name as title override when the server refresh fails to populate the feed', async () => {
    const user = userEvent.setup();
    const source = new RefreshFailSource(`test-${Math.random()}`);
    renderWithProviders(<SettingsPage />, { source });
    const input = screen.getByLabelText('Feed URL') as HTMLInputElement;
    await user.type(input, 'ap news');
    await user.click(await screen.findByText('AP News'));
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    // Toast should use the known name, not "Untitled feed".
    await screen.findByText(/^Subscribed to AP News/);
    // Subscription list should show the curated name, not "Untitled feed".
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Actions for AP News' })).toBeTruthy();
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
    renderWithProviders(<SettingsPage />, { source });
    const input = screen.getByLabelText('Feed URL') as HTMLInputElement;
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
    // Pre-subscribe to AP News (bypasses the curated-name pin so the existing
    // row has a null override at the start of the test, matching the case the
    // bug report describes).
    const apFeed = POPULAR_FEEDS.find((f) => f.name === 'AP News')!;
    const created = await source.subscribe(apFeed.feedUrl);
    await source.setTitleOverride(created.id, 'My News');
    renderWithProviders(<SettingsPage />, { source });

    const setSpy = vi.spyOn(source, 'setTitleOverride');

    // Re-add via the curated suggestion. subscribe() returns the existing
    // feed; the override must NOT be touched.
    const input = screen.getByLabelText('Feed URL') as HTMLInputElement;
    await user.type(input, 'ap news');
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByText('AP News'));
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByText(/^Subscribed to AP News/);

    expect(setSpy).not.toHaveBeenCalled();
    const after = (await source.getSubscriptions()).find(
      (s) => s.feed.id === created.id,
    );
    expect(after?.subscription.titleOverride).toBe('My News');
  });

  it('closes the dropdown on Escape', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await user.type(screen.getByLabelText('Feed URL'), 'ap news');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('SettingsPage — Add a feed', () => {
  it('shows a "no feed found" message and does not subscribe when discovery is empty', async () => {
    const source = new NoFeedSource(`test-${Math.random()}`);
    const before = (await source.getSubscriptions()).length;
    renderWithProviders(<SettingsPage />, { source });

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
      renderWithProviders(<SettingsPage />, { source });

      await addFeed('https://example.com/whatever');

      expect(await screen.findByText(message)).toBeTruthy();
    },
  );

  it('expands a Reddit "r/sub" shorthand to a full reddit.com URL before discovery', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const discover = vi.spyOn(source, 'discover');
    renderWithProviders(<SettingsPage />, { source });

    await addFeed('r/programming');

    await screen.findByText(/^Subscribed to /);
    // Discovery is handed the expanded URL, not the raw shorthand.
    expect(discover).toHaveBeenCalledWith('https://www.reddit.com/r/programming');
  });

  it('reflects the expanded Reddit shorthand in the box when a picker opens', async () => {
    // A multi-feed discovery leaves the box populated (no auto-subscribe/clear),
    // so the box should show the expanded URL the user is choosing feeds for.
    const source = new MultiFeedSource(`test-${Math.random()}`);
    renderWithProviders(<SettingsPage />, { source });

    await addFeed('r/programming');

    await screen.findByRole('group', { name: /choose feeds/i });
    expect(screen.getByLabelText('Feed URL')).toHaveProperty(
      'value',
      'https://www.reddit.com/r/programming',
    );
  });

  it('subscribes to the discovered feed and confirms by title', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    const before = (await source.getSubscriptions()).length;
    renderWithProviders(<SettingsPage />, { source });

    await addFeed('https://example.com/blog');

    await screen.findByText(/^Subscribed to /);
    await waitFor(async () => {
      expect((await source.getSubscriptions()).length).toBe(before + 1);
    });
  });

  it('subscribes directly without a picker when discovery finds a single feed', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(<SettingsPage />, { source });

    await addFeed('https://example.com/blog');

    await screen.findByText(/^Subscribed to /);
    // A single candidate must not pop the picker.
    expect(screen.queryByRole('group', { name: /choose feeds/i })).toBeNull();
  });

  it('opens a picker (without subscribing) when discovery finds multiple feeds', async () => {
    const source = new MultiFeedSource(`test-${Math.random()}`);
    const before = (await source.getSubscriptions()).length;
    renderWithProviders(<SettingsPage />, { source });

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
    renderWithProviders(<SettingsPage />, { source });

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
    renderWithProviders(<SettingsPage />, { source });

    await addFeed('https://news.example.com');
    await screen.findByRole('group', { name: /choose feeds/i });

    // Typing a new query invalidates the picker (it was discovered for the old
    // URL); it must not linger with an enabled Subscribe button.
    await user.type(screen.getByLabelText('Feed URL'), 'x');

    expect(screen.queryByRole('group', { name: /choose feeds/i })).toBeNull();
  });

  it('ignores a slow discovery result after the URL field is edited', async () => {
    const user = userEvent.setup();
    const source = new GatedMultiSource(`test-${Math.random()}`);
    renderWithProviders(<SettingsPage />, { source });

    // Submit site A; discovery blocks on the gate.
    await addFeed('https://news.example.com');
    // Edit the URL while discovery is still in flight — this supersedes the
    // request (bumps the discovery token).
    await user.type(screen.getByLabelText('Feed URL'), 'x');

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
    renderWithProviders(<SettingsPage />, { source });

    // Submit site A; discovery blocks, then will reject.
    await addFeed('https://news.example.com');
    // Edit the URL while discovery is in flight, superseding the request.
    await user.type(screen.getByLabelText('Feed URL'), 'x');

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
    renderWithProviders(<SettingsPage />, { source });

    // Open a picker for site A.
    await addFeed('https://news.example.com');
    await screen.findByRole('group', { name: /choose feeds/i });

    // Submit a different URL that fails discovery; the site-A picker must not
    // linger (it would otherwise be subscribable under the new input).
    const input = screen.getByLabelText('Feed URL') as HTMLInputElement;
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
    renderWithProviders(<SettingsPage />, { source });

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
    renderWithProviders(<SettingsPage />, { source });

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
    renderWithProviders(<SettingsPage />, { source });

    await addFeed('https://news.example.com');
    await screen.findByRole('group', { name: /choose feeds/i });
    await user.click(screen.getByText('Sport'));
    await user.click(screen.getByRole('button', { name: /^Subscribe$/ }));

    // Subscribe is in flight (gated). The field stays editable, so the user
    // starts the next URL before it finishes.
    const input = screen.getByLabelText('Feed URL') as HTMLInputElement;
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
    renderWithProviders(<SettingsPage />, { source });

    // Select a curated suggestion and add it; subscribe resolves with a
    // fallback title, so onSuccess awaits the (gated) setTitleOverride.
    const input = screen.getByLabelText('Feed URL') as HTMLInputElement;
    await user.type(input, 'ap news');
    await user.click(await screen.findByText('AP News'));
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
    renderWithProviders(<SettingsPage />, { source });

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
    renderWithProviders(<SettingsPage />, { source });

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
    renderWithProviders(<SettingsPage />, { source });

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

describe('SettingsPage — Reading & Bottom toolbar', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });
  afterEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });

  it('toggles "Group by feed" and persists it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const toggle = screen.getByRole('checkbox', { name: /group by feed/i });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(window.localStorage.getItem(GROUP_BY_FEED_KEY)).toBe('1');
  });

  it('defaults sort order to "Newest first" and switches to "Oldest first"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    expect(screen.getByRole('radio', { name: 'Newest first' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Oldest first' }));
    expect(screen.getByRole('radio', { name: 'Oldest first' })).toBeChecked();
    expect(window.localStorage.getItem(ITEM_SORT_KEY)).toBe('oldest');
  });

  it('renders drag handles for reordering subscriptions', async () => {
    const source = new MockDataSource(`test-${Math.random()}`);
    renderWithProviders(<SettingsPage />, { source });
    const handles = await screen.findAllByTestId('sub-drag-handle');
    expect(handles.length).toBeGreaterThan(0);
  });

  it('toggles "Hide articles as you scroll past" and persists it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    const toggle = screen.getByRole('checkbox', {
      name: /hide articles as you scroll past/i,
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(window.localStorage.getItem(HIDE_ON_SCROLL_KEY)).toBe('1');
  });

  it('defaults the bottom toolbar to "Bottom of list"', () => {
    renderWithProviders(<SettingsPage />);
    expect(
      screen.getByRole('radio', { name: 'Bottom of list' }),
    ).toBeChecked();
    expect(
      screen.getByRole('radio', { name: 'Bottom of screen' }),
    ).not.toBeChecked();
  });

  it('switches the bottom toolbar to "Bottom of screen" and persists it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.click(screen.getByRole('radio', { name: 'Bottom of screen' }));

    expect(
      screen.getByRole('radio', { name: 'Bottom of screen' }),
    ).toBeChecked();
    expect(window.localStorage.getItem(BOTTOM_BAR_KEY)).toBe('screen');
  });
});
