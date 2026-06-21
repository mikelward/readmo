import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import type { Theme } from '../lib/theme';
import './SettingsPage.css';
import './PageHeader.css';

export function SettingsPage() {
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const { user, signOut } = useAuth();
  const { showToast } = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [feedUrl, setFeedUrl] = useState('');
  useDocumentTitle('Settings · readmo');

  const { data: subs = [] } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => ds.getSubscriptions(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    queryClient.invalidateQueries({ queryKey: ['folders'] });
  };

  const addFeed = useMutation({
    mutationFn: async (url: string) => {
      const candidates = await ds.discover(url);
      const chosen = candidates[0]?.url ?? url;
      return ds.subscribe(chosen);
    },
    onSuccess: (feed) => {
      setFeedUrl('');
      invalidate();
      showToast({ message: `Subscribed to ${feed.title}` });
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
            if (feedUrl.trim()) addFeed.mutate(feedUrl.trim());
          }}
        >
          <input
            type="url"
            className="search-input"
            placeholder="Site or feed URL"
            value={feedUrl}
            onChange={(e) => setFeedUrl(e.target.value)}
            aria-label="Feed URL"
          />
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
        <h2 className="settings__heading">Theme</h2>
        <div className="settings__theme" role="radiogroup" aria-label="Theme">
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
    </div>
  );
}
