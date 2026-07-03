import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { TextSizeControl } from './TextSizeControl';
import * as themeLib from '../lib/theme';

describe('TextSizeControl', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
    vi.restoreAllMocks();
  });

  it('renders Small, Medium, Large, Extra Large A-glyph buttons as a Text size radiogroup', () => {
    renderWithProviders(<TextSizeControl />);
    const group = screen.getByRole('radiogroup', { name: 'Text size' });
    expect(group).toBeInTheDocument();
    for (const name of ['Small', 'Medium', 'Large', 'Extra Large']) {
      const btn = screen.getByRole('radio', { name });
      expect(btn).toBeInTheDocument();
      // Accessible name comes from aria-label; the visible glyph is just "A".
      expect(btn).toHaveTextContent('A');
    }
  });

  it('marks the stored font size as checked', () => {
    vi.spyOn(themeLib, 'getStoredFontSize').mockReturnValue('17');
    renderWithProviders(<TextSizeControl />);
    expect(screen.getByRole('radio', { name: 'Large' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'false');
  });

  it('calls setStoredFontSize when a size is clicked', async () => {
    const user = userEvent.setup();
    const setSpy = vi.spyOn(themeLib, 'setStoredFontSize').mockImplementation(() => {});
    renderWithProviders(<TextSizeControl />);
    await user.click(screen.getByRole('radio', { name: 'Small' }));
    expect(setSpy).toHaveBeenCalledWith('15');
    await user.click(screen.getByRole('radio', { name: 'Extra Large' }));
    expect(setSpy).toHaveBeenCalledWith('18');
  });
});
