import { describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { SignInPage } from './SignInPage';

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
  it('returns to the saved deep link after signing in', async () => {
    const user = userEvent.setup();
    renderAt({ pathname: '/signin', state: { from: { pathname: '/item/abc' } } });
    await user.click(screen.getByRole('button', { name: /continue with google/i }));
    expect(screen.getByTestId('location')).toHaveTextContent('/item/abc');
  });

  it('falls back to home when there is no saved location', async () => {
    const user = userEvent.setup();
    renderAt({ pathname: '/signin' });
    await user.click(screen.getByRole('button', { name: /continue with github/i }));
    expect(screen.getByTestId('location')).toHaveTextContent('/');
  });
});
