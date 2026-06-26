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
});
