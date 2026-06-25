export const THEME_STORAGE_KEY = 'readmo:theme';
export const PALETTE_STORAGE_KEY = 'readmo:palette';
export const FONT_SIZE_STORAGE_KEY = 'readmo:fontSize';
export const THEME_CHANGE_EVENT = 'readmo:themeChanged';

// "Mode" (light/dark/system) and "palette" (color family) are orthogonal: each
// palette ships its own light and dark variants, so the user picks both. Mode
// drives the `data-theme` attribute; palette drives `data-palette`. `global.css`
// combines them (e.g. `:root[data-palette='grape'][data-theme='dark']`).
export type Theme = 'light' | 'dark' | 'system';
export type Palette = 'ink' | 'grape';

// Body text size, in px. The values double as both the stored token and the
// `data-font-size` attribute; `global.css` maps each to `--rm-font-size`. `16`
// is the default (Medium) and owns the bare `:root` block (no attribute),
// matching the theme/palette default pattern.
export type FontSize = '15' | '16' | '17';

const THEMES: readonly Theme[] = ['light', 'dark', 'system'];
const PALETTES: readonly Palette[] = ['ink', 'grape'];
const FONT_SIZES: readonly FontSize[] = ['15', '16', '17'];

// 16px (Medium) is the default, so it owns the bare `:root` block and needs no
// `data-font-size` attribute.
const DEFAULT_FONT_SIZE: FontSize = '16';

// Display labels for the size pickers (Settings text buttons + the drawer's
// A-glyph row). A relative Small/Medium/Large scale rather than raw px.
export const FONT_SIZE_LABELS: Record<FontSize, string> = {
  '15': 'Small',
  '16': 'Medium',
  '17': 'Large',
};

// Display names for each palette, used by the drawer/settings pickers.
export const PALETTE_LABELS: Record<Palette, string> = {
  ink: 'Ink',
  grape: 'Grape',
};

// Representative light-variant colors for the palette swatch in the picker.
// These mirror the light blocks in `global.css`; they live here (rather than
// being read from CSS vars) because a swatch must show each palette's identity
// colors regardless of which palette is currently applied — the `--rm-*` vars
// only ever reflect the active one.
export const PALETTE_SWATCHES: Record<Palette, { bg: string; accent: string }> =
  {
    ink: { bg: '#faf9f5', accent: '#363636' },
    grape: { bg: '#f7f3fb', accent: '#6d2c91' },
  };

// Ink is the default palette, so it owns the bare `:root`/`[data-theme]` blocks
// and needs no `data-palette` attribute.
const DEFAULT_PALETTE: Palette = 'ink';

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function isTheme(value: unknown): value is Theme {
  return (
    typeof value === 'string' && (THEMES as readonly string[]).includes(value)
  );
}

function isPalette(value: unknown): value is Palette {
  return (
    typeof value === 'string' && (PALETTES as readonly string[]).includes(value)
  );
}

function isFontSize(value: unknown): value is FontSize {
  return (
    typeof value === 'string' &&
    (FONT_SIZES as readonly string[]).includes(value)
  );
}

export function getStoredTheme(): Theme {
  if (!hasWindow()) return 'system';
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function getStoredPalette(): Palette {
  if (!hasWindow()) return DEFAULT_PALETTE;
  try {
    const raw = window.localStorage.getItem(PALETTE_STORAGE_KEY);
    return isPalette(raw) ? raw : DEFAULT_PALETTE;
  } catch {
    return DEFAULT_PALETTE;
  }
}

export function getStoredFontSize(): FontSize {
  if (!hasWindow()) return DEFAULT_FONT_SIZE;
  try {
    const raw = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
    return isFontSize(raw) ? raw : DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

// These have to match the `--rm-bg` values in `global.css`: the browser
// paints `<meta name="theme-color">` above the page, and we want that
// strip to be indistinguishable from the sticky app header. Keyed by palette
// then resolved mode so the chrome tint tracks both axes.
const META_THEME_COLORS: Record<Palette, Record<'light' | 'dark', string>> = {
  ink: { light: '#faf9f5', dark: '#14161c' },
  grape: { light: '#f7f3fb', dark: '#1a141f' },
} as const;

// Keep the browser's address-bar / OS-chrome tint in sync with the
// resolved theme. The inline boot in index.html seeds this on first
// paint; this module keeps it current when the user flips the drawer
// toggle or the OS `prefers-color-scheme` changes under a `system`
// selection. Without this, forcing dark-on-light (or vice versa) leaves
// a stale band of the wrong color above the header.
export function applyThemeColorMeta(
  resolved: 'light' | 'dark',
  palette: Palette = getStoredPalette(),
): void {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (meta) meta.content = META_THEME_COLORS[palette][resolved];
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  applyThemeColorMeta(resolveTheme(theme));
}

export function applyPalette(palette: Palette): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (palette === DEFAULT_PALETTE) {
    root.removeAttribute('data-palette');
  } else {
    root.setAttribute('data-palette', palette);
  }
}

export function applyFontSize(fontSize: FontSize): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (fontSize === DEFAULT_FONT_SIZE) {
    root.removeAttribute('data-font-size');
  } else {
    root.setAttribute('data-font-size', fontSize);
  }
}

export function setStoredTheme(theme: Theme): void {
  if (!hasWindow()) return;
  try {
    if (theme === 'system') {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  } catch {
    // quota or privacy-mode failures are non-fatal
  }
  applyTheme(theme);
  window.dispatchEvent(
    new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme } }),
  );
}

export function setStoredPalette(palette: Palette): void {
  if (hasWindow()) {
    try {
      if (palette === DEFAULT_PALETTE) {
        window.localStorage.removeItem(PALETTE_STORAGE_KEY);
      } else {
        window.localStorage.setItem(PALETTE_STORAGE_KEY, palette);
      }
    } catch {
      // quota or privacy-mode failures are non-fatal
    }
  }
  applyPalette(palette);
  // The chrome tint depends on both axes, so re-sync it against the current mode
  // under the new palette.
  applyThemeColorMeta(resolveTheme(getStoredTheme()), palette);
  window.dispatchEvent(
    new CustomEvent(THEME_CHANGE_EVENT, { detail: { palette } }),
  );
}

export function setStoredFontSize(fontSize: FontSize): void {
  if (hasWindow()) {
    try {
      if (fontSize === DEFAULT_FONT_SIZE) {
        window.localStorage.removeItem(FONT_SIZE_STORAGE_KEY);
      } else {
        window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, fontSize);
      }
    } catch {
      // quota or privacy-mode failures are non-fatal
    }
  }
  applyFontSize(fontSize);
  window.dispatchEvent(
    new CustomEvent(THEME_CHANGE_EVENT, { detail: { fontSize } }),
  );
}

// Browsers only expose "prefers dark" vs "not dark", so treat anything that
// isn't an explicit dark match as light.
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  if (!hasWindow() || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}
