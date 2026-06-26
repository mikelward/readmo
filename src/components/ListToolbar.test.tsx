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

  it('renders Collapse all / Expand all as icon-only buttons with accessible names', () => {
    renderWithProviders(
      <ListToolbar
        collapse={{
          onCollapseAll: vi.fn(),
          onExpandAll: vi.fn(),
          allCollapsed: false,
          anyCollapsed: true,
        }}
      />,
    );
    const collapseAll = screen.getByTestId('collapse-all-btn');
    const expandAll = screen.getByTestId('expand-all-btn');
    // Icon-only: the accessible name comes from aria-label, not visible text.
    expect(collapseAll).toHaveAccessibleName('Collapse all');
    expect(expandAll).toHaveAccessibleName('Expand all');
    expect(collapseAll).toHaveTextContent('');
    expect(expandAll).toHaveTextContent('');
    expect(collapseAll.querySelector('svg')).not.toBeNull();
    expect(expandAll.querySelector('svg')).not.toBeNull();
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
    // Enabled controls are not soft-disabled (TooltipButton uses aria-disabled,
    // never the native `disabled` attribute, so the tooltip still surfaces).
    expect(collapseAll).not.toHaveAttribute('aria-disabled');
    expect(expandAll).not.toHaveAttribute('aria-disabled');
    const user = userEvent.setup();
    await user.click(collapseAll);
    await user.click(expandAll);
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
    expect(onExpandAll).toHaveBeenCalledTimes(1);
  });

  it('soft-disables Collapse all when everything is already collapsed', async () => {
    const onCollapseAll = vi.fn();
    renderWithProviders(
      <ListToolbar
        collapse={{
          onCollapseAll,
          onExpandAll: vi.fn(),
          allCollapsed: true,
          anyCollapsed: true,
        }}
      />,
    );
    const collapseAll = screen.getByTestId('collapse-all-btn');
    expect(collapseAll).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('expand-all-btn')).not.toHaveAttribute(
      'aria-disabled',
    );
    // Soft-disabled: still in the DOM (so its tooltip works) but inert on click.
    await userEvent.setup().click(collapseAll);
    expect(onCollapseAll).not.toHaveBeenCalled();
  });

  it('soft-disables Expand all when nothing is collapsed', () => {
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
    expect(screen.getByTestId('expand-all-btn')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByTestId('collapse-all-btn')).not.toHaveAttribute(
      'aria-disabled',
    );
  });
});
