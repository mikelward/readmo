import { Link } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import {
  useHideOnScroll,
  useHideOnScrollRemove,
  useBottomBarPosition,
  useItemSort,
  useGroupByFeed,
  useShowRowFavicon,
  useShowGroupFavicon,
  useHideSportsSpoilers,
  useAutoSummarizePinned,
  useListLayout,
  useSaveService,
  useAutoSaveOnFavorite,
  type BottomBarPosition,
  type ListLayout,
} from '../hooks/useReadingPrefs';
import { READ_LATER_SERVICES, type ReadLaterService } from '../lib/readLater';
import type { ItemSort } from '../lib/data/DataSource';
import { useCapabilities, canUseFullText } from '../hooks/useCapabilities';
import { useAuth } from '../hooks/useAuth';
import { usePageTitle } from '../hooks/useDocumentTitle';
import { ThemeModeControl } from '../components/ThemeModeControl';
import { TextSizeControl } from '../components/TextSizeControl';
import { ColorThemeControl } from '../components/ColorThemeControl';
import { NewshackerConnection } from '../components/NewshackerConnection';
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
  const { hideOnScrollRemove, setHideOnScrollRemove } =
    useHideOnScrollRemove();
  const { bottomBarPosition, setBottomBarPosition } = useBottomBarPosition();
  const { itemSort, setItemSort } = useItemSort();
  const { groupByFeed, setGroupByFeed } = useGroupByFeed();
  const { showRowFavicon, setShowRowFavicon } = useShowRowFavicon();
  const { showGroupFavicon, setShowGroupFavicon } = useShowGroupFavicon();
  const { hideSportsSpoilers, setHideSportsSpoilers } = useHideSportsSpoilers();
  const { autoSummarizePinned, setAutoSummarizePinned } =
    useAutoSummarizePinned();
  const { listLayout, setListLayout } = useListLayout();
  const { saveService, setSaveService } = useSaveService();
  const { autoSaveOnFavorite, setAutoSaveOnFavorite } = useAutoSaveOnFavorite();
  const capabilities = useCapabilities();
  // The spoiler-free rewrite only shows for allowlisted callers, so the toggle is
  // a no-op for anyone off the list — hide it there rather than offer a dead
  // control (disarmed allowlist → open to all, so it shows).
  const spoilerToggleVisible = canUseFullText(capabilities);
  // Auto-summaries are a family-only control. `family` implies the section is
  // already visible (family ⟹ canUseFullText), so this just gates the toggle.
  const summaryToggleVisible = capabilities.family;
  const { user, signOut } = useAuth();
  usePageTitle('Settings');

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
  // Default first (SPEC.md *Item row layout → Article layout*): the compact
  // title-only row is the default; the larger cards are the opt-in.
  const articleLayouts: { value: ListLayout; label: string }[] = [
    { value: 'title', label: 'Title only' },
    { value: 'thumbnail-small', label: 'Small thumbnail' },
    { value: 'thumbnail', label: 'Large thumbnail' },
    { value: 'excerpt', label: 'Excerpt' },
  ];
  // Save-service picker: None (default), then each service by short name
  // (dropping the "Save to " menu prefix). At most one is enabled.
  const saveServiceOptions: { value: ReadLaterService | null; label: string }[] =
    [
      { value: null, label: 'None' },
      ...READ_LATER_SERVICES.map((s) => ({
        value: s.service,
        label: s.label.replace(/^Save to /, ''),
      })),
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

      {/* Reading — how the list behaves. The settings that matter most, up top. */}
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
                  Mark Done as you scroll
                </span>
                <span className="settings__toggle-desc">
                  Dismiss articles when they scroll off the top of the screen.
                  Pin an article to keep it.
                </span>
              </span>
            </label>
          </li>
          {/* Qualifies the toggle above, so it only appears once that's on —
              the same "no dead controls" rule the spoiler toggle follows. */}
          {hideOnScroll ? (
            <li className="settings__toggle settings__toggle--sub">
              <label className="settings__toggle-label">
                <input
                  type="checkbox"
                  className="settings__toggle-check"
                  checked={hideOnScrollRemove}
                  onChange={(e) => setHideOnScrollRemove(e.target.checked)}
                />
                <span className="settings__toggle-text">
                  <span className="settings__toggle-title">
                    Remove them from the list
                  </span>
                </span>
              </label>
            </li>
          ) : null}
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
        <h3 className="settings__subheading">Sort order</h3>
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

      {/* Appearance — how things look/lay out. The four theme controls are folded
          under one heading (instead of one section each), followed by the minor
          display settings further down: the toolbar position, then the Feed
          icons group (icons on groups / on articles) at the very bottom. */}
      <section className="settings__section">
        <h2 className="settings__heading">Appearance</h2>

        <h3 className="settings__subheading">Color theme</h3>
        <ColorThemeControl />

        <h3 className="settings__subheading">Dark/light mode</h3>
        <ThemeModeControl />

        <h3 className="settings__subheading">Text size</h3>
        <TextSizeControl />

        <h3 className="settings__subheading">Font</h3>
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

        <h3 className="settings__subheading">Article layout</h3>
        <div
          className="settings__theme"
          role="radiogroup"
          aria-label="Article layout"
        >
          {articleLayouts.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={listLayout === value}
              className={
                'settings__theme-btn' + (listLayout === value ? ' is-active' : '')
              }
              onClick={() => setListLayout(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <h3 className="settings__subheading">Bottom toolbar</h3>
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

        <h3 className="settings__subheading">Feed icons</h3>
        <ul className="settings__toggles">
          <li className="settings__toggle">
            <label className="settings__toggle-label">
              <input
                type="checkbox"
                className="settings__toggle-check"
                checked={showGroupFavicon}
                onChange={(e) => setShowGroupFavicon(e.target.checked)}
              />
              <span className="settings__toggle-text">
                <span className="settings__toggle-title">
                  Show icons on groups
                </span>
              </span>
            </label>
          </li>
          <li className="settings__toggle">
            <label className="settings__toggle-label">
              <input
                type="checkbox"
                className="settings__toggle-check"
                checked={showRowFavicon}
                onChange={(e) => setShowRowFavicon(e.target.checked)}
              />
              <span className="settings__toggle-text">
                <span className="settings__toggle-title">
                  Show icons on articles
                </span>
              </span>
            </label>
          </li>
        </ul>
      </section>

      {/* Smart features — the AI-assisted extras. Gated on the allowlist
          capability (like the rewrite itself), so it's hidden — heading and all —
          for anyone off the list rather than showing a dead toggle. */}
      {spoilerToggleVisible || summaryToggleVisible ? (
        <section className="settings__section">
          <h2 className="settings__heading">Smart features</h2>
          <ul className="settings__toggles">
            {spoilerToggleVisible ? (
              <li className="settings__toggle">
                <label className="settings__toggle-label">
                  <input
                    type="checkbox"
                    className="settings__toggle-check"
                    checked={hideSportsSpoilers}
                    onChange={(e) => setHideSportsSpoilers(e.target.checked)}
                  />
                  <span className="settings__toggle-text">
                    <span className="settings__toggle-title">
                      Hide sports spoilers
                    </span>
                    <span className="settings__toggle-desc">
                      Rewrite sports headlines that give away a result, so the
                      score stays hidden until you open the article.
                    </span>
                  </span>
                </label>
              </li>
            ) : null}
            {summaryToggleVisible ? (
              <li className="settings__toggle">
                <label className="settings__toggle-label">
                  <input
                    type="checkbox"
                    className="settings__toggle-check"
                    checked={autoSummarizePinned}
                    onChange={(e) => setAutoSummarizePinned(e.target.checked)}
                  />
                  <span className="settings__toggle-text">
                    <span className="settings__toggle-title">
                      Auto generate summaries for pinned articles
                    </span>
                  </span>
                </label>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {/* Read later — pick one service the reader's ⋮ "Save to …" opens (None by
          default: save is opt-in), and optionally auto-save on favorite. */}
      <section className="settings__section">
        <h2 className="settings__heading">Read later</h2>
        <h3 className="settings__subheading">Save to</h3>
        <div
          className="settings__theme"
          role="radiogroup"
          aria-label="Save to"
        >
          {saveServiceOptions.map(({ value, label }) => (
            <button
              key={value ?? 'none'}
              type="button"
              role="radio"
              aria-checked={saveService === value}
              className={
                'settings__theme-btn' + (saveService === value ? ' is-active' : '')
              }
              onClick={() => setSaveService(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {saveService ? (
          <ul className="settings__toggles">
            <li className="settings__toggle">
              <label className="settings__toggle-label">
                <input
                  type="checkbox"
                  className="settings__toggle-check"
                  checked={autoSaveOnFavorite}
                  onChange={(e) => setAutoSaveOnFavorite(e.target.checked)}
                />
                <span className="settings__toggle-text">
                  <span className="settings__toggle-title">
                    Auto-save on favorite
                  </span>
                </span>
              </label>
            </li>
          </ul>
        ) : null}
      </section>

      {/* newshacker link — only relevant to a signed-in account (the token acts
          as that account). Hidden when signed out or unsupported by the source. */}
      {user ? <NewshackerConnection /> : null}

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
