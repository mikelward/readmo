import { createContext, useContext } from 'react';

export interface ToastOptions {
  message: string;
  /** Optional underlying detail (e.g. the server error message) shown behind a
   * "Details" disclosure — the same text handed to console.error, so an error
   * toast points at the cause on mobile (where the console isn't visible). A
   * toast carrying a detail stays up longer by default so it can be expanded. */
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
  // Toasts sharing a groupKey replace each other in place without
  // restarting the entry animation. Used for batched updates (e.g.
  // a growing "Dismissed N · Undo" while the user keeps dismissing).
  groupKey?: string;
}

export interface ToastContextValue {
  showToast: (opts: ToastOptions) => void;
}

// Default no-op so callers work without a provider (useful in tests that
// don't need to assert on toast output).
export const ToastContext = createContext<ToastContextValue>({
  showToast: () => {},
});

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}
