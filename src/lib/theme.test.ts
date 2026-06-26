import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FONT_LABELS,
  FONT_SIZE_STORAGE_KEY,
  FONT_STACKS,
  FONT_STORAGE_KEY,
  PALETTE_STORAGE_KEY,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  applyFont,
  applyFontSize,
  applyPalette,
  applyTheme,
  applyThemeColorMeta,
  getStoredFont,
  getStoredFontSize,
  getStoredPalette,
  getStoredTheme,
  resolveTheme,
  setStoredFont,
  setStoredFontSize,
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
    window.localStorage.setItem(PALETTE_STORAGE_KEY, 'grape');
    expect(getStoredPalette()).toBe('grape');
    window.localStorage.setItem(PALETTE_STORAGE_KEY, 'magenta');
    expect(getStoredPalette()).toBe('ink');
  });

  it('setStoredPalette persists grape and sets data-palette', () => {
    setStoredPalette('grape');
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('grape');
    expect(document.documentElement.getAttribute('data-palette')).toBe('grape');
  });

  it('setStoredPalette("ink") clears the attribute and the key', () => {
    setStoredPalette('grape');
    setStoredPalette('ink');
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false);
  });

  it('applyPalette toggles the attribute without touching storage', () => {
    applyPalette('grape');
    expect(document.documentElement.getAttribute('data-palette')).toBe('grape');
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBeNull();
    applyPalette('ink');
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false);
  });

  it('setStoredPalette fires a change event', () => {
    const handler = vi.fn();
    window.addEventListener(THEME_CHANGE_EVENT, handler);
    setStoredPalette('grape');
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
    // grape light/dark
    applyThemeColorMeta('light', 'grape');
    expect(meta.content).toBe('#f7f3fb');
    applyThemeColorMeta('dark', 'grape');
    expect(meta.content).toBe('#1a141f');
  });

  it('setStoredPalette repaints the meta color for the current mode', () => {
    const meta = installMetaThemeColor();
    setStoredTheme('light');
    setStoredPalette('grape');
    expect(meta.content).toBe('#f7f3fb');
    setStoredTheme('dark');
    // mode flip under grape → dark grape bg
    expect(meta.content).toBe('#1a141f');
  });
});

describe('font size', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font-size');
  });

  it('defaults to "16" when storage is empty', () => {
    expect(getStoredFontSize()).toBe('16');
  });

  it('reads a stored font size and ignores garbage', () => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, '17');
    expect(getStoredFontSize()).toBe('17');
    // '18' is no longer an offered size, so it's rejected like any garbage.
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, '18');
    expect(getStoredFontSize()).toBe('16');
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, '99');
    expect(getStoredFontSize()).toBe('16');
  });

  it('setStoredFontSize persists a non-default size and sets the attribute', () => {
    setStoredFontSize('15');
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBe('15');
    expect(document.documentElement.getAttribute('data-font-size')).toBe('15');

    setStoredFontSize('17');
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBe('17');
    expect(document.documentElement.getAttribute('data-font-size')).toBe('17');
  });

  it('setStoredFontSize("16") clears the attribute and the key', () => {
    setStoredFontSize('17');
    setStoredFontSize('16');
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-font-size')).toBe(false);
  });

  it('applyFontSize toggles the attribute without touching storage', () => {
    applyFontSize('17');
    expect(document.documentElement.getAttribute('data-font-size')).toBe('17');
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBeNull();
    applyFontSize('16');
    expect(document.documentElement.hasAttribute('data-font-size')).toBe(false);
  });

  it('setStoredFontSize fires a change event', () => {
    const handler = vi.fn();
    window.addEventListener(THEME_CHANGE_EVENT, handler);
    setStoredFontSize('17');
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(THEME_CHANGE_EVENT, handler);
  });
});

describe('font family', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font');
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-font');
  });

  it('defaults to "roboto" when storage is empty', () => {
    expect(getStoredFont()).toBe('roboto');
  });

  it('reads a stored font and ignores garbage', () => {
    window.localStorage.setItem(FONT_STORAGE_KEY, 'inter');
    expect(getStoredFont()).toBe('inter');
    window.localStorage.setItem(FONT_STORAGE_KEY, 'comic-sans');
    expect(getStoredFont()).toBe('roboto');
  });

  it('setStoredFont persists a non-default font and sets the attribute', () => {
    setStoredFont('inter');
    expect(window.localStorage.getItem(FONT_STORAGE_KEY)).toBe('inter');
    expect(document.documentElement.getAttribute('data-font')).toBe('inter');

    setStoredFont('fira-sans');
    expect(window.localStorage.getItem(FONT_STORAGE_KEY)).toBe('fira-sans');
    expect(document.documentElement.getAttribute('data-font')).toBe('fira-sans');
  });

  it('setStoredFont("roboto") clears the attribute and the key (default owns bare root)', () => {
    setStoredFont('inter');
    setStoredFont('roboto');
    expect(window.localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute('data-font')).toBe(false);
  });

  it('the "system" option is a real, selectable value (escape hatch to native fonts)', () => {
    setStoredFont('system');
    expect(window.localStorage.getItem(FONT_STORAGE_KEY)).toBe('system');
    expect(document.documentElement.getAttribute('data-font')).toBe('system');
  });

  it('applyFont toggles the attribute without touching storage', () => {
    applyFont('work-sans');
    expect(document.documentElement.getAttribute('data-font')).toBe('work-sans');
    expect(window.localStorage.getItem(FONT_STORAGE_KEY)).toBeNull();
    applyFont('roboto');
    expect(document.documentElement.hasAttribute('data-font')).toBe(false);
  });

  it('setStoredFont fires a change event', () => {
    const handler = vi.fn();
    window.addEventListener(THEME_CHANGE_EVENT, handler);
    setStoredFont('inter');
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(THEME_CHANGE_EVENT, handler);
  });

  it('every option has a label and a font stack that ends in the system fallback', () => {
    for (const key of Object.keys(FONT_LABELS) as (keyof typeof FONT_LABELS)[]) {
      expect(FONT_LABELS[key]).toBeTruthy();
      // Each non-system option lists its webfont first, then the shared native
      // stack, so a failed font load degrades to native rendering.
      expect(FONT_STACKS[key]).toContain('-apple-system');
    }
  });
});
