import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import App from './App';
import { ToastProvider } from './components/Toast';
import { DataSourceProvider } from './lib/data/context';
import { MockDataSource } from './lib/data/MockDataSource';
import { SupabaseDataSource } from './lib/data/SupabaseDataSource';
import { isSupabaseConfigured } from './lib/supabase/client';
import {
  applyFont,
  applyFontSize,
  applyPalette,
  applyTheme,
  getStoredFont,
  getStoredFontSize,
  getStoredPalette,
  getStoredTheme,
} from './lib/theme';
// Self-hosted typefaces for the Settings "Font" picker (Fontsource). Each
// @font-face only triggers a network fetch when text in that family is actually
// rendered, so a normal page loads just the active font; the Settings picker,
// which previews every option in its own face, is the only place all of them
// load. Variable (wght axis) where available; Fira Sans ships static weights.
import '@fontsource-variable/roboto/wght.css';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/public-sans/wght.css';
import '@fontsource-variable/work-sans/wght.css';
import '@fontsource/fira-sans/latin-400.css';
import '@fontsource/fira-sans/latin-500.css';
import '@fontsource/fira-sans/latin-600.css';
import '@fontsource/fira-sans/latin-700.css';
import '@fontsource/fira-sans/latin-800.css';
import { getActiveUid } from './hooks/useAuth';
import {
  itemStateKey,
  reconcileUserCachesOnBoot,
  rqCacheKey,
} from './lib/userCache';
import './styles/global.css';

// Bump to invalidate the persisted query cache on a breaking shape change.
const CACHE_BUSTER = '1';
// Pinned/Favorited content must survive arbitrarily long offline gaps, so the
// persister never discards the blob by age. (PR2 moves the persisted store to
// IndexedDB for article bodies; PR1 uses localStorage with the mock seed.)
const PERSIST_MAX_AGE = Number.POSITIVE_INFINITY;

/**
 * Don't retry when the server itself is the problem — a 5xx / PGRST error
 * or a timed-out request won't improve on an immediate retry, and retrying
 * doubles the time before the user sees the error UI. Retry once for
 * everything else (transient network blip, dropped connection).
 */
function shouldRetry(_count: number, error: unknown): boolean {
  // Timed-out request (supabaseFetch aborts with TimeoutError after 15 s).
  if (error instanceof DOMException && error.name === 'TimeoutError') return false;
  // PostgREST / Supabase JS error — has a numeric `status` field.
  if (error != null && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number' && status >= 500) return false;
  }
  // Default: retry once.
  return _count < 1;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 60 * 60 * 1000,
      retry: shouldRetry,
      refetchOnWindowFocus: false,
      // The service worker answers from the Cache API when it can, so run the
      // fetch even when the browser reports offline; a true miss surfaces as
      // an error the offline UI can render (newshacker's rationale).
      networkMode: 'offlineFirst',
    },
  },
});

// Per-user cache scoping (AGENTS guardrail #8). The persisted query cache and
// item-state store are keyed by the signed-in user so a second user on a shared
// device can't hydrate the previous user's content. The boot uid is read
// synchronously (like the theme below) so these singletons are scoped correctly
// before first paint. On any auth transition App (useUserCacheScope) purges the
// departing user's caches and reloads, which re-runs this boot keying for the
// new user — so signing in from a signed-out boot is re-keyed too, not left on
// the unscoped base store. Seamless re-keying without a reload, and per-user
// prefixing of the Workbox runtime caches, land with real multi-user auth in PR2.
const bootUid = getActiveUid();

// Apply the stored theme + palette + text size before first paint to avoid a
// flash.
applyTheme(getStoredTheme());
applyPalette(getStoredPalette());
applyFontSize(getStoredFontSize());
applyFont(getStoredFont());

// Reconcile on-device caches for this user BEFORE building the persister/data
// source or painting: migrate legacy global stores into the user's scope, and
// purge a previous user's caches if this boot is a different user (e.g. an
// account switch via full-page redirect, where no in-tab transition fired). The
// persister + data source read localStorage on construction, so they must be
// created only after the reconcile so they see the migrated, correctly-scoped
// data. Same-user boots skip the purge and hydrate their own cache.
void reconcileUserCachesOnBoot(bootUid).finally(() => {
  const persister = createSyncStoragePersister({
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    key: rqCacheKey(bootUid),
    throttleTime: 1000,
  });
  // Live Supabase source when configured (real RLS-scoped subscriptions + item
  // state, written through to the server); otherwise the mock seed for
  // backend-less local/demo dev. Both key their item-state store by the boot uid.
  const dataSource = isSupabaseConfigured()
    ? new SupabaseDataSource(itemStateKey(bootUid))
    : new MockDataSource(itemStateKey(bootUid));

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: PERSIST_MAX_AGE,
          buster: CACHE_BUSTER,
        }}
        onSuccess={() => {
          // After the persisted cache is hydrated, invalidate feed queries so
          // any Done/Hidden item state that preexisted the React tree (hydrated
          // synchronously from localStorage before first render) takes effect
          // immediately rather than waiting for the 5-minute staleTime to expire.
          void queryClient.invalidateQueries({ queryKey: ['feed'] });
        }}
      >
        <DataSourceProvider source={dataSource}>
          <ToastProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </ToastProvider>
        </DataSourceProvider>
      </PersistQueryClientProvider>
    </StrictMode>,
  );
});
