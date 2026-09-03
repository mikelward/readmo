import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { TextSizeControl } from './TextSizeControl';
import * as themeLib from '../lib/theme';
import { FONT_SIZES } from '../lib/theme';

describe('TextSizeControl', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
    vi.restoreAllMocks();
  });

  it('is three controls whatever the ladder length', () => {
    // The point of the stepper: it does not grow a tap target per rung, so a
    // longer ladder costs no layout.
    renderWithProviders(<TextSizeControl />);
    expect(screen.getByRole('group', { name: 'Text size' })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(FONT_SIZES.length).toBeGreaterThan(2);
  });

  it('shows the current size', () => {
    vi.spyOn(themeLib, 'getStoredFontSize').mockReturnValue('19');
    renderWithProviders(<TextSizeControl />);
    expect(screen.getByText('19px')).toBeInTheDocument();
  });

  it('steps one rung at a time in each direction', async () => {
    const user = userEvent.setup();
    vi.spyOn(themeLib, 'getStoredFontSize').mockReturnValue('19');
    const setSpy = vi
      .spyOn(themeLib, 'setStoredFontSize')
      .mockImplementation(() => {});
    renderWithProviders(<TextSizeControl />);

    await user.click(screen.getByRole('button', { name: 'Larger text' }));
    expect(setSpy).toHaveBeenCalledWith('20');

    setSpy.mockClear();
    await user.click(screen.getByRole('button', { name: 'Smaller text' }));
    expect(setSpy).toHaveBeenCalledWith('18');
  });

  it('reaches the new top of the ladder', async () => {
    const user = userEvent.setup();
    vi.spyOn(themeLib, 'getStoredFontSize').mockReturnValue('30');
    const setSpy = vi
      .spyOn(themeLib, 'setStoredFontSize')
      .mockImplementation(() => {});
    renderWithProviders(<TextSizeControl />);
    await user.click(screen.getByRole('button', { name: 'Larger text' }));
    expect(setSpy).toHaveBeenCalledWith('32');
  });

  it('goes inert at each end rather than wrapping around', async () => {
    const user = userEvent.setup();
    vi.spyOn(themeLib, 'getStoredFontSize').mockReturnValue(FONT_SIZES[0]);
    const setSpy = vi
      .spyOn(themeLib, 'setStoredFontSize')
      .mockImplementation(() => {});
    renderWithProviders(<TextSizeControl />);

    const smaller = screen.getByRole('button', { name: 'Smaller text' });
    expect(smaller).toHaveAttribute('aria-disabled', 'true');
    await user.click(smaller);
    expect(setSpy).not.toHaveBeenCalled();
    // The other direction is still live at the floor.
    expect(screen.getByRole('button', { name: 'Larger text' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('announces the size, so stepping is not silent to a screen reader', () => {
    vi.spyOn(themeLib, 'getStoredFontSize').mockReturnValue('22');
    renderWithProviders(<TextSizeControl />);
    expect(screen.getByText('22px').closest('[aria-live]')).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });

  it('keeps the glyph and its label on one baseline, in one box', () => {
    // The centering below measures that box, so the two must live inside it.
    vi.spyOn(themeLib, 'getStoredFontSize').mockReturnValue('22');
    const { container } = renderWithProviders(<TextSizeControl />);
    const readout = container.querySelector('.text-size__readout');
    expect(readout).not.toBeNull();
    expect(readout?.querySelector('.text-size__glyph')?.textContent).toBe('A');
    expect(readout?.querySelector('.text-size__px')?.textContent).toBe('22px');
  });

  it('stays usable if the stored size is somehow off the ladder', async () => {
    // Belt and braces against a future ladder edit: an unrecognized value must
    // not leave both directions inert with no way back.
    const user = userEvent.setup();
    vi.spyOn(themeLib, 'getStoredFontSize').mockReturnValue(
      '21' as themeLib.FontSize,
    );
    const setSpy = vi
      .spyOn(themeLib, 'setStoredFontSize')
      .mockImplementation(() => {});
    renderWithProviders(<TextSizeControl />);
    await user.click(screen.getByRole('button', { name: 'Larger text' }));
    expect(setSpy).toHaveBeenCalled();
  });
});
