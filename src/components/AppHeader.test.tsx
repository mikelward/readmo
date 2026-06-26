import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '../test/renderWithProviders';
import {
  _resetNetworkStatusForTests,
  reportFetchFailure,
} from '../lib/networkStatus';
import { AppHeader } from './AppHeader';

// jsdom ships no real PointerEvent constructor, so Testing Library's
// `fireEvent.pointerEnter` drops `pointerType` from the init dict — which
// TooltipButton's hover path keys off. Give it a minimal PointerEvent that
// carries pointerType through so the mouse-hover branch actually runs.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerType: string;
    pointerId: number;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerType = params.pointerType ?? '';
      this.pointerId = params.pointerId ?? 0;
    }
  }
  // @ts-expect-error — assigning the polyfill to the global.
  window.PointerEvent = PointerEventPolyfill;
}

/** Surfaces the router's current path so a click can be asserted to navigate.
 * Search/Settings are icon-only TooltipButtons that navigate via onClick (so
 * they get the long-press/hover tooltip), not <Link>s with an href. */
function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

beforeEach(() => {
  setNavigatorOnline(true);
  _resetNetworkStatusForTests();
});

afterEach(() => {
  setNavigatorOnline(true);
  _resetNetworkStatusForTests();
});

describe('AppHeader actions', () => {
  it('exposes a Settings gear that navigates to /settings', () => {
    renderWithProviders(
      <>
        <AppHeader />
        <LocationProbe />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings');
  });

  it('exposes a Search glass that navigates to /search', () => {
    renderWithProviders(
      <>
        <AppHeader />
        <LocationProbe />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/search');
  });
});

describe('AppHeader icon tooltips', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // The header's icon-only controls are TooltipButtons, so hovering surfaces a
  // styled tooltip (and a long-press does on touch). The menu button stands in
  // for the group — the tooltip mechanics themselves live in TooltipButton.test.
  it('surfaces a tooltip when the menu button is hovered', () => {
    renderWithProviders(<AppHeader />);
    const menu = screen.getByRole('button', { name: 'Open menu' });
    act(() => {
      fireEvent.pointerEnter(menu, { pointerType: 'mouse', pointerId: 1 });
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Menu');
  });
});

describe('AppHeader connectivity pill', () => {
  it('shows no pill while online', () => {
    renderWithProviders(<AppHeader />);
    expect(screen.queryByTestId('offline-pill')).not.toBeInTheDocument();
  });

  it('shows "Offline" when the device reports no network', () => {
    setNavigatorOnline(false);
    renderWithProviders(<AppHeader />);
    expect(screen.getByTestId('offline-pill')).toHaveTextContent('Offline');
  });

  it('shows "Down" — not "Offline" — when the device is online but the backend is unreachable', () => {
    // navigator.onLine stays true; only the fetch signal failed, so the server
    // is the problem, not the user's connection.
    reportFetchFailure(new TypeError('Failed to fetch'));
    renderWithProviders(<AppHeader />);
    const pill = screen.getByTestId('offline-pill');
    expect(pill).toHaveTextContent('Down');
    expect(pill).not.toHaveTextContent('Offline');
  });
});
