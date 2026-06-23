import { useRef, useState, useId } from 'react';
import { Link } from 'react-router-dom';
import { POPULAR_FEEDS } from '../lib/popularFeeds';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { AddFeedError, type AddFeedErrorKind } from '../lib/data/DataSource';
import { buildInfo, summarizeBuild } from '../lib/buildInfo';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import type { Palette, Theme } from '../lib/theme';
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
  unknown: 'Couldn’t add that feed. Please try again.',
};

function addFeedMessage(err: unknown): string {
  if (err instanceof AddFeedError) return ADD_FEED_MESSAGES[err.kind];
  return ADD_FEED_MESSAGES.unknown;
}

export function SettingsPage() {
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const { theme, palette, setTheme, setPalette } = useTheme();
  const { user, signOut } = useAuth();
  const { showToast } = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [feedUrl, setFeedUrl] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const suggestionsId = useId();
  // True when feedUrl was filled from the curated list; skip discover in that case.
  const isFromSuggestion = useRef(false);
  // Display name of the curated suggestion that was selected, so we can use it
  // as a title override if the server-side refresh fails to populate the feed.
  const selectedSuggestionName = useRef<string | null>(null);

  const suggestions = feedUrl.trim().length > 0
    ? POPULAR_FEEDS.filter((f) => {
        const q = feedUrl.toLowerCase();
        return f.name.toLowerCase().includes(q) || f.feedUrl.toLowerCase().includes(q);
      }).slice(0, 8)
    : [];
  useDocumentTitle('Settings · readmo');

  const { data: subs = [] } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => ds.getSubscriptions(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    queryClient.invalidateQueries({ queryKey: ['folders'] });
    queryClient.invalidateQueries({ queryKey: ['feed'] });
  };

  const addFeed = useMutation({
    mutationFn: async (url: string) => {
      // Curated suggestions have a known, validated feed URL — subscribe directly
      // and skip the discover round-trip so a discover outage or bot-block on the
      // site's homepage can't prevent subscribing to a well-known feed.
      if (isFromSuggestion.current) {
        isFromSuggestion.current = false;
        return ds.subscribe(url);
      }
      // discover() already tries parsing the target itself as a feed, so an
      // empty list means the URL is neither a feed nor advertises one. Do NOT
      // fall back to subscribing to the raw (non-feed) URL: that stored a feed
      // the server can only ever fetch as HTML, leaving it stuck as "Untitled
      // feed" with no items. Surface a clear error instead.
      const candidates = await ds.discover(url);
      const chosen = candidates[0]?.url;
      if (!chosen) throw new AddFeedError('no-feed');
      return ds.subscribe(chosen);
    },
    onSuccess: async (feed) => {
      const curated = selectedSuggestionName.current;
      selectedSuggestionName.current = null;
      setFeedUrl('');
      // If the server-side refresh didn't populate the feed (site_url stayed null,
      // meaning the feed URL couldn't be fetched right now), fall back to the
      // known curated name so the subscription never shows as "Untitled feed".
      if (curated && !feed.siteUrl) {
        await ds.setTitleOverride(feed.id, curated).catch(() => {});
        invalidate();
        showToast({ message: `Subscribed to ${curated} — posts will appear after the first sync` });
      } else {
        invalidate();
        showToast({ message: `Subscribed to ${feed.title}` });
      }
    },
    onError: (err) => {
      // Surface a specific reason to the user, and log the underlying detail
      // (server message / status) so the exact cause is visible in devtools.
      console.warn('Add feed failed:', err);
      showToast({ message: addFeedMessage(err) });
    },
  });

  const onImport = async (file: File) => {
    const xml = await file.text();
    const result = await ds.importOpml(xml);
    invalidate();
    showToast({ message: `Imported ${result.added}, skipped ${result.skipped}` });
  };

  const onExport = async () => {
    const xml = await ds.exportOpml();
    const blob = new Blob([xml], { type: 'text/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'readmo-subscriptions.opml';
    a.click();
    URL.revokeObjectURL(url);
  };

  const themes: Theme[] = ['light', 'dark', 'system'];
  const palettes: Palette[] = ['ink', 'turquoise'];

  return (
    <div className="settings">
      <div className="page-header">
        <h1 className="page-header__title">Settings</h1>
      </div>

      <section className="settings__section">
        <h2 className="settings__heading">Add a feed</h2>
        <form
          className="settings__add"
          onSubmit={(e) => {
            e.preventDefault();
            setShowSuggestions(false);
            if (feedUrl.trim()) addFeed.mutate(feedUrl.trim());
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
              placeholder="Site or feed URL"
              value={feedUrl}
              aria-label="Feed URL"
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
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => {
                // Delay so a click on a suggestion registers first.
                setTimeout(() => setShowSuggestions(false), 150);
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
                  isFromSuggestion.current = true;
                  selectedSuggestionName.current = suggestions[activeIdx].name;
                  setFeedUrl(suggestions[activeIdx].feedUrl);
                  setShowSuggestions(false);
                  setActiveIdx(-1);
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
                      isFromSuggestion.current = true;
                      selectedSuggestionName.current = feed.name;
                      setFeedUrl(feed.feedUrl);
                      setShowSuggestions(false);
                      setActiveIdx(-1);
                    }}
                  >
                    <span className="settings__suggestion-name">{feed.name}</span>
                    <span className="settings__suggestion-cat">{feed.category}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="submit" className="settings__btn" disabled={addFeed.isPending}>
            {addFeed.isPending ? 'Adding…' : 'Add'}
          </button>
        </form>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Subscriptions</h2>
        <ul className="settings__subs">
          {subs.map(({ feed, subscription }) => (
            <li key={feed.id} className="settings__sub">
              <div className="settings__sub-main">
                <div className="settings__sub-title">
                  {subscription.titleOverride ?? feed.title}
                </div>
                <div className="settings__sub-url">{feed.url}</div>
              </div>
              <label className="settings__mute">
                <input
                  type="checkbox"
                  checked={subscription.muted}
                  onChange={async (e) => {
                    await ds.setMuted(feed.id, e.target.checked);
                    invalidate();
                  }}
                />
                Mute
              </label>
              <button
                type="button"
                className="settings__unsub"
                onClick={async () => {
                  await ds.unsubscribe(feed.id);
                  invalidate();
                }}
              >
                Unsubscribe
              </button>
            </li>
          ))}
        </ul>
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

      <section className="settings__section">
        <h2 className="settings__heading">Palette</h2>
        <div className="settings__theme" role="radiogroup" aria-label="Palette">
          {palettes.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={palette === p}
              className={'settings__theme-btn' + (palette === p ? ' is-active' : '')}
              onClick={() => setPalette(p)}
            >
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Mode</h2>
        <div className="settings__theme" role="radiogroup" aria-label="Mode">
          {themes.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={theme === t}
              className={'settings__theme-btn' + (theme === t ? ' is-active' : '')}
              onClick={() => setTheme(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Account</h2>
        {user ? (
          <div className="settings__account">
            <div>
              <div className="settings__sub-title">{user.name}</div>
              <div className="settings__sub-url">{user.email}</div>
            </div>
            <button type="button" className="settings__unsub" onClick={signOut}>
              Sign out
            </button>
          </div>
        ) : (
          <p>You’re signed out.</p>
        )}
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">About</h2>
        <div className="settings__account">
          <div className="settings__sub-url">{summarizeBuild(buildInfo)}</div>
          <Link className="settings__btn" to="/debug">
            Debug
          </Link>
        </div>
      </section>
    </div>
  );
}
