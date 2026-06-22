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
import { applyTheme, getStoredTheme } from './lib/theme';
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 60 * 60 * 1000,
      retry: 1,
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
const persister = createSyncStoragePersister({
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  key: rqCacheKey(bootUid),
  throttleTime: 1000,
});

// Apply the stored theme before first paint to avoid a flash.
applyTheme(getStoredTheme());

const dataSource = new MockDataSource(itemStateKey(bootUid));

// If this boot is a different user than last time (e.g. an account switch via a
// full-page redirect/reload, where no in-tab transition was observed), purge the
// previous user's persisted stores + Workbox runtime caches BEFORE first paint,
// then render. Same-user boots skip the purge and hydrate their own cache.
void reconcileUserCachesOnBoot(bootUid).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: PERSIST_MAX_AGE,
          buster: CACHE_BUSTER,
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
