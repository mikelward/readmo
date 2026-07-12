import { useEffect, useRef, useState, useId } from 'react';
import { useSearchParams } from 'react-router-dom';
import { POPULAR_FEEDS, RECOMMENDED_FEEDS } from '../lib/popularFeeds';
import { searchFeeds, resolveFeedByName } from '../lib/feedSearch';
import {
  publisherForUrl,
  looksLikeFeedUrl,
  MAX_SECTIONS,
  type Publisher,
} from '../lib/feedSections';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import {
  AddFeedError,
  type AddFeedErrorKind,
  type DiscoveredFeed,
} from '../lib/data/DataSource';
import { expandFeedShorthand } from '../lib/feedShorthand';
import { ReorderableSubscriptions } from '../components/ReorderableSubscriptions';
import { usePageTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { presentableDetail } from '../lib/loadErrorCopy';
import type { Feed, FeedId } from '../lib/types';
// Feed management reuses the settings page's section/control styles — the two
// pages share the same visual vocabulary (sections, buttons, list rows).
import './SettingsPage.css';
import './PageHeader.css';

/** User-facing copy for each way "Add a feed" can fail. Keyed by
 * {@link AddFeedErrorKind} so every classified case has a specific message. */
const ADD_FEED_MESSAGES: Record<AddFeedErrorKind, string> = {
  'signed-out': 'You’re signed out. Sign in again to add feeds.',
  'feed-auth': 'That feed requires a login, so it can’t be added.',
  'no-feed': 'No feed found at that URL.',
  'not-found': 'That URL could not be found (404).',
  unreachable: 'Couldn’t reach that URL. Check the address and try again.',
  blocked: 'Google News feeds aren’t available on this account.',
  'feed-limit': 'You’ve reached the feed limit. Remove a feed to add another.',
  unknown: 'Couldn’t add that feed. Please try again.',
};

function addFeedMessage(err: unknown): string {
  if (err instanceof AddFeedError) return ADD_FEED_MESSAGES[err.kind];
  return ADD_FEED_MESSAGES.unknown;
}

/** The underlying cause shown behind the toast's "Details" disclosure — the
 * same text we log. AddFeedError defaults its message to the kind when no server
 * detail was attached, which is redundant with the headline, so only surface a
 * real underlying message. */
function addFeedDetail(err: unknown): string | undefined {
  if (err instanceof AddFeedError) {
    return err.message && err.message !== err.kind ? err.message : undefined;
  }
  return presentableDetail(err) ?? undefined;
}

export function FeedsPage() {
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  // The single feed page's settings pencil links here with `?feed=<id>`; the
  // subscriptions list scrolls that row into view and briefly highlights it so
  // the user lands on the feed they came from.
  const [searchParams] = useSearchParams();
  const scrollToFeedId = searchParams.get('feed');
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Pending timer for the suggestion-dropdown close-on-blur. Tracked so it can
  // be cleared on unmount — otherwise it fires after the component is gone and
  // calls setState on a torn-down tree (in tests: "window is not defined").
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
  }, []);
  const [feedUrl, setFeedUrl] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  // When discovery finds more than one feed (e.g. a site advertising per-section
  // feeds — Sport, World news — alongside its main feed), we surface a picker
  // instead of silently subscribing to the first candidate. `picker` holds the
  // candidates; `selected` holds the URLs the user has checked.
  const [picker, setPicker] = useState<DiscoveredFeed[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // True when the open picker holds curated publisher *sections* (from
  // feedSections), whose row titles are real section labels we pin as the
  // per-user title override on subscribe. False for a live-discovery picker,
  // whose titles are the publishers' own <channel><title> and aren't pinned.
  const [pickerCurated, setPickerCurated] = useState(false);
  const suggestionsId = useId();

  // Monotonic token for the in-flight discovery request. Discovery can take
  // seconds (fetch + probe each candidate) while the input stays editable, so a
  // result must only be applied if it's still the latest request — otherwise a
  // slow site-A discovery could resolve and open its picker under a since-edited
  // site-B input. `clearPicker` bumps this, so any context change supersedes a
  // pending discovery as well as dropping the rendered picker.
  const discoverSeq = useRef(0);

  // The picker belongs to the exact URL that produced it. Drop it (and any
  // selection) whenever the add context changes — a new submit, a typed edit,
  // an autocomplete pick, or cancel — so its rows and the enabled Subscribe
  // button can never act on a feed set that no longer matches the input, and
  // invalidate any discovery still in flight for the previous input.
  const clearPicker = () => {
    discoverSeq.current += 1;
    setPicker(null);
    setSelected(new Set());
    setPickerCurated(false);
  };

  // Open the multi-feed picker on a publisher's curated sections (main feed
  // first, capped at MAX_SECTIONS). Used when the user adds a known publisher by
  // name/dropdown pick or by its site URL — its sections aren't autodiscoverable
  // (e.g. BBC advertises none on its home page), so we offer the curated set
  // rather than falling through to live discovery / Google News.
  // `preselectUrl` pre-checks one section — the specific feed the user picked
  // (e.g. tapping "BBC Sport" opens all BBC sections with Sport already ticked),
  // so their pick isn't lost while the rest stay one tap away. Omitted for a
  // whole-site add (a typed site URL), where nothing is pre-checked.
  const openSectionPicker = (pub: Publisher, preselectUrl?: string) => {
    const sections = pub.sections.slice(0, MAX_SECTIONS);
    setSelected(
      preselectUrl && sections.some((s) => s.feedUrl === preselectUrl)
        ? new Set([preselectUrl])
        : new Set(),
    );
    setPickerCurated(true);
    setPicker(
      sections.map((s) => ({
        url: s.feedUrl,
        title: s.name,
        siteUrl: null,
        sampleTitles: [],
      })),
    );
  };

  // True when feedUrl was filled from the curated list; skip discover in that case.
  const isFromSuggestion = useRef(false);
  // Display name of the curated suggestion that was selected, so we can use it
  // as a title override if the server-side refresh fails to populate the feed.
  const selectedSuggestionName = useRef<string | null>(null);

  // Apply a chosen autocomplete suggestion: fill the box with its feed URL and,
  // for a publisher we carry sections for, open the section picker right away —
  // so tapping "BBC News"/"BBC Sport" shows the sections on the tap itself
  // rather than only after a separate "Add". Other (single-feed) suggestions
  // just fill the URL and subscribe on Add, as before.
  const selectSuggestion = (feed: { name: string; feedUrl: string }) => {
    isFromSuggestion.current = true;
    selectedSuggestionName.current = feed.name;
    setFeedUrl(feed.feedUrl);
    setShowSuggestions(false);
    setActiveIdx(-1);
    clearPicker();
    const pub = publisherForUrl(feed.feedUrl);
    if (pub) openSectionPicker(pub, feed.feedUrl);
  };

  // Autocomplete content. While the user types, fuzzy-match the catalog (see
  // searchFeeds): substring on the name, feed URL (so a country code like
  // "au"/"uk" finds .com.au / .co.uk), or category (so a topic like "science"
  // surfaces that section), plus acronym matching so "wsj" finds "Wall Street
  // Journal". With the box empty, show the curated RECOMMENDED_FEEDS as the top
  // suggestions, so focusing the field offers a starting point.
  const suggestions = feedUrl.trim().length > 0
    ? searchFeeds(feedUrl, POPULAR_FEEDS).slice(0, 8)
    : RECOMMENDED_FEEDS;
  usePageTitle('Feeds');

  const { data: subs = [] } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => ds.getSubscriptions(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    queryClient.invalidateQueries({ queryKey: ['folders'] });
    queryClient.invalidateQueries({ queryKey: ['feed'] });
  };

  // Best-effort post-subscribe bookkeeping shared by every path (curated,
  // single-candidate, and the multi-select picker): re-fetch the title and fire
  // a refresh retry. subscribe() awaits refresh() internally, but refresh errors
  // are swallowed there, so this gives a failed initial fetch a second chance
  // before the cron picks it up (up to 5 min away).
  const settleFeed = (feed: Feed) => {
    queryClient.invalidateQueries({ queryKey: ['feed-meta', feed.id] });
    ds.refresh(feed.id).then(() => invalidate()).catch(() => {});
  };

  // Subscribe to one or more already-resolved feed URLs. `names[i]` is the
  // curated label to pin for `urls[i]` (a curated-suggestion brand name, or a
  // chosen publisher section's label), or null to keep the publisher's own
  // title. The two arrays are positional and the same length.
  const subscribeFeeds = useMutation({
    mutationFn: async ({
      urls,
      names,
      seq,
    }: {
      urls: string[];
      names: (string | null)[];
      seq: number;
    }) => {
      // allSettled, not all: subscribe_to_feed commits one URL at a time with no
      // transaction spanning the selection, so a multi-feed pick where one URL
      // conflicts/is gated must not discard the ones that did commit. Partition
      // the outcomes and let onSuccess surface + invalidate the successes
      // regardless of any failures.
      //
      // Snapshot the currently-subscribed feed ids before subscribing so the
      // curated-override path can tell a fresh add from a re-add of a feed the
      // user already follows. subscribe() is idempotent and returns the existing
      // feed unchanged; without this guard a re-add through the curated
      // suggestion would silently overwrite the user's per-row rename.
      const preSubIds = new Set(
        (await ds.getSubscriptions()).map((s) => s.feed.id),
      );
      const settled = await Promise.allSettled(urls.map((u) => ds.subscribe(u)));
      const feeds: Feed[] = [];
      // The curated label to pin for each *committed* feed, positionally
      // aligned with `feeds` (allSettled preserves `urls` order, so index i of
      // settled maps to names[i]).
      const feedNames: (string | null)[] = [];
      const errors: unknown[] = [];
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          feeds.push(r.value);
          feedNames.push(names[i] ?? null);
        } else {
          errors.push(r.reason);
        }
      });
      return { feeds, feedNames, errors, seq, preSubIds };
    },
    onSuccess: async ({ feeds, feedNames, errors, seq, preSubIds }) => {
      // subscribe() awaits a publisher refresh and can take seconds, during which
      // the input stays editable. If the user has moved on (typed a new URL,
      // started another add) the add context is no longer ours: bumped token.
      // Data ops below reflect what actually committed and always run; only the
      // input/picker mutations are gated so they can't clobber the new context.
      // The token is re-read at each use (never snapshot) because an awaited
      // setTitleOverride below can let the user supersede us mid-handler.
      // Nothing committed: surface the failure (only if still current, to avoid a
      // stale error over a new add) and leave the input/picker as-is to retry.
      if (feeds.length === 0) {
        if (errors[0]) console.warn('Subscribe failed:', errors[0]);
        if (seq === discoverSeq.current)
          showToast({
            message: addFeedMessage(errors[0]),
            detail: addFeedDetail(errors[0]),
          });
        return;
      }
      // Pin each fresh subscription's curated label: the brand the user picked
      // (e.g. "The Economist") or the chosen publisher section ("BBC World"),
      // which beats whatever the publisher's <channel> happens to say (The
      // Economist's /latest/rss.xml is literally titled "Latest Updates"; BBC's
      // section feeds share a generic title). The override is per-user and
      // editable in this page. Skipped when the feed was already in this user's
      // subscriptions — subscribe() is idempotent for an existing row, so a
      // re-add must never clobber a rename the user applied earlier.
      await Promise.all(
        feeds.map((feed, i) => {
          const name = feedNames[i];
          if (name && !preSubIds.has(feed.id)) {
            return ds.setTitleOverride(feed.id, name).catch(() => {});
          }
          return Promise.resolve();
        }),
      );
      // Always invalidate feed-meta so FeedPage re-fetches the post-subscribe
      // title regardless of whether a curated override was applied.
      feeds.forEach(settleFeed);
      invalidate();
      if (errors[0]) console.warn('Subscribe partially failed:', errors[0]);
      // Reset the input/picker only if this add is still the current one —
      // re-read after the await above so a mid-handler edit isn't clobbered.
      if (seq === discoverSeq.current) {
        selectedSuggestionName.current = null;
        setFeedUrl('');
        clearPicker();
      }
      // Some succeeded; if others failed, say so rather than silently dropping.
      const firstName = feeds.length === 1 ? feedNames[0] ?? feeds[0].title : null;
      const message =
        errors.length > 0
          ? `Subscribed to ${feeds.length} feed${feeds.length > 1 ? 's' : ''}; ` +
            `${errors.length} couldn’t be added`
          : feeds.length === 1
            ? `Subscribed to ${firstName}`
            : `Subscribed to ${feeds.length} feeds`;
      showToast({ message });
    },
    onError: (err) => {
      // allSettled means mutationFn won't reject for a feed-level failure; this
      // is a safety net for anything unexpected.
      console.warn('Subscribe failed:', err);
      showToast({ message: addFeedMessage(err), detail: addFeedDetail(err) });
    },
  });

  // Run HTML discovery for a typed URL, then either subscribe straight away
  // (0–1 candidates, today's behavior) or open the picker (2+ candidates, e.g.
  // a site advertising per-section feeds) so the user chooses which to follow.
  const discoverFeeds = useMutation({
    mutationFn: async ({ url, seq }: { url: string; seq: number }) => {
      // discover() already tries parsing the target itself as a feed, so an
      // empty list means the URL is neither a feed nor advertises one. Do NOT
      // fall back to subscribing to the raw (non-feed) URL: that stored a feed
      // the server can only ever fetch as HTML, leaving it stuck as "Untitled
      // feed" with no items. Surface a clear error instead.
      const candidates = await ds.discover(url);
      if (candidates.length === 0) throw new AddFeedError('no-feed');
      return { candidates, seq };
    },
    onSuccess: ({ candidates, seq }) => {
      // Drop a superseded discovery: the user edited the URL or started a new
      // add while this request was in flight, so its results no longer match
      // the input. Applying them would subscribe / open a picker for the wrong
      // site.
      if (seq !== discoverSeq.current) return;
      if (candidates.length === 1) {
        subscribeFeeds.mutate({ urls: [candidates[0].url], names: [null], seq });
        return;
      }
      setSelected(new Set());
      // A live-discovery picker: its row titles are publisher channel titles,
      // not curated labels, so they aren't pinned on subscribe.
      setPickerCurated(false);
      setPicker(candidates);
    },
    onError: (err, { seq }) => {
      // Log the underlying detail (server message / status) regardless, so the
      // exact cause is visible in devtools.
      console.warn('Discover feed failed:', err);
      // But only surface the toast if this is still the latest request —
      // mirror onSuccess so a superseded discovery's failure can't pop a stale
      // no-feed/unreachable error over the user's new add context.
      if (seq !== discoverSeq.current) return;
      showToast({ message: addFeedMessage(err), detail: addFeedDetail(err) });
    },
  });

  const isAdding = discoverFeeds.isPending || subscribeFeeds.isPending;

  // Submit handler: curated suggestions have a known, validated feed URL —
  // subscribe directly and skip the discover round-trip so a discover outage or
  // bot-block on the site's homepage can't prevent subscribing to a well-known
  // feed. Everything else goes through discovery.
  const onSubmitAddFeed = (url: string) => {
    // Any prior picker belongs to the previous add attempt. Clear it before
    // starting a new one so a failed/single-candidate discovery for site B
    // can't leave site A's picker on screen — subscribable under the new input.
    // clearPicker also bumps discoverSeq, superseding any in-flight discovery.
    clearPicker();
    // Tag every request with the current token; the resolver applies its result
    // (or clears the input/picker) only if this is still the latest add.
    const seq = discoverSeq.current;
    if (isFromSuggestion.current) {
      isFromSuggestion.current = false;
      // A curated pick for a publisher we carry sections for opens the section
      // picker (BBC News → all BBC sections, main first) instead of subscribing
      // to just the one picked feed.
      const pub = publisherForUrl(url);
      if (pub) {
        openSectionPicker(pub, url);
        return;
      }
      // Otherwise subscribe straight to the picked feed (bypassing discovery as
      // before). Capture the curated name synchronously so a concurrent
      // autocomplete interaction can't overwrite it while the request is
      // in-flight.
      subscribeFeeds.mutate({ urls: [url], names: [selectedSuggestionName.current], seq });
      return;
    }
    // Expand a known shorthand ("r/sub" → reddit.com; "youtube/<handle>" →
    // youtube.com/@<handle>) before anything else; reflect it in the box so the
    // user sees what's being added. A shorthand is an explicit "go fetch this"
    // request, so it goes straight to discovery and skips name resolution (even
    // though e.g. "r/programming" happens to substring-match a catalog feed's
    // URL). The server derives the .rss feed form for Reddit and discovery picks
    // up YouTube's <link rel="alternate"> from the channel page (SPEC.md "Feed
    // discovery").
    const expanded = expandFeedShorthand(url);
    if (expanded !== url) {
      setFeedUrl(expanded);
      discoverFeeds.mutate({ url: expanded, seq });
      return;
    }
    // The field accepts a feed *name*, not just a URL (placeholder "Feed name or
    // URL"). If a typed entry resolves unambiguously to a catalog feed (exact
    // name, or exactly one match — see resolveFeedByName), subscribe via the
    // curated path instead of sending the raw name to discover() as a bogus URL.
    // So "wsj", "Wall Street Journal", and dotted names like "The A.V. Club"
    // work without picking from the dropdown; broad/ambiguous queries and real
    // URLs fall through to discovery.
    const nameMatch = resolveFeedByName(url, POPULAR_FEEDS);
    if (nameMatch) {
      // A resolved name for a sectioned publisher opens its section picker; any
      // other catalog name subscribes directly with its curated brand name.
      const pub = publisherForUrl(nameMatch.feedUrl);
      if (pub) {
        openSectionPicker(pub, nameMatch.feedUrl);
        return;
      }
      selectedSuggestionName.current = nameMatch.name;
      subscribeFeeds.mutate({ urls: [nameMatch.feedUrl], names: [nameMatch.name], seq });
      return;
    }
    // A pasted *site* URL for a publisher we carry sections for → its sections.
    // A pasted *feed* URL "meant that feed" (even on that publisher's host), so
    // skip expansion and let discovery subscribe to it directly below.
    const sitePub = publisherForUrl(url, { sitesOnly: true });
    if (sitePub && !looksLikeFeedUrl(url)) {
      openSectionPicker(sitePub);
      return;
    }
    discoverFeeds.mutate({ url, seq });
  };

  const toggleCandidate = (url: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const onImport = async (file: File) => {
    try {
      const xml = await file.text();
      const result = await ds.importOpml(xml);
      invalidate();
      showToast({ message: `Imported ${result.added}, skipped ${result.skipped}` });
    } catch (err) {
      // importOpml skips per-entry failures, so reaching here means the import
      // itself failed (unreadable file, signed-out session, server down). Some
      // entries may have subscribed before the failure — refresh the list so
      // they show, and surface the failure instead of dying silently (the call
      // site doesn't await this handler).
      console.warn('OPML import failed:', err);
      invalidate();
      showToast({ message: 'Import failed', detail: addFeedDetail(err) });
    }
  };

  const onExport = async () => {
    try {
      const xml = await ds.exportOpml();
      const blob = new Blob([xml], { type: 'text/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'readmo-subscriptions.opml';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      // The click handler doesn't await this, so an unguarded rejection
      // (offline, signed-out session, server down) died as an unhandled
      // rejection: no file, no feedback. Surface it like Import does.
      console.warn('OPML export failed:', err);
      showToast({ message: 'Export failed', detail: addFeedDetail(err) });
    }
  };

  return (
    <div className="settings">
      <div className="page-header">
        <h1 className="page-header__title">Feeds</h1>
      </div>

      <section className="settings__section">
        <h2 className="settings__heading">Add a feed</h2>
        <form
          className="settings__add"
          onSubmit={(e) => {
            e.preventDefault();
            setShowSuggestions(false);
            if (feedUrl.trim()) onSubmitAddFeed(feedUrl.trim());
          }}
        >
          <div className="settings__add-wrap">
            <input
              // type="text" (not "url") so the browser doesn't reject a bare
              // site name like "example.com" before submit — discovery prepends
              // https:// itself. inputMode hints a URL keyboard on mobile.
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="search-input"
              placeholder="Feed name or URL"
              value={feedUrl}
              aria-label="Feed name or URL"
              aria-autocomplete="list"
              aria-controls={suggestionsId}
              aria-activedescendant={
                activeIdx >= 0 ? `${suggestionsId}-${activeIdx}` : undefined
              }
              onChange={(e) => {
                isFromSuggestion.current = false;
                selectedSuggestionName.current = null;
                setFeedUrl(e.target.value);
                setShowSuggestions(true);
                setActiveIdx(-1);
                // Editing the URL invalidates an open picker (it was discovered
                // for the old text); drop it so it can't subscribe under the new.
                clearPicker();
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => {
                // Delay so a click on a suggestion registers first. Cleared on
                // unmount via the effect above so it can't setState post-teardown.
                if (blurTimer.current) clearTimeout(blurTimer.current);
                blurTimer.current = setTimeout(() => setShowSuggestions(false), 150);
              }}
              onKeyDown={(e) => {
                if (!showSuggestions || suggestions.length === 0) return;
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveIdx((i) => Math.max(i - 1, -1));
                } else if (e.key === 'Enter' && activeIdx >= 0) {
                  e.preventDefault();
                  selectSuggestion(suggestions[activeIdx]);
                } else if (e.key === 'Escape') {
                  setShowSuggestions(false);
                  setActiveIdx(-1);
                }
              }}
            />
            {showSuggestions && suggestions.length > 0 && (
              <ul
                id={suggestionsId}
                role="listbox"
                aria-label="Feed suggestions"
                className="settings__suggestions"
              >
                {suggestions.map((feed, i) => (
                  <li
                    key={feed.feedUrl}
                    id={`${suggestionsId}-${i}`}
                    role="option"
                    aria-selected={i === activeIdx}
                    className={
                      'settings__suggestion' +
                      (i === activeIdx ? ' is-active' : '')
                    }
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectSuggestion(feed);
                    }}
                  >
                    <span className="settings__suggestion-name">{feed.name}</span>
                    <span className="settings__suggestion-cat">{feed.category}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="submit" className="settings__btn" disabled={isAdding}>
            {isAdding ? 'Adding…' : 'Add'}
          </button>
        </form>
        <p className="settings__hint settings__add-hint">
          Type a site, a topic, or a country code to see suggestions.
        </p>

        {picker && (
          <div
            className="settings__picker"
            role="group"
            aria-label="Choose feeds to subscribe to"
          >
            <p className="settings__picker-hint">
              This site offers more than one feed. Choose the sections you want to follow:
            </p>
            <ul className="settings__picker-list">
              {picker.map((candidate) => {
                const checked = selected.has(candidate.url);
                return (
                  <li key={candidate.url}>
                    <label className="settings__picker-option">
                      <input
                        type="checkbox"
                        className="settings__picker-check"
                        checked={checked}
                        // Lock the selection while a subscribe is committing —
                        // the request snapshotted these URLs, so editing now
                        // would show a selection that differs from what's saved.
                        disabled={isAdding}
                        onChange={() => toggleCandidate(candidate.url)}
                      />
                      <span className="settings__picker-text">
                        <span className="settings__picker-title">{candidate.title}</span>
                        {candidate.sampleTitles.length > 0 && (
                          <span className="settings__picker-samples">
                            {candidate.sampleTitles.slice(0, 3).join(' · ')}
                          </span>
                        )}
                        <span className="settings__picker-url">{candidate.url}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="settings__picker-actions">
              <button
                type="button"
                className="settings__btn"
                disabled={selected.size === 0 || isAdding}
                onClick={() => {
                  const urls = [...selected];
                  // Pin the section label for a curated picker; a live-discovery
                  // picker keeps each publisher's own title (null).
                  const names = pickerCurated
                    ? urls.map((u) => picker?.find((c) => c.url === u)?.title ?? null)
                    : urls.map(() => null);
                  subscribeFeeds.mutate({ urls, names, seq: discoverSeq.current });
                }}
              >
                {isAdding
                  ? 'Adding…'
                  : selected.size > 1
                    ? `Subscribe to ${selected.size}`
                    : 'Subscribe'}
              </button>
              <button
                type="button"
                className="settings__btn"
                disabled={isAdding}
                onClick={clearPicker}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Subscriptions</h2>
        {subs.length > 1 ? (
          <p className="settings__hint">
            Drag the handles to set your feed order — it’s used by Group by feed.
          </p>
        ) : null}
        <ReorderableSubscriptions
          subs={subs}
          scrollToFeedId={scrollToFeedId}
          onReorder={async (orderedFeedIds: FeedId[]) => {
            await ds.reorderSubscriptions(orderedFeedIds);
            invalidate();
          }}
          onMute={async (feedId, muted) => {
            await ds.setMuted(feedId, muted);
            invalidate();
          }}
          onSetOpenMode={async (feedId, mode) => {
            // One atomic write of both open-mode booleans (setOpenMode), so the
            // flags can never be left transiently both-true on a partial failure.
            await ds.setOpenMode(feedId, mode);
            invalidate();
          }}
          onSetMarkDoneOnOpen={async (feedId, markDoneOnOpen) => {
            await ds.setMarkDoneOnOpen(feedId, markDoneOnOpen);
            // Re-read subscriptions so useMarkDoneOnOpenFeeds (which backs the
            // rows' open handlers and the reader's Open-original button) picks up
            // the change on the next render.
            invalidate();
          }}
          onSetListLayout={async (feedId, listLayout) => {
            await ds.setSubscriptionListLayout(feedId, listLayout);
            // Re-read subscriptions so useListLayoutFeeds (which backs every
            // article row's card style) picks up the change; the affected rows
            // re-render at the new layout.
            invalidate();
          }}
          onUnsubscribe={async (feedId) => {
            await ds.unsubscribe(feedId);
            invalidate();
          }}
          onRename={async (feedId, title) => {
            await ds.setTitleOverride(feedId, title);
            // The renamed title is embedded as `feed.title` on every cached
            // FeedItem the user has open. Invalidating ['feed-meta'] and the
            // standard subscriptions/feed buckets isn't enough — Library
            // views, Search, Offline, and the Reader page all carry their own
            // copies of the per-item feed object. Invalidate by key prefix so
            // any cached entry across those buckets is refetched on next view,
            // not after the 5-minute stale window expires.
            queryClient.invalidateQueries({ queryKey: ['feed-meta', feedId] });
            queryClient.invalidateQueries({ queryKey: ['library'] });
            queryClient.invalidateQueries({ queryKey: ['search'] });
            queryClient.invalidateQueries({ queryKey: ['offline'] });
            queryClient.invalidateQueries({ queryKey: ['item'] });
            invalidate();
          }}
        />
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">OPML</h2>
        <div className="settings__opml">
          <button type="button" className="settings__btn" onClick={() => fileRef.current?.click()}>
            Import
          </button>
          <button type="button" className="settings__btn" onClick={onExport}>
            Export
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".opml,.xml,text/xml"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImport(f);
              e.target.value = '';
            }}
          />
        </div>
      </section>
    </div>
  );
}
