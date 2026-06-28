import { Link } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import {
  useHideOnScroll,
  useBottomBarPosition,
  useItemSort,
  useGroupByFeed,
  type BottomBarPosition,
} from '../hooks/useReadingPrefs';
import type { ItemSort } from '../lib/data/DataSource';
import { useAuth } from '../hooks/useAuth';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { ThemeModeControl } from '../components/ThemeModeControl';
import { TextSizeControl } from '../components/TextSizeControl';
import { ColorThemeControl } from '../components/ColorThemeControl';
import {
  FONT_LABELS,
  FONT_STACKS,
  type FontFamily,
} from '../lib/theme';
import './SettingsPage.css';
import './PageHeader.css';

export function SettingsPage() {
  const { font, setFont } = useTheme();
  const { hideOnScroll, setHideOnScroll } = useHideOnScroll();
  const { bottomBarPosition, setBottomBarPosition } = useBottomBarPosition();
  const { itemSort, setItemSort } = useItemSort();
  const { groupByFeed, setGroupByFeed } = useGroupByFeed();
  const { user, signOut } = useAuth();
  useDocumentTitle('Settings · readmo');

  // Default first (SPEC.md *Bottom action bar*): the relative end-of-list footer
  // is the default; pinning to the viewport foot is the opt-in.
  const bottomBars: { value: BottomBarPosition; label: string }[] = [
    { value: 'list', label: 'Bottom of list' },
    { value: 'screen', label: 'Bottom of screen' },
  ];
  // Roboto first — it's the default (SPEC.md *Visual design → Typeface*). Each
  // chip previews in its own face below.
  const fonts: FontFamily[] = [
    'roboto',
    'inter',
    'public-sans',
    'work-sans',
    'fira-sans',
    'system',
  ];
  // Default first (SPEC.md *Feed views → Sort & grouping*): newest-first is the
  // default river order; oldest-first is the opt-in.
  const sortOrders: { value: ItemSort; label: string }[] = [
    { value: 'newest', label: 'Newest first' },
    { value: 'oldest', label: 'Oldest first' },
  ];

  return (
    <div className="settings">
      <div className="page-header">
        <h1 className="page-header__title">Settings</h1>
      </div>

      <section className="settings__section">
        <h2 className="settings__heading">Feeds</h2>
        <div className="settings__actions">
          <Link className="settings__btn" to="/feeds">
            Edit feeds
          </Link>
        </div>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Reading</h2>
        <ul className="settings__toggles">
          <li className="settings__toggle">
            <label className="settings__toggle-label">
              <input
                type="checkbox"
                className="settings__toggle-check"
                checked={hideOnScroll}
                onChange={(e) => setHideOnScroll(e.target.checked)}
              />
              <span className="settings__toggle-text">
                <span className="settings__toggle-title">
                  Hide articles as you scroll past
                </span>
                <span className="settings__toggle-desc">
                  Unpinned articles are marked Done once you scroll them off the
                  top of the screen. Pin an article to keep it.
                </span>
              </span>
            </label>
          </li>
          <li className="settings__toggle">
            <label className="settings__toggle-label">
              <input
                type="checkbox"
                className="settings__toggle-check"
                checked={groupByFeed}
                onChange={(e) => setGroupByFeed(e.target.checked)}
              />
              <span className="settings__toggle-text">
                <span className="settings__toggle-title">Group by feed</span>
                <span className="settings__toggle-desc">
                  Section Home and folder lists by feed, in the order your feeds
                  are arranged on the Feeds page, instead of one merged stream.
                </span>
              </span>
            </label>
          </li>
        </ul>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Sort order</h2>
        <div className="settings__theme" role="radiogroup" aria-label="Sort order">
          {sortOrders.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={itemSort === value}
              className={
                'settings__theme-btn' + (itemSort === value ? ' is-active' : '')
              }
              onClick={() => setItemSort(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Bottom toolbar</h2>
        <div
          className="settings__theme"
          role="radiogroup"
          aria-label="Bottom toolbar position"
        >
          {bottomBars.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={bottomBarPosition === value}
              className={
                'settings__theme-btn' +
                (bottomBarPosition === value ? ' is-active' : '')
              }
              onClick={() => setBottomBarPosition(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Color Theme</h2>
        <ColorThemeControl />
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Dark/Light Mode</h2>
        <ThemeModeControl />
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Text size</h2>
        <TextSizeControl />
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">Font</h2>
        <div className="settings__theme" role="radiogroup" aria-label="Font">
          {fonts.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={font === f}
              className={'settings__theme-btn' + (font === f ? ' is-active' : '')}
              // Preview each option in its own face. `system` falls back to the
              // native stack, matching what choosing it actually does.
              style={{ fontFamily: FONT_STACKS[f] }}
              onClick={() => setFont(f)}
            >
              {FONT_LABELS[f]}
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
        <div className="settings__actions">
          <Link className="settings__btn" to="/about">
            About
          </Link>
          <Link className="settings__btn" to="/legal">
            Legal
          </Link>
        </div>
      </section>
    </div>
  );
}
