import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PALETTE_STORAGE_KEY,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  applyPalette,
  applyTheme,
  applyThemeColorMeta,
  getStoredPalette,
  getStoredTheme,
  resolveTheme,
  setStoredPalette,
  setStoredTheme,
} from './theme';

function installMetaThemeColor(initial = ''): HTMLMetaElement {
  const existing = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (existing) existing.remove();
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = initial;
  document.head.appendChild(meta);
  return meta;
}

describe('theme lib', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-palette');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-palette');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.remove();
  });

  it('defaults to "system" when storage is empty', () => {
    expect(getStoredTheme()).toBe('system');
  });

  it('reads a stored theme', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(getStoredTheme()).toBe('dark');
  });

  it('ignores garbage values in storage', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(getStoredTheme()).toBe('system');
  });

  it('setStoredTheme persists explicit themes and sets the attribute', () => {
    setStoredTheme('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    setStoredTheme('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('setStoredTheme("system") clears the attribute and the key', () => {
    setStoredTheme('dark');
    setStoredTheme('system');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('setStoredTheme fires a change event', () => {
    const handler = vi.fn();
    window.addEventListener(THEME_CHANGE_EVENT, handler);
    setStoredTheme('dark');
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(THEME_CHANGE_EVENT, handler);
  });

  it('applyTheme toggles the attribute without touching storage', () => {
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('resolveTheme returns explicit values as-is', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
  });

  it('applyThemeColorMeta writes the paper color for light', () => {
    const meta = installMetaThemeColor();
    applyThemeColorMeta('light');
    expect(meta.content).toBe('#faf9f5');
  });

  it('applyThemeColorMeta writes the near-black color for dark', () => {
    const meta = installMetaThemeColor();
    applyThemeColorMeta('dark');
    expect(meta.content).toBe('#14161c');
  });

  it('applyThemeColorMeta is a no-op when the meta is missing', () => {
    expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
    expect(() => applyThemeColorMeta('dark')).not.toThrow();
  });

  it('applyTheme updates the meta color alongside data-theme', () => {
    const meta = installMetaThemeColor('#ffffff');
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(meta.content).toBe('#14161c');
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(meta.content).toBe('#faf9f5');
  });

  it('setStoredTheme updates the meta color too', () => {
    const meta = installMetaThemeColor();
    setStoredTheme('dark');
    expect(meta.content).toBe('#14161c');
    setStoredTheme('light');
    expect(meta.content).toBe('#faf9f5');
  });

  it('resolveTheme follows matchMedia when set to system', () => {
    const spy = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(prefers-color-scheme: dark)',
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
          onchange: null,
        }) as unknown as MediaQueryList,
    );
    expect(resolveTheme('system')).toBe('dark');
    spy.mockRestore();
  });
});

describe('palette', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-palette');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-palette');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.remove();
  });

  it('defaults to "ink" when storage is empty', () => {
    expect(getStoredPalette()).toBe('ink');
  });

  it('reads a stored palette and ignores garbage', () => {
    window.localStorage.setItem(PALETTE_STORAGE_KEY, 'clay');
    expect(getStoredPalette()).toBe('clay');
    window.localStorage.setItem(PALETTE_STORAGE_KEY, 'magenta');
    expect(getStoredPalette()).toBe('ink');
  });

  it('setStoredPalette persists clay and sets data-palette', () => {
    setStoredPalette('clay');
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('clay');
    expect(document.documentElement.getAttribute('data-palette')).toBe('clay');
  });

  it('setStoredPalette persists slate and sets data-palette', () => {
    setStoredPalette('slate');
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('slate');
    expect(document.documentElement.getAttribute('data-palette')).toBe('slate');
  });

  it('setStoredPalette("ink") clears the attribute and the key', () => {
    setStoredPalette('clay');
    setStoredPalette('ink');
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false);
  });

  it('applyPalette toggles the attribute without touching storage', () => {
    applyPalette('clay');
    expect(document.documentElement.getAttribute('data-palette')).toBe('clay');
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBeNull();
    applyPalette('ink');
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false);
  });

  it('setStoredPalette fires a change event', () => {
    const handler = vi.fn();
    window.addEventListener(THEME_CHANGE_EVENT, handler);
    setStoredPalette('clay');
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(THEME_CHANGE_EVENT, handler);
  });

  it('meta theme-color tracks the palette as well as the mode', () => {
    const meta = installMetaThemeColor();
    // ink (default) light/dark
    applyThemeColorMeta('light', 'ink');
    expect(meta.content).toBe('#faf9f5');
    applyThemeColorMeta('dark', 'ink');
    expect(meta.content).toBe('#14161c');
    // clay light/dark
    applyThemeColorMeta('light', 'clay');
    expect(meta.content).toBe('#faf4f1');
    applyThemeColorMeta('dark', 'clay');
    expect(meta.content).toBe('#1b1614');
    // slate light/dark
    applyThemeColorMeta('light', 'slate');
    expect(meta.content).toBe('#f3f5fa');
    applyThemeColorMeta('dark', 'slate');
    expect(meta.content).toBe('#141821');
  });

  it('setStoredPalette repaints the meta color for the current mode', () => {
    const meta = installMetaThemeColor();
    setStoredTheme('light');
    setStoredPalette('clay');
    expect(meta.content).toBe('#faf4f1');
    setStoredTheme('dark');
    // mode flip under clay → dark clay bg
    expect(meta.content).toBe('#1b1614');
  });
});
