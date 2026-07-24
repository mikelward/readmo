import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignInPage } from './SignInPage';
import { useAuth } from '../hooks/useAuth';

// Exercise the *configured* (real Supabase) email magic-link path: mock the
// client module so `isSupabaseConfigured()` is true and `getSupabase()` returns
// a fake auth surface. `signInWithOtp` is a hoisted spy so each test controls
// whether the request succeeds (→ "check your email") or fails (→ inline error).
const mocks = vi.hoisted(() => ({ signInWithOtp: vi.fn() }));

vi.mock('../lib/supabase/client', () => ({
  isSupabaseConfigured: () => true,
  isEmailAuthEnabled: () => true,
  AUTH_STORAGE_KEY: 'readmo:sb-auth',
  getSupabase: () => ({
    auth: {
      // No persisted session → the page renders signed-out.
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe() {} } },
      }),
      signInWithOtp: mocks.signInWithOtp,
      signOut: () => Promise.resolve({ error: null }),
    },
  }),
}));

function renderAt(entry: { pathname: string; state?: unknown }) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/signin" element={<SignInPage />} />
        <Route path="*" element={<div data-testid="landed" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SignInPage — email magic link (configured)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.signInWithOtp.mockReset();
  });
  afterEach(() => window.localStorage.clear());

  it('sends a magic link and shows the confirmation, keyed to the deep link', async () => {
    mocks.signInWithOtp.mockResolvedValue({ data: {}, error: null });
    const user = userEvent.setup();
    renderAt({ pathname: '/signin', state: { from: { pathname: '/item/abc' } } });

    await user.type(screen.getByLabelText(/email/i), 'reader@example.com');
    await user.click(screen.getByRole('button', { name: /email me a link/i }));

    // Confirmation replaces the form; no in-app navigation (the user completes
    // sign-in from their inbox).
    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
    expect(screen.getByText('reader@example.com')).toBeInTheDocument();
    expect(screen.queryByTestId('landed')).toBeNull();

    // The magic link returns to the saved deep link once clicked.
    expect(mocks.signInWithOtp).toHaveBeenCalledTimes(1);
    const arg = mocks.signInWithOtp.mock.calls[0][0];
    expect(arg.email).toBe('reader@example.com');
    expect(arg.options.emailRedirectTo).toMatch(/\/item\/abc$/);
  });

  it('surfaces a send error inline and keeps the form', async () => {
    mocks.signInWithOtp.mockResolvedValue({
      data: {},
      error: { message: 'Email rate limit exceeded' },
    });
    const user = userEvent.setup();
    renderAt({ pathname: '/signin' });

    await user.type(screen.getByLabelText(/email/i), 'reader@example.com');
    await user.click(screen.getByRole('button', { name: /email me a link/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /rate limit/i,
    );
    // Still on the form (not the confirmation), so the user can retry.
    expect(screen.queryByText(/check your email/i)).toBeNull();
    expect(
      screen.getByRole('button', { name: /email me a link/i }),
    ).toBeInTheDocument();
  });

  // supabaseFetch leaves /auth/v1/ POSTs uncapped, so signInWithEmail bounds the
  // send itself — otherwise a lie-fi hang strands the form disabled forever.
  // Tested at the hook level (deterministic fake timers, no DOM polling).
  it('recovers with a retryable error when the send hangs (timeout)', async () => {
    mocks.signInWithOtp.mockReturnValue(new Promise(() => {})); // never settles
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAuth());
      let outcome: { error: string | null } | undefined;
      await act(async () => {
        const pending = result.current.signInWithEmail('reader@example.com');
        // Drive past the 15s bound; advanceTimersByTimeAsync flushes the
        // microtasks the timeout's rejection schedules.
        await vi.advanceTimersByTimeAsync(15_000);
        outcome = await pending;
      });
      expect(outcome?.error).toMatch(/could not send|try again/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers with a retryable error when the send rejects', async () => {
    mocks.signInWithOtp.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useAuth());
    let outcome: { error: string | null } | undefined;
    await act(async () => {
      outcome = await result.current.signInWithEmail('reader@example.com');
    });
    // A thrown network error must resolve to a message, not throw out of the
    // hook and leave the page stuck in its "sending" phase.
    expect(outcome?.error).toMatch(/could not send|try again/i);
  });
});
