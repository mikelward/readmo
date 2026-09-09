import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { ColorThemeControl } from './ColorThemeControl';
import * as themeLib from '../lib/theme';

describe('ColorThemeControl', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders Ink and Grape as a Color theme radiogroup of swatches', () => {
    renderWithProviders(<ColorThemeControl />);
    expect(screen.getByRole('radiogroup', { name: 'Color theme' })).toBeInTheDocument();
    const ink = screen.getByRole('radio', { name: 'Ink' });
    // The name comes from aria-label; the visible content is a swatch, not text.
    expect(ink).not.toHaveTextContent('Ink');
    expect(ink.querySelector('.color-theme__swatch')).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Grape' })).toBeInTheDocument();
  });

  it('marks the stored palette as checked', () => {
    vi.spyOn(themeLib, 'getStoredPalette').mockReturnValue('grape');
    renderWithProviders(<ColorThemeControl />);
    expect(screen.getByRole('radio', { name: 'Grape' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Ink' })).toHaveAttribute('aria-checked', 'false');
  });

  it('calls setStoredPalette when a swatch is clicked', async () => {
    const user = userEvent.setup();
    const setSpy = vi.spyOn(themeLib, 'setStoredPalette').mockImplementation(() => {});
    renderWithProviders(<ColorThemeControl />);
    await user.click(screen.getByRole('radio', { name: 'Grape' }));
    expect(setSpy).toHaveBeenCalledWith('grape');
  });
});
