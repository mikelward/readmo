import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { SignInPage } from './SignInPage';

// The mock auth path is signed-out by default; the "already signed-in" test
// sets this key to simulate a returning user.
const MOCK_SIGNED_IN_KEY = 'readmo:mock-signed-in';

// Echoes the current path so we can assert where sign-in landed the user.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderAt(entry: { pathname: string; state?: unknown }) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/signin" element={<SignInPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('SignInPage', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns to the saved deep link after signing in', async () => {
    const user = userEvent.setup();
    renderAt({ pathname: '/signin', state: { from: { pathname: '/item/abc' } } });
    await user.click(screen.getByRole('button', { name: /continue with google/i }));
    expect(screen.getByTestId('location')).toHaveTextContent('/item/abc');
  });

  it('falls back to home when there is no saved location', async () => {
    const user = userEvent.setup();
    renderAt({ pathname: '/signin' });
    await user.click(screen.getByRole('button', { name: /continue with discord/i }));
    expect(screen.getByTestId('location')).toHaveTextContent('/');
  });

  it('renders the feed preview hero when signed out', () => {
    renderAt({ pathname: '/signin' });
    expect(document.querySelector('.signin__hero')).not.toBeNull();
    const rows = document.querySelectorAll('.item-row');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('redirects an already-signed-in user off /signin to the saved target', () => {
    window.localStorage.setItem(MOCK_SIGNED_IN_KEY, '1');
    renderAt({ pathname: '/signin', state: { from: { pathname: '/folder/tech' } } });
    expect(screen.getByTestId('location')).toHaveTextContent('/folder/tech');
    expect(screen.queryByRole('button', { name: /continue with/i })).toBeNull();
  });
});
