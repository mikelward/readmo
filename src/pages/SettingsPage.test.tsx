import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import {
  BOTTOM_BAR_KEY,
  GROUP_BY_FEED_KEY,
  HIDE_ON_SCROLL_KEY,
  ITEM_SORT_KEY,
  SHOW_ROW_FAVICON_KEY,
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
    it('renders Extra Small through Huge A-glyph buttons in one segmented row', () => {
      renderWithProviders(<SettingsPage />);
      const group = screen.getByRole('radiogroup', { name: 'Text size' });
      expect(group).toHaveClass('text-size');
      for (const name of [
        'Extra Small',
        'Small',
        'Medium',
        'Large',
        'Extra Large',
        'Huge',
      ]) {
        const btn = screen.getByRole('radio', { name });
        expect(btn).toBeInTheDocument();
        // Accessible name comes from aria-label; the visible glyph is just "A".
        expect(btn).toHaveTextContent('A');
      }
    });

    it('marks the stored font size as checked', () => {
      vi.spyOn(themeLib, 'getStoredFontSize').mockReturnValue('17');
      renderWithProviders(<SettingsPage />);
      expect(screen.getByRole('radio', { name: 'Large' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'false');
    });

    it('calls setStoredFontSize when a size is clicked', async () => {
      const user = userEvent.setup();
      const setSpy = vi.spyOn(themeLib, 'setStoredFontSize').mockImplementation(() => {});
      renderWithProviders(<SettingsPage />);
      await user.click(screen.getByRole('radio', { name: 'Small' }));
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

  it('toggles "Show feed icons on articles" and persists it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const toggle = screen.getByRole('checkbox', {
      name: /show feed icons on articles/i,
    });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(window.localStorage.getItem(SHOW_ROW_FAVICON_KEY)).toBe('1');
  });

  it('defaults sort order to "Newest first" and switches to "Oldest first"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    expect(screen.getByRole('radio', { name: 'Newest first' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Oldest first' }));
    expect(screen.getByRole('radio', { name: 'Oldest first' })).toBeChecked();
    expect(window.localStorage.getItem(ITEM_SORT_KEY)).toBe('oldest');
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
