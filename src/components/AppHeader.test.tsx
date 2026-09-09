import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '../test/renderWithProviders';
import {
  _resetNetworkStatusForTests,
  trackedFetch,
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
 * Search is an icon-only TooltipButton that navigates via onClick (so it gets
 * the long-press/hover tooltip), not a <Link> with an href. */
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

  it('suppresses the Search button on /search itself', () => {
    // A header button that navigates to the page you're already on is noise —
    // same rule as newshacker's showSearchButton.
    renderWithProviders(<AppHeader />, { route: '/search' });
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
  });

  it('marks the header as the banner landmark', () => {
    renderWithProviders(<AppHeader />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('reflects the drawer state on the menu toggle via aria-expanded', () => {
    renderWithProviders(<AppHeader />);
    const menu = screen.getByRole('button', { name: 'Open menu' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
  });

  it('no longer shows a Settings gear in the header (it moved to the account menu)', () => {
    renderWithProviders(<AppHeader />);
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });
});

describe('AppHeader account menu', () => {
  beforeEach(() => {
    window.localStorage.setItem('readmo:mock-signed-in', '1');
  });
  afterEach(() => {
    window.localStorage.removeItem('readmo:mock-signed-in');
  });

  it('opens the account menu with Feeds, Settings, and About links', () => {
    renderWithProviders(<AppHeader />);
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('menuitem', { name: 'Feeds' })).toHaveAttribute(
      'href',
      '/feeds',
    );
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.getByRole('menuitem', { name: 'About' })).toHaveAttribute(
      'href',
      '/about',
    );
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

  it('shows "Down" — not "Offline" — when the backend answers with a 5xx', async () => {
    // navigator.onLine stays true and the server answered, just with a 5xx, so it's
    // reachable-but-erroring (our problem), not the user's connection.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    await trackedFetch('/rest/v1/x');
    renderWithProviders(<AppHeader />);
    const pill = screen.getByTestId('offline-pill');
    expect(pill).toHaveTextContent('Down');
    expect(pill).not.toHaveTextContent('Offline');
    vi.unstubAllGlobals();
  });
});
