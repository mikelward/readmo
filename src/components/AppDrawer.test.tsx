import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { AppDrawer } from './AppDrawer';
import * as themeLib from '../lib/theme';

function renderDrawer(open = true) {
  const onClose = vi.fn();
  const result = renderWithProviders(<AppDrawer open={open} onClose={onClose} />);
  return { onClose, ...result };
}

describe('AppDrawer', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('renders nothing when closed', () => {
    renderDrawer(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the section headings when open', () => {
    renderDrawer();
    expect(screen.getByText('Library')).toBeInTheDocument();
    expect(screen.getByText('Appearance')).toBeInTheDocument();
    expect(screen.getByText('Feeds')).toBeInTheDocument();
    expect(screen.getByText('App')).toBeInTheDocument();
  });

  it('calls onClose when backdrop is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDrawer();
    await user.click(screen.getByRole('dialog').querySelector('.app-drawer__backdrop')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose on Escape key', async () => {
    const { onClose } = renderDrawer();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  describe('Appearance — mode', () => {
    it('renders Light, Dark, System buttons', () => {
      renderDrawer();
      const group = screen.getByRole('radiogroup', { name: 'Mode' });
      expect(group).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Light' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Dark' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'System' })).toBeInTheDocument();
    });

    it('marks stored theme as checked', () => {
      vi.spyOn(themeLib, 'getStoredTheme').mockReturnValue('dark');
      renderDrawer();
      expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'false');
    });

    it('calls setStoredTheme and does not close drawer when a mode button is clicked', async () => {
      const user = userEvent.setup();
      const setSpy = vi.spyOn(themeLib, 'setStoredTheme').mockImplementation(() => {});
      const { onClose } = renderDrawer();
      await user.click(screen.getByRole('radio', { name: 'Dark' }));
      expect(setSpy).toHaveBeenCalledWith('dark');
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('Appearance — palette', () => {
    it('renders Ink, Turquoise, Indigo, and Mauve buttons', () => {
      renderDrawer();
      const group = screen.getByRole('radiogroup', { name: 'Palette' });
      expect(group).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Ink' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Turquoise' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Indigo' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Mauve' })).toBeInTheDocument();
    });

    it('lays the palette swatches out as a 2-up grid, not one flex row', () => {
      // Guardrail: keep at most a couple of tap zones per row. With four
      // palettes a single flex row would crowd four tappables onto one line at
      // normal drawer widths, so the palette control opts into a 2-column grid
      // while the mode (light/dark/system) row stays a flex row.
      renderDrawer();
      const palette = screen.getByRole('radiogroup', { name: 'Palette' });
      expect(palette).toHaveClass('app-drawer__segmented--grid');
      const mode = screen.getByRole('radiogroup', { name: 'Mode' });
      expect(mode).not.toHaveClass('app-drawer__segmented--grid');
    });

    it('shows each palette as a color swatch rather than a text label', () => {
      renderDrawer();
      const ink = screen.getByRole('radio', { name: 'Ink' });
      // The button name comes from aria-label; its visible content is a swatch.
      expect(ink).not.toHaveTextContent('Ink');
      expect(ink.querySelector('.app-drawer__swatch')).not.toBeNull();
    });

    it('selects the indigo palette when its swatch is clicked', async () => {
      const user = userEvent.setup();
      const setSpy = vi.spyOn(themeLib, 'setStoredPalette').mockImplementation(() => {});
      const { onClose } = renderDrawer();
      await user.click(screen.getByRole('radio', { name: 'Indigo' }));
      expect(setSpy).toHaveBeenCalledWith('indigo');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('marks stored palette as checked', () => {
      vi.spyOn(themeLib, 'getStoredPalette').mockReturnValue('turquoise');
      renderDrawer();
      expect(screen.getByRole('radio', { name: 'Turquoise' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('radio', { name: 'Ink' })).toHaveAttribute('aria-checked', 'false');
    });

    it('calls setStoredPalette and does not close drawer when a palette button is clicked', async () => {
      const user = userEvent.setup();
      const setSpy = vi.spyOn(themeLib, 'setStoredPalette').mockImplementation(() => {});
      const { onClose } = renderDrawer();
      await user.click(screen.getByRole('radio', { name: 'Turquoise' }));
      expect(setSpy).toHaveBeenCalledWith('turquoise');
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
