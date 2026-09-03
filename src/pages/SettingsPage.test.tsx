import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { MockDataSource } from '../lib/data/MockDataSource';
import {
  BOTTOM_BAR_KEY,
  GROUP_BY_FEED_KEY,
  HIDE_ON_SCROLL_KEY,
  HIDE_ON_SCROLL_REMOVE_KEY,
  HIDE_SPORTS_SPOILERS_KEY,
  AUTO_SUMMARIZE_PINNED_KEY,
  ITEM_SORT_KEY,
  LIST_LAYOUT_KEY,
  ARTICLES_PER_PAGE_KEY,
  ARTICLES_PER_SECTION_KEY,
  SHOW_ROW_FAVICON_KEY,
  SHOW_GROUP_FAVICON_KEY,
  SAVE_SERVICE_KEY,
  AUTO_SAVE_ON_FAVORITE_KEY,
  TITLE_FILTERS_KEY,
  resetReadingPrefsCacheForTest,
} from '../hooks/useReadingPrefs';
import { SettingsPage } from './SettingsPage';
import { FONT_STACKS, FONT_STORAGE_KEY } from '../lib/theme';
import * as themeLib from '../lib/theme';

describe('SettingsPage — Edit feeds link', () => {
  it('shows an Edit feeds button linking to the Feeds page', () => {
    renderWithProviders(<SettingsPage />);
    expect(screen.getByRole('link', { name: 'Edit feeds' })).toHaveAttribute(
      'href',
      '/feeds',
    );
  });
});

