import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import {
  IsRestoringProvider,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { ToastProvider } from '../components/Toast';
import { FeedBarProvider } from '../components/FeedBarContext';
import { DataSourceProvider } from '../lib/data/context';
import { MockDataSource } from '../lib/data/MockDataSource';
import { useFeedInvalidation } from '../hooks/useFeedInvalidation';

function FeedInvalidationMount() {
  useFeedInvalidation();
  return null;
}

/** Wraps a UI tree in the full provider stack with a fresh, isolated
 * MockDataSource and a no-retry QueryClient, so component/integration tests
 * exercise the real data path without a network. */
export function renderWithProviders(
  ui: ReactElement,
  opts: {
    route?: string;
    source?: MockDataSource;
    queryClient?: QueryClient;
    /** Render as if `PersistQueryClientProvider` were still reading the
     * persisted query cache out of IndexedDB (the first moments of every boot).
     * React Query pins `fetchStatus` to 'idle' for the whole restore window, so
     * every query reports `isLoading === false` with no data — which is what
     * makes a placeholder gated on `isLoading` flash its EMPTY state over a
     * cache that is about to produce rows. Tests set this to hold that window
     * open and assert the view doesn't lie in it. */
    isRestoring?: boolean;
  } = {},
) {
  const source = opts.source ?? new MockDataSource(`test-${Math.random()}`);
  const queryClient =
    opts.queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <IsRestoringProvider value={!!opts.isRestoring}>
          <DataSourceProvider source={source}>
            <ToastProvider>
              <FeedBarProvider>
                <MemoryRouter initialEntries={[opts.route ?? '/']}>
                  <FeedInvalidationMount />
                  {children}
                </MemoryRouter>
              </FeedBarProvider>
            </ToastProvider>
          </DataSourceProvider>
        </IsRestoringProvider>
      </QueryClientProvider>
    );
  }

  return { source, queryClient, ...render(ui, { wrapper: Wrapper }) };
}
