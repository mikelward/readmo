import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { useShareItem } from './useShareItem';
import { ToastProvider } from '../components/Toast';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(ToastProvider, null, children);
}

const item = { title: 'A story', url: 'https://example.com/post' };

const realNavigator = window.navigator;

function setNavigator(value: unknown) {
  Object.defineProperty(window, 'navigator', {
    configurable: true,
    value,
  });
}

describe('useShareItem', () => {
  afterEach(() => {
    setNavigator(realNavigator);
  });

  it('shares the original article url via navigator.share', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigator({ share });
    const { result } = renderHook(() => useShareItem(), { wrapper });
    await act(async () => {
      await result.current(item);
    });
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/post' }),
    );
  });

  it('falls back to the clipboard and writes the original url when share is absent', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator({ clipboard: { writeText } });
    const { result } = renderHook(() => useShareItem(), { wrapper });
    await act(async () => {
      await result.current(item);
    });
    expect(writeText).toHaveBeenCalledWith('https://example.com/post');
  });
});
