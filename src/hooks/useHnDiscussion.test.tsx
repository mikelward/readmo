import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useHnDiscussion } from './useHnDiscussion';
import * as hnDiscussion from '../lib/hnDiscussion';

const findSpy = vi.spyOn(hnDiscussion, 'findHnDiscussion');

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/** A wrapper backed by ONE QueryClient so a remount (reopening the article)
 * shares the cache — gcTime Infinity keeps the entry across the unmount. */
function sharedWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  findSpy.mockReset();
});

describe('useHnDiscussion', () => {
  it('resolves the discussion for a safe URL', async () => {
    findSpy.mockResolvedValue({ id: '55', numComments: 8 });
    const { result } = renderHook(() => useHnDiscussion('https://example.com/a'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current).toEqual({ id: '55', numComments: 8 }));
    expect(findSpy).toHaveBeenCalledWith('https://example.com/a');
  });

  it('does not look up an unsafe or missing URL', async () => {
    const { result } = renderHook(() => useHnDiscussion('javascript:alert(1)'), {
      wrapper: wrapper(),
    });
    expect(result.current).toBeNull();
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('does not look up a possibly-tokenized URL', async () => {
    findSpy.mockResolvedValue({ id: '1', numComments: 1 });
    const { result } = renderHook(
      () => useHnDiscussion('https://example.com/article?token=secret'),
      { wrapper: wrapper() },
    );
    expect(result.current).toBeNull();
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('does not look up when disabled (e.g. offline)', async () => {
    findSpy.mockResolvedValue({ id: '9', numComments: 1 });
    const { result } = renderHook(
      () => useHnDiscussion('https://example.com/a', false),
      { wrapper: wrapper() },
    );
    expect(result.current).toBeNull();
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('retries a null result on a later open (negative results are not cached forever)', async () => {
    findSpy.mockResolvedValue(null);
    const wrap = sharedWrapper();
    const first = renderHook(() => useHnDiscussion('https://example.com/a'), {
      wrapper: wrap,
    });
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(1));
    first.unmount();
    // Reopen the same article: the null is stale, so it looks up again.
    renderHook(() => useHnDiscussion('https://example.com/a'), { wrapper: wrap });
    await waitFor(() => expect(findSpy).toHaveBeenCalledTimes(2));
  });

  it('returns null when disabled even if a hit is already cached (honors the fail-closed gate)', async () => {
    findSpy.mockResolvedValue({ id: '7', numComments: 3 });
    const wrap = sharedWrapper();
    const first = renderHook(() => useHnDiscussion('https://example.com/a'), {
      wrapper: wrap,
    });
    await waitFor(() =>
      expect(first.result.current).toEqual({ id: '7', numComments: 3 }),
    );
    first.unmount();
    // Same URL, now gated off (offline / private feed): the cached hit must not
    // leak through and re-enable the comments link.
    const second = renderHook(
      () => useHnDiscussion('https://example.com/a', false),
      { wrapper: wrap },
    );
    expect(second.result.current).toBeNull();
  });

  it('caches a found discussion (no refetch on reopen)', async () => {
    findSpy.mockResolvedValue({ id: '5', numComments: 2 });
    const wrap = sharedWrapper();
    const first = renderHook(() => useHnDiscussion('https://example.com/a'), {
      wrapper: wrap,
    });
    await waitFor(() =>
      expect(first.result.current).toEqual({ id: '5', numComments: 2 }),
    );
    first.unmount();
    const second = renderHook(() => useHnDiscussion('https://example.com/a'), {
      wrapper: wrap,
    });
    // Served from cache immediately, no second lookup.
    expect(second.result.current).toEqual({ id: '5', numComments: 2 });
    expect(findSpy).toHaveBeenCalledTimes(1);
  });
});
