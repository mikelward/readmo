import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { lazy, Suspense, type ReactNode } from 'react';
import { AppHeader } from './components/AppHeader';
import { AppUpdateWatcher } from './components/AppUpdateWatcher';
import { ScrollToTop } from './components/ScrollToTop';
import { KeyboardShortcutsOverlay } from './components/KeyboardShortcutsOverlay';
import { FeedBarProvider } from './components/FeedBarContext';
import { useAuth } from './hooks/useAuth';
import { useUserCacheScope } from './hooks/useUserCacheScope';
import { useOfflineCacheLock } from './hooks/useOfflineCacheLock';
import { useFeedInvalidation } from './hooks/useFeedInvalidation';
import { useStateSync } from './hooks/useStateSync';
import { HomePage, FolderPage, FeedPage } from './pages/FeedPages';
import {
  PinnedPage,
  FavoritesPage,
  DonePage,
  OpenedPage,
} from './pages/LibraryPages';
import { ItemPage } from './pages/ItemPage';
import { SearchPage } from './pages/SearchPage';
import { OfflinePage } from './pages/OfflinePage';
import { SignInPage } from './pages/SignInPage';
import { AboutPage } from './pages/AboutPage';
import { DebugPage } from './pages/DebugPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { LazyRouteBoundary } from './components/LazyRouteBoundary';

/** Settings carries the curated popular-feeds catalog (the app's largest static
 * data blob) and is visited rarely, so it's split into its own chunk loaded on
 * navigation rather than baked into the initial bundle. The service worker
 * precaches the chunk, so it stays available offline after the first load. */
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

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
  // Keep pinned/favorited items' reader queries cached for offline (lock while
  // bucketed, evict when neither). Mounted once here so it tracks state app-wide.
  useOfflineCacheLock();
  // Invalidate feed caches on any state change, even while the feed list is
  // unmounted (e.g. user marks Done on the reader page then navigates back).
  useFeedInvalidation();
  // Re-pull item state when the tab regains focus/visibility or comes back
  // online, so pins/favorites/done changed on another device sync in.
  useStateSync();
  // Gate rendering across an auth transition: while the previous user's caches
  // are being purged and the app reloads, paint nothing so the next user can't
  // briefly see the previous user's cached content (guardrail #8).
  if (useUserCacheScope()) return null;
  return (
    <FeedBarProvider>
      <AppUpdateWatcher />
      <ScrollToTop />
      <AppHeader />
      <main className="app-main">
        <Suspense fallback={null}>
          <Routes>
            <Route path="/signin" element={<SignInPage />} />
            {/* Open to everyone (no auth gate) — informational, no user data. */}
            <Route path="/about" element={<AboutPage />} />
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
                    <Route path="/opened" element={<OpenedPage />} />
                    <Route path="/offline" element={<OfflinePage />} />
                    <Route path="/item/:id" element={<ItemPage />} />
                    <Route path="/search" element={<SearchPage />} />
                    <Route
                      path="/settings"
                      element={
                        <LazyRouteBoundary>
                          <SettingsPage />
                        </LazyRouteBoundary>
                      }
                    />
                    <Route path="*" element={<NotFoundPage />} />
                  </Routes>
                </RequireAuth>
              }
            />
          </Routes>
        </Suspense>
      </main>
      <KeyboardShortcutsOverlay />
    </FeedBarProvider>
  );
}
