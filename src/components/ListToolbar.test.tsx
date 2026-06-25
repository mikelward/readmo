import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders } from '../test/renderWithProviders';
import { ListToolbar } from './ListToolbar';
import {
  BOTTOM_BAR_KEY,
  resetReadingPrefsCacheForTest,
} from '../hooks/useReadingPrefs';

describe('ListToolbar bottom position', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });

  it('defaults the bottom bar to the relative end-of-list footer', () => {
    const { container } = renderWithProviders(
      <ListToolbar placement="bottom" />,
    );
    expect(
      container.querySelector('.list-toolbar--bottom'),
    ).toHaveClass('list-toolbar--relative');
  });

  it("pins the bottom bar to the viewport when set to 'screen'", () => {
    window.localStorage.setItem(BOTTOM_BAR_KEY, 'screen');
    resetReadingPrefsCacheForTest();
    const { container } = renderWithProviders(
      <ListToolbar placement="bottom" />,
    );
    expect(
      container.querySelector('.list-toolbar--bottom'),
    ).not.toHaveClass('list-toolbar--relative');
  });

  it('never makes the top bar relative', () => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
    const { container } = renderWithProviders(<ListToolbar placement="top" />);
    expect(
      container.querySelector('.list-toolbar--top'),
    ).not.toHaveClass('list-toolbar--relative');
  });
});