describe('SettingsPage — Appearance (symbolic controls)', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('Dark/Light mode', () => {
    // "System" is also a Font option, so scope mode queries to the mode group.
    const modeGroup = () => screen.getByRole('radiogroup', { name: 'Dark/Light mode' });

    it('renders Light, Dark, System icon buttons', () => {
      renderWithProviders(<SettingsPage />);
      const group = modeGroup();
      expect(group).toBeInTheDocument();
      expect(within(group).getByRole('radio', { name: 'Light' })).toBeInTheDocument();
      expect(within(group).getByRole('radio', { name: 'Dark' })).toBeInTheDocument();
      expect(within(group).getByRole('radio', { name: 'System' })).toBeInTheDocument();
    });

    it('marks the stored theme as checked', () => {
      vi.spyOn(themeLib, 'getStoredTheme').mockReturnValue('dark');
      renderWithProviders(<SettingsPage />);
      const group = modeGroup();
      expect(within(group).getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
      expect(within(group).getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'false');
    });

    it('calls setStoredTheme when a mode button is clicked', async () => {
      const user = userEvent.setup();
      const setSpy = vi.spyOn(themeLib, 'setStoredTheme').mockImplementation(() => {});
      renderWithProviders(<SettingsPage />);
      await user.click(within(modeGroup()).getByRole('radio', { name: 'Dark' }));
      expect(setSpy).toHaveBeenCalledWith('dark');
    });
  });

  describe('Palette', () => {
    it('shows each palette as a color swatch rather than a text label', () => {
      renderWithProviders(<SettingsPage />);
      const ink = screen.getByRole('radio', { name: 'Ink' });
      // The button name comes from aria-label; its visible content is a swatch.
      expect(ink).not.toHaveTextContent('Ink');
      expect(ink.querySelector('.color-theme__swatch')).not.toBeNull();
    });

    it('marks the stored palette as checked', () => {
      vi.spyOn(themeLib, 'getStoredPalette').mockReturnValue('grape');
      renderWithProviders(<SettingsPage />);
      expect(screen.getByRole('radio', { name: 'Grape' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('radio', { name: 'Ink' })).toHaveAttribute('aria-checked', 'false');
    });

    it('calls setStoredPalette when a swatch is clicked', async () => {
      const user = userEvent.setup();
      const setSpy = vi.spyOn(themeLib, 'setStoredPalette').mockImplementation(() => {});
      renderWithProviders(<SettingsPage />);
      await user.click(screen.getByRole('radio', { name: 'Grape' }));
      expect(setSpy).toHaveBeenCalledWith('grape');
    });
  });

  describe('Text size', () => {
    it('offers the text-size stepper', () => {
      renderWithProviders(<SettingsPage />);
      const group = screen.getByRole('group', { name: 'Text size' });
      expect(group).toHaveClass('text-size');
      expect(
        screen.getByRole('button', { name: 'Smaller text' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Larger text' }),
      ).toBeInTheDocument();
    });

    it('shows the stored font size', () => {
      vi.spyOn(themeLib, 'getStoredFontSize').mockReturnValue('17');
      renderWithProviders(<SettingsPage />);
      expect(screen.getByText('17px')).toBeInTheDocument();
    });

    it('calls setStoredFontSize when a step is clicked', async () => {
      const user = userEvent.setup();
      vi.spyOn(themeLib, 'getStoredFontSize').mockReturnValue('16');
      const setSpy = vi.spyOn(themeLib, 'setStoredFontSize').mockImplementation(() => {});
      renderWithProviders(<SettingsPage />);
      await user.click(screen.getByRole('button', { name: 'Smaller text' }));
      expect(setSpy).toHaveBeenCalledWith('15');
    });
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

  it('toggles "Show icons on articles" (off by default) and persists it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const toggle = screen.getByRole('checkbox', {
      name: /show icons on articles/i,
    });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(window.localStorage.getItem(SHOW_ROW_FAVICON_KEY)).toBe('1');
  });

  it('toggles "Show icons on groups" (on by default) off and persists it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const toggle = screen.getByRole('checkbox', {
      name: /show icons on groups/i,
    });
    expect(toggle).toBeChecked(); // default ON
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(window.localStorage.getItem(SHOW_GROUP_FAVICON_KEY)).toBe('0');
  });

  it('defaults sort order to "Newest first" and switches to "Oldest first"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    expect(screen.getByRole('radio', { name: 'Newest first' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Oldest first' }));
    expect(screen.getByRole('radio', { name: 'Oldest first' })).toBeChecked();
    expect(window.localStorage.getItem(ITEM_SORT_KEY)).toBe('oldest');
  });

  it('toggles "Mark Done as you scroll" and persists it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    const toggle = screen.getByRole('checkbox', {
      name: /mark done as you scroll/i,
    });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(window.localStorage.getItem(HIDE_ON_SCROLL_KEY)).toBe('1');
  });

  it('reveals the "Remove them from the list" sub-toggle only once auto-hide is on', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const sub = () => screen.queryByRole('checkbox', { name: /remove them from the list/i });

    // Auto-hide is off by default, so its sub-setting isn't a live control yet.
    expect(sub()).toBeNull();

    await user.click(
      screen.getByRole('checkbox', { name: /mark done as you scroll/i }),
    );

    // On by default — removal is what auto-hide did before the sub-setting
    // existed. The description is what the title can't say: the title states
    // what ON does, so OFF would otherwise only be discoverable by flipping it.
    expect(sub()).toBeChecked();
    expect(
      document.querySelector('.settings__toggle--sub .settings__toggle-desc'),
    ).toHaveTextContent('Off: strike through until refresh.');
  });

  it('persists the "Remove them from the list" sub-toggle when turned off', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(HIDE_ON_SCROLL_KEY, '1');
    resetReadingPrefsCacheForTest();
    renderWithProviders(<SettingsPage />);

    const sub = screen.getByRole('checkbox', {
      name: /remove them from the list/i,
    });
    expect(sub).toBeChecked();

    await user.click(sub);
    expect(sub).not.toBeChecked();
    expect(window.localStorage.getItem(HIDE_ON_SCROLL_REMOVE_KEY)).toBe('0');
  });

  it('shows "Hide sports spoilers" (on by default) for an allowed user and toggles it off', async () => {
    const user = userEvent.setup();
    // Default provider stack: signed-out → default capabilities → allowed.
    renderWithProviders(<SettingsPage />);
    const toggle = screen.getByRole('checkbox', { name: /hide sports spoilers/i });
    expect(toggle).toBeChecked(); // default ON
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(window.localStorage.getItem(HIDE_SPORTS_SPOILERS_KEY)).toBe('0');
  });

  it('shows "Auto generate summaries for pinned articles" (on by default) for a family user and toggles it off', async () => {
    const user = userEvent.setup();
    // Sign in against the default MockDataSource: the demo user is on its own
    // armed allowlist → capabilities resolve to family:true.
    window.localStorage.setItem('readmo:mock-signed-in', '1');
    renderWithProviders(<SettingsPage />);
    const toggle = await screen.findByRole('checkbox', {
      name: /auto generate summaries for pinned articles/i,
    });
    expect(toggle).toBeChecked(); // default ON
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(window.localStorage.getItem(AUTO_SUMMARIZE_PINNED_KEY)).toBe('0');
  });

  it('hides the "Auto generate summaries" toggle for a non-family user', async () => {
    // Signed-out default caps resolve to family:false (allowlist disarmed), so
    // the spoiler toggle still shows but the family-only summary toggle does not.
    renderWithProviders(<SettingsPage />);
    await screen.findByRole('checkbox', { name: /hide sports spoilers/i });
    expect(
      screen.queryByRole('checkbox', {
        name: /auto generate summaries for pinned articles/i,
      }),
    ).toBeNull();
  });

  it('hides the "Hide sports spoilers" toggle for an off-allowlist user', async () => {
    // Sign in and arm the allowlist WITHOUT the demo user, so capabilities
    // resolve to family:false → the gated toggle is not offered.
    window.localStorage.setItem('readmo:mock-signed-in', '1');
    const source = new MockDataSource('test-offlist');
    await source.removeFromAllowlist('demo@readmo.app');
    await source.addToAllowlist('someone-else@example.com');
    renderWithProviders(<SettingsPage />, { source });
    // Other Reading toggles confirm the section rendered; the spoiler one is gone
    // once capabilities resolve.
    await screen.findByRole('checkbox', { name: /group by feed/i });
    await waitFor(() => {
      expect(
        screen.queryByRole('checkbox', { name: /hide sports spoilers/i }),
      ).toBeNull();
    });
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

describe('SettingsPage — Font picker', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font');
  });
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font');
  });

  it('defaults to Roboto and offers every option including System', () => {
    renderWithProviders(<SettingsPage />);
    const group = screen.getByRole('radiogroup', { name: 'Font' });
    expect(within(group).getByRole('radio', { name: 'Roboto' })).toBeChecked();
    for (const name of ['Inter', 'Public Sans', 'Work Sans', 'Fira Sans', 'System']) {
      expect(within(group).getByRole('radio', { name })).toBeInTheDocument();
    }
  });

  it('selecting a font persists it and sets data-font', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const group = screen.getByRole('radiogroup', { name: 'Font' });

    await user.click(within(group).getByRole('radio', { name: 'Inter' }));
    expect(within(group).getByRole('radio', { name: 'Inter' })).toBeChecked();
    expect(window.localStorage.getItem(FONT_STORAGE_KEY)).toBe('inter');
    expect(document.documentElement.getAttribute('data-font')).toBe('inter');
  });

  it('reselecting Roboto (the default) clears the key and the attribute', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const group = screen.getByRole('radiogroup', { name: 'Font' });

    await user.click(within(group).getByRole('radio', { name: 'Work Sans' }));
    expect(window.localStorage.getItem(FONT_STORAGE_KEY)).toBe('work-sans');

    await user.click(within(group).getByRole('radio', { name: 'Roboto' }));
    expect(window.localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-font')).toBe(false);
  });

  it('previews each option in its own face', () => {
    renderWithProviders(<SettingsPage />);
    const group = screen.getByRole('radiogroup', { name: 'Font' });
    // The Inter chip renders its own label in Inter; System uses the native
    // stack (no webfont family), so the preview matches what choosing it does.
    expect(within(group).getByRole('radio', { name: 'Inter' })).toHaveStyle({
      fontFamily: FONT_STACKS.inter,
    });
    expect(within(group).getByRole('radio', { name: 'System' })).toHaveStyle({
      fontFamily: FONT_STACKS.system,
    });
  });
});

