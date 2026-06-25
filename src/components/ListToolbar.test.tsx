import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('ListToolbar collapse controls', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });
  afterEach(() => {
    window.localStorage.clear();
    resetReadingPrefsCacheForTest();
  });

  it('renders no collapse buttons without the collapse prop', () => {
    renderWithProviders(<ListToolbar />);
    expect(screen.queryByTestId('collapse-all-btn')).toBeNull();
    expect(screen.queryByTestId('expand-all-btn')).toBeNull();
  });

  it('wires Collapse all / Expand all and disables them per state', async () => {
    const onCollapseAll = vi.fn();
    const onExpandAll = vi.fn();
    renderWithProviders(
      <ListToolbar
        collapse={{
          onCollapseAll,
          onExpandAll,
          allCollapsed: false,
          anyCollapsed: true,
        }}
      />,
    );
    const collapseAll = screen.getByTestId('collapse-all-btn');
    const expandAll = screen.getByTestId('expand-all-btn');
    expect(collapseAll).toBeEnabled();
    expect(expandAll).toBeEnabled();
    const user = userEvent.setup();
    await user.click(collapseAll);
    await user.click(expandAll);
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
    expect(onExpandAll).toHaveBeenCalledTimes(1);
  });

  it('disables Collapse all when everything is already collapsed', () => {
    renderWithProviders(
      <ListToolbar
        collapse={{
          onCollapseAll: vi.fn(),
          onExpandAll: vi.fn(),
          allCollapsed: true,
          anyCollapsed: true,
        }}
      />,
    );
    expect(screen.getByTestId('collapse-all-btn')).toBeDisabled();
    expect(screen.getByTestId('expand-all-btn')).toBeEnabled();
  });

  it('disables Expand all when nothing is collapsed', () => {
    renderWithProviders(
      <ListToolbar
        collapse={{
          onCollapseAll: vi.fn(),
          onExpandAll: vi.fn(),
          allCollapsed: false,
          anyCollapsed: false,
        }}
      />,
    );
    expect(screen.getByTestId('expand-all-btn')).toBeDisabled();
    expect(screen.getByTestId('collapse-all-btn')).toBeEnabled();
  });
});
