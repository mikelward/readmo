import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { ToastProvider } from '../components/Toast';
import { FeedBarProvider } from '../components/FeedBarContext';
import { DataSourceProvider } from '../lib/data/context';
import { MockDataSource } from '../lib/data/MockDataSource';

/** Wraps a UI tree in the full provider stack with a fresh, isolated
 * MockDataSource and a no-retry QueryClient, so component/integration tests
 * exercise the real data path without a network. */
export function renderWithProviders(
  ui: ReactElement,
  opts: { route?: string; source?: MockDataSource; queryClient?: QueryClient } = {},
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
        <DataSourceProvider source={source}>
          <ToastProvider>
            <FeedBarProvider>
              <MemoryRouter initialEntries={[opts.route ?? '/']}>
                {children}
              </MemoryRouter>
            </FeedBarProvider>
          </ToastProvider>
        </DataSourceProvider>
      </QueryClientProvider>
    );
  }

  return { source, queryClient, ...render(ui, { wrapper: Wrapper }) };
}
