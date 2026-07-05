import { createContext, useContext, type ReactNode } from 'react';
import type { DataSource } from './DataSource';

const DataSourceContext = createContext<DataSource | null>(null);

export function DataSourceProvider({
  source,
  children,
}: {
  source: DataSource;
  children: ReactNode;
}) {
  return (
    <DataSourceContext.Provider value={source}>
      {children}
    </DataSourceContext.Provider>
  );
}

/** Access the active DataSource. `main.tsx` provides a `SupabaseDataSource` when
 * Supabase is configured (the live path) and a `MockDataSource` otherwise (the
 * backend-less local/demo fallback) — consumers see only this interface. */
export function useDataSource(): DataSource {
  const ctx = useContext(DataSourceContext);
  if (!ctx) {
    throw new Error('useDataSource must be used within a DataSourceProvider');
  }
  return ctx;
}
