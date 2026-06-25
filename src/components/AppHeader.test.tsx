import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/renderWithProviders';
import {
  _resetNetworkStatusForTests,
  reportFetchFailure,
} from '../lib/networkStatus';
import { AppHeader } from './AppHeader';

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
  it('exposes a Settings gear that links to /settings', () => {
    renderWithProviders(<AppHeader />);
    const gear = screen.getByRole('link', { name: 'Settings' });
    expect(gear).toHaveAttribute('href', '/settings');
  });

  it('exposes a Search glass that links to /search', () => {
    renderWithProviders(<AppHeader />);
    const search = screen.getByRole('link', { name: 'Search' });
    expect(search).toHaveAttribute('href', '/search');
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
