import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
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
      expect(screen.getByText('AP News')).toBeTruthy();
    });
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
