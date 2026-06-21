import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// Coordinates the sticky list toolbar (Undo + Sweep) with whichever list view
// is currently mounted. The active list registers a `sweep` implementation and
// the count of sweepable (visible, unpinned) rows; the toolbar reads them.
// Undo is sourced separately from the shared ItemStateStore (see ListToolbar).

interface FeedBarValue {
  sweep: (() => void) | null;
  sweepCount: number;
  registerSweep: (fn: (() => void) | null, count: number) => void;
}

const FeedBarContext = createContext<FeedBarValue | null>(null);

export function FeedBarProvider({ children }: { children: ReactNode }) {
  const [sweepCount, setSweepCount] = useState(0);
  const sweepRef = useRef<(() => void) | null>(null);

  const registerSweep = useCallback(
    (fn: (() => void) | null, count: number) => {
      sweepRef.current = fn;
      setSweepCount(count);
    },
    [],
  );

  const sweep = useCallback(() => {
    sweepRef.current?.();
  }, []);

  const value = useMemo<FeedBarValue>(
    () => ({
      sweep: sweepCount > 0 ? sweep : null,
      sweepCount,
      registerSweep,
    }),
    [sweep, sweepCount, registerSweep],
  );

  return (
    <FeedBarContext.Provider value={value}>{children}</FeedBarContext.Provider>
  );
}

export function useFeedBar(): FeedBarValue {
  const ctx = useContext(FeedBarContext);
  if (!ctx) {
    // Library views render the toolbar without a list that sweeps; provide a
    // safe inert default rather than throwing.
    return { sweep: null, sweepCount: 0, registerSweep: () => {} };
  }
  return ctx;
}