describe('SettingsPage — Article layout', () => {
  afterEach(() => {
    localStorage.clear();
    resetReadingPrefsCacheForTest();
  });

  const group = () =>
    screen.getByRole('radiogroup', { name: 'Article layout' });

  it('offers the four layout options, defaulting to Small thumbnail', () => {
    renderWithProviders(<SettingsPage />);
    expect(
      within(group()).getByRole('radio', { name: 'Small thumbnail' }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      within(group()).getByRole('radio', { name: 'Title only' }),
    ).toBeInTheDocument();
    expect(
      within(group()).getByRole('radio', { name: 'Large thumbnail' }),
    ).toBeInTheDocument();
    expect(
      within(group()).getByRole('radio', { name: 'Excerpt' }),
    ).toBeInTheDocument();
  });

  it('persists the chosen layout to localStorage', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    // Pick a non-default option so the click actually changes the stored value.
    await user.click(
      within(group()).getByRole('radio', { name: 'Large thumbnail' }),
    );
    expect(window.localStorage.getItem(LIST_LAYOUT_KEY)).toBe('thumbnail');
    expect(
      within(group()).getByRole('radio', { name: 'Large thumbnail' }),
    ).toHaveAttribute('aria-checked', 'true');
  });
});

describe('SettingsPage — article load sizes', () => {
  beforeEach(() => {
    localStorage.clear();
    resetReadingPrefsCacheForTest();
  });
  afterEach(() => {
    localStorage.clear();
    resetReadingPrefsCacheForTest();
  });

  const group = (name: string) => screen.getByRole('radiogroup', { name });

  // Two independent pickers over one scale — the flat page size defaults to
  // today's 30, the grouped section window to today's 10.
  // The section window offers a 5 the page size doesn't: it costs no request,
  // and a short section is how you skim many feeds at once.
  it.each([
    {
      name: 'Articles per page',
      key: ARTICLES_PER_PAGE_KEY,
      def: '30',
      sizes: ['10', '20', '30', '40', '50'],
    },
    {
      name: 'Articles per feed section',
      key: ARTICLES_PER_SECTION_KEY,
      def: '10',
      sizes: ['5', '10', '20'],
    },
  ])('offers $sizes for $name, defaulting to $def', ({ name, def, sizes }) => {
    renderWithProviders(<SettingsPage />);
    expect(
      within(group(name))
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(sizes);
    expect(
      within(group(name)).getByRole('radio', { name: def }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it.each([
    { name: 'Articles per page', key: ARTICLES_PER_PAGE_KEY, pick: '10' },
    {
      name: 'Articles per feed section',
      key: ARTICLES_PER_SECTION_KEY,
      pick: '20',
    },
  ])('persists the chosen $name to localStorage', async ({ name, key, pick }) => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await user.click(within(group(name)).getByRole('radio', { name: pick }));
    expect(window.localStorage.getItem(key)).toBe(pick);
    expect(
      within(group(name)).getByRole('radio', { name: pick }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  // The two pickers are separate prefs: choosing on one must not move the other.
  it('leaves the section window alone when the page size changes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await user.click(
      within(group('Articles per page')).getByRole('radio', { name: '10' }),
    );
    expect(window.localStorage.getItem(ARTICLES_PER_SECTION_KEY)).toBeNull();
    expect(
      within(group('Articles per feed section')).getByRole('radio', {
        name: '10',
      }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  // Guardrail 12: the heading is the copy. The chips carry the bare number and
  // neither control ships an explanatory blurb beside it.
  it('closes out Reading with both pickers and no explanatory copy', () => {
    renderWithProviders(<SettingsPage />);
    const reading = screen
      .getByRole('heading', { level: 2, name: 'Reading' })
      .closest('section');
    expect(reading).not.toBeNull();
    const subheadings = within(reading as HTMLElement)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(subheadings.slice(-2)).toEqual([
      'Articles per page',
      'Articles per feed section',
    ]);
    expect(within(group('Articles per page')).queryByText(/\D/)).toBeNull();
    expect(
      within(group('Articles per feed section')).queryByText(/\D/),
    ).toBeNull();
  });
});

describe('SettingsPage — Read later', () => {
  beforeEach(() => {
    localStorage.clear();
    resetReadingPrefsCacheForTest();
  });
  afterEach(() => {
    localStorage.clear();
    resetReadingPrefsCacheForTest();
  });

  const saveGroup = () => screen.getByRole('radiogroup', { name: 'Save to' });

  it('places the Read later section immediately after Smart features', () => {
    // Default caps leave the allowlist disarmed → canUseFullText is true, so the
    // Smart features section renders and the ordering can be asserted directly.
    renderWithProviders(<SettingsPage />);
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    const smart = headings.indexOf('Smart features');
    const readLater = headings.indexOf('Read later');
    expect(smart).toBeGreaterThanOrEqual(0);
    expect(readLater).toBe(smart + 1);
  });

  it('offers None + one option per service, defaulting to None', () => {
    renderWithProviders(<SettingsPage />);
    const group = saveGroup();
    for (const label of ['None', 'Instapaper', 'Raindrop', 'Readwise Reader']) {
      expect(within(group).getByRole('radio', { name: label })).toBeInTheDocument();
    }
    expect(within(group).getByRole('radio', { name: 'None' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('persists choosing a single save service', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await user.click(within(saveGroup()).getByRole('radio', { name: 'Raindrop' }));
    expect(window.localStorage.getItem(SAVE_SERVICE_KEY)).toBe('raindrop');
    expect(
      within(saveGroup()).getByRole('radio', { name: 'Raindrop' }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('hides the auto-save-on-favorite toggle until a service is chosen', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    expect(
      screen.queryByRole('checkbox', { name: 'Auto-save on favorite' }),
    ).toBeNull();
    await user.click(within(saveGroup()).getByRole('radio', { name: 'Instapaper' }));
    expect(
      screen.getByRole('checkbox', { name: 'Auto-save on favorite' }),
    ).toBeInTheDocument();
  });

  it('persists the auto-save-on-favorite toggle', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(SAVE_SERVICE_KEY, 'instapaper');
    resetReadingPrefsCacheForTest();
    renderWithProviders(<SettingsPage />);
    const toggle = screen.getByRole('checkbox', { name: 'Auto-save on favorite' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(window.localStorage.getItem(AUTO_SAVE_ON_FAVORITE_KEY)).toBe('1');
    expect(
      screen.getByRole('checkbox', { name: 'Auto-save on favorite' }),
    ).toBeChecked();
  });
});


describe('SettingsPage — Filtered words', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });
  afterEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });

  it('adds a typed word, normalized, and lists it as a chip', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.type(screen.getByLabelText('Word or phrase to filter'), '  Trump  ');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(JSON.parse(window.localStorage.getItem(TITLE_FILTERS_KEY)!)).toEqual(['trump']);
    expect(screen.getByText('trump')).toBeInTheDocument();
    // The field clears, so adding a second word doesn't need a manual wipe.
    expect(screen.getByLabelText('Word or phrase to filter')).toHaveValue('');
  });

  it('will not add an empty or duplicate entry', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    // Empty: the control is disabled rather than silently doing nothing.
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();

    const field = screen.getByLabelText('Word or phrase to filter');
    await user.type(field, 'Trump');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.type(field, 'trump');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(JSON.parse(window.localStorage.getItem(TITLE_FILTERS_KEY)!)).toEqual(['trump']);
  });

  it('removes an entry that was stored unnormalized', async () => {
    // Belt-and-braces beside the mapper's normalization: a hand-edited value
    // must still be removable, or the reader is stuck with a chip forever.
    window.localStorage.setItem(TITLE_FILTERS_KEY, JSON.stringify(['Trump']));
    resetReadingPrefsCacheForTest();
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.click(screen.getByRole('button', { name: 'Remove Trump' }));
    expect(JSON.parse(window.localStorage.getItem(TITLE_FILTERS_KEY)!)).toEqual([]);
  });

  it('removes a word — the feature\u2019s undo', async () => {
    window.localStorage.setItem(TITLE_FILTERS_KEY, JSON.stringify(['trump', 'musk']));
    resetReadingPrefsCacheForTest();
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.click(screen.getByRole('button', { name: 'Remove trump' }));

    expect(JSON.parse(window.localStorage.getItem(TITLE_FILTERS_KEY)!)).toEqual(['musk']);
    expect(screen.queryByText('trump')).toBeNull();
  });

});
