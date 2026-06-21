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

const persister = createSyncStoragePersister({
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  key: 'readmo:rq-cache',
  throttleTime: 1000,
});

// Apply the stored theme before first paint to avoid a flash.
applyTheme(getStoredTheme());

const dataSource = new MockDataSource();

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
