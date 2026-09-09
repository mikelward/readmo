import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { ThemeModeControl } from './ThemeModeControl';
import * as themeLib from '../lib/theme';

describe('ThemeModeControl', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders Light, Dark, System as a Dark/Light mode radiogroup', () => {
    renderWithProviders(<ThemeModeControl />);
    const group = screen.getByRole('radiogroup', { name: 'Dark/Light mode' });
    expect(group).toBeInTheDocument();
    for (const name of ['Light', 'Dark', 'System']) {
      expect(screen.getByRole('radio', { name })).toBeInTheDocument();
    }
  });

  it('marks the stored theme as checked', () => {
    vi.spyOn(themeLib, 'getStoredTheme').mockReturnValue('dark');
    renderWithProviders(<ThemeModeControl />);
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'false');
  });

  it('calls setStoredTheme when a mode button is clicked', async () => {
    const user = userEvent.setup();
    const setSpy = vi.spyOn(themeLib, 'setStoredTheme').mockImplementation(() => {});
    renderWithProviders(<ThemeModeControl />);
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(setSpy).toHaveBeenCalledWith('dark');
  });
});
