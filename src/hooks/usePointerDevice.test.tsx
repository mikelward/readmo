import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePointerDevice } from './usePointerDevice';

type Listener = () => void;

function stubMatchMedia(initialMatches: boolean) {
  const listeners = new Set<Listener>();
  let matches = initialMatches;
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes('hover: hover') ? matches : false;
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    setMatches(value: boolean) {
      matches = value;
      listeners.forEach((cb) => cb());
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

describe('usePointerDevice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when the primary pointer supports hover', () => {
    const mql = stubMatchMedia(true);
    try {
      const { result } = renderHook(() => usePointerDevice());
      expect(result.current).toBe(true);
    } finally {
      mql.restore();
    }
  });

  it('returns false on a touch-only device', () => {
    const mql = stubMatchMedia(false);
    try {
      const { result } = renderHook(() => usePointerDevice());
      expect(result.current).toBe(false);
    } finally {
      mql.restore();
    }
  });

  it('reacts to a change in hover capability', () => {
    const mql = stubMatchMedia(false);
    try {
      const { result } = renderHook(() => usePointerDevice());
      expect(result.current).toBe(false);
      act(() => mql.setMatches(true));
      expect(result.current).toBe(true);
    } finally {
      mql.restore();
    }
  });
});
