import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppHeader } from './components/AppHeader';
import { ScrollToTop } from './components/ScrollToTop';
import { KeyboardShortcutsOverlay } from './components/KeyboardShortcutsOverlay';
import { FeedBarProvider } from './components/FeedBarContext';
import { useAuth } from './hooks/useAuth';
import { useUserCacheScope } from './hooks/useUserCacheScope';
import { HomePage, FolderPage, FeedPage } from './pages/FeedPages';
import {
  PinnedPage,
  FavoritesPage,
  DonePage,
  HiddenPage,
  OpenedPage,
} from './pages/LibraryPages';
import { ItemPage } from './pages/ItemPage';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/SettingsPage';
import { OfflinePage } from './pages/OfflinePage';
import { SignInPage } from './pages/SignInPage';
import { DebugPage } from './pages/DebugPage';
import { NotFoundPage } from './pages/NotFoundPage';

/** Signed-in gate. First launch with no session routes to /signin; deep links
 * round-trip through sign-in and then land on the target (SPEC.md *Auth*). */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, initializing } = useAuth();
  const location = useLocation();
  if (!user) {
    // A configured Supabase session may still be settling (e.g. a fresh OAuth
    // callback whose token is in the URL hash). Hold rather than bounce to
    // /signin, which would drop the callback and strand the user there.
    if (initializing) return null;
    return <Navigate to="/signin" replace state={{ from: location }} />;
  }
  return <>{children}</>;
}

export default function App() {
  // Gate rendering across an auth transition: while the previous user's caches
  // are being purged and the app reloads, paint nothing so the next user can't
  // briefly see the previous user's cached content (guardrail #8).
  if (useUserCacheScope()) return null;
  return (
    <FeedBarProvider>
      <ScrollToTop />
      <AppHeader />
      <main className="app-main">
        <Routes>
          <Route path="/signin" element={<SignInPage />} />
          {/* Open to everyone (no auth gate) — diagnostics only, no secrets. */}
          <Route path="/debug" element={<DebugPage />} />
          <Route
            path="/*"
            element={
              <RequireAuth>
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/folder/:name" element={<FolderPage />} />
                  <Route path="/feed/:feedId" element={<FeedPage />} />
                  <Route path="/pinned" element={<PinnedPage />} />
                  <Route path="/favorites" element={<FavoritesPage />} />
                  <Route path="/done" element={<DonePage />} />
                  <Route path="/hidden" element={<HiddenPage />} />
                  <Route path="/opened" element={<OpenedPage />} />
                  <Route path="/offline" element={<OfflinePage />} />
                  <Route path="/item/:id" element={<ItemPage />} />
                  <Route path="/search" element={<SearchPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </RequireAuth>
            }
          />
        </Routes>
      </main>
      <KeyboardShortcutsOverlay />
    </FeedBarProvider>
  );
}
