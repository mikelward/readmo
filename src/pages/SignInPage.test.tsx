import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { DataSourceProvider } from '../lib/data/context';
import { MockDataSource } from '../lib/data/MockDataSource';
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
  // The hero now renders real ItemRow components against mock FeedItems
  // (SignInPage.tsx), which need a DataSource + QueryClient in context even
  // though the page itself never reads real data.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const source = new MockDataSource(`test-${Math.random()}`);
  return render(
    <QueryClientProvider client={queryClient}>
      <DataSourceProvider source={source}>
        <ToastProvider>
          <MemoryRouter initialEntries={[entry]}>
            <Routes>
              <Route path="/signin" element={<SignInPage />} />
              <Route path="*" element={<LocationProbe />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </DataSourceProvider>
    </QueryClientProvider>,
  );
}

describe('SignInPage', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllEnvs();
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

  it('hides the email form unless VITE_EMAIL_AUTH_ENABLED is set', () => {
    // Flag unset (the default) → only the OAuth buttons, no email field/divider.
    renderAt({ pathname: '/signin' });
    expect(screen.queryByLabelText(/email/i)).toBeNull();
    expect(
      screen.queryByRole('button', { name: /email me a link/i }),
    ).toBeNull();
    expect(document.querySelector('.signin__divider')).toBeNull();
    // OAuth is unaffected.
    expect(
      screen.getByRole('button', { name: /continue with google/i }),
    ).toBeInTheDocument();
  });

  it('signs in via the email form and lands on the saved deep link (mock path)', async () => {
    vi.stubEnv('VITE_EMAIL_AUTH_ENABLED', 'true');
    const user = userEvent.setup();
    renderAt({ pathname: '/signin', state: { from: { pathname: '/item/xyz' } } });
    await user.type(screen.getByLabelText(/email/i), 'reader@example.com');
    await user.click(screen.getByRole('button', { name: /email me a link/i }));
    // Mock mode signs in immediately (no email sent), so we land on the target.
    expect(screen.getByTestId('location')).toHaveTextContent('/item/xyz');
  });

  it('renders the feed preview hero when signed out', () => {
    renderAt({ pathname: '/signin' });
    expect(document.querySelector('.signin__hero')).not.toBeNull();
    const rows = document.querySelectorAll('.item-row');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('renders the hero rows through the real ItemRow, meta line in the same order/format', () => {
    // Regression: the hero used to hand-roll "source · age · domain" as a
    // template string, which could (and did) drift from the real row's
    // format. Now it renders real ItemRow against mock FeedItems, so the meta
    // line comes from the same lib/itemMeta.ts helper every other row uses.
    // No domain badge (each demo article links to its own feed's site, same
    // rule as a real non-aggregator row); the AP News row's own category
    // ("Health") fills that fallback slot instead, same as a real row.
    renderAt({ pathname: '/signin' });
    const metas = screen.getAllByTestId('item-meta');
    expect(metas[0]).toHaveTextContent('AP News · Health · 1h');
    expect(metas[0]).not.toHaveTextContent('apnews.com');
    // r/popular is an aggregate feed; its category is the ORIGIN subreddit
    // (Reddit's own RSS shape), not a topic tag.
    expect(metas[1]).toHaveTextContent('r/popular · MadeMeSmile · 4h');
  });

  it('makes the hero fully inert — not a real navigable/tappable list', () => {
    // The rows are real ItemRow components (a real Link to /item/:id, a real
    // pin button that writes item state) but this is a decorative preview,
    // not a live list — `inert` must block all interaction, not just
    // aria-hidden (which only affects assistive tech, not focus/clicks).
    renderAt({ pathname: '/signin' });
    expect(document.querySelector('.signin__hero')).toHaveAttribute('inert');
  });

  it('redirects an already-signed-in user off /signin to the saved target', () => {
    window.localStorage.setItem(MOCK_SIGNED_IN_KEY, '1');
    renderAt({ pathname: '/signin', state: { from: { pathname: '/folder/tech' } } });
    expect(screen.getByTestId('location')).toHaveTextContent('/folder/tech');
    expect(screen.queryByRole('button', { name: /continue with/i })).toBeNull();
  });
});
