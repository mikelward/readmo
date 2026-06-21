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

/** Access the active DataSource. PR1 provides a MockDataSource; PR2 swaps in
 * SupabaseDataSource with no change to any consumer. */
export function useDataSource(): DataSource {
  const ctx = useContext(DataSourceContext);
  if (!ctx) {
    throw new Error('useDataSource must be used within a DataSourceProvider');
  }
  return ctx;
}
