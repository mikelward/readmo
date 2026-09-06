export const THEME_STORAGE_KEY = 'readmo:theme';
export const PALETTE_STORAGE_KEY = 'readmo:palette';
export const FONT_SIZE_STORAGE_KEY = 'readmo:fontSize';
export const FONT_STORAGE_KEY = 'readmo:font';
export const THEME_CHANGE_EVENT = 'readmo:themeChanged';

// "Mode" (light/dark/system) and "palette" (color family) are orthogonal: each
// palette ships its own light and dark variants, so the user picks both. Mode
// drives the `data-theme` attribute; palette drives `data-palette`. `global.css`
// combines them (e.g. `:root[data-palette='grape'][data-theme='dark']`).
export type Theme = 'light' | 'dark' | 'system';
export type Palette = 'ink' | 'grape';

// Body text size, in px. The values double as both the stored token and the
// `data-font-size` attribute; `global.css` maps each to `--rm-font-size`. `16`
// is the default and owns the bare `:root` block (no attribute), matching the
// theme/palette default pattern — see DEFAULT_FONT_SIZE, which is the one
// place that decides it.
export type FontSize =
  | '14'
  | '15'
  | '16'
  | '17'
  | '18'
  | '19'
  | '20'
  | '22'
  | '24'
  | '26'
  | '28'
  | '30'
  | '32'
  | '34';

// Body typeface. Each non-system option is a self-hosted webfont (Fontsource)
// chosen so the app renders identically on every platform — the previous
// system-stack approach silently substituted whatever the OS had, so the look
// (and the unread/read weight step) was untestable and inconsistent across
// machines. Every shipped font carries a real 500 (Medium) face, which the
// unread-title weight depends on. `system` opts back into the native stack.
export type FontFamily =
  | 'roboto'
  | 'inter'
  | 'public-sans'
  | 'work-sans'
  | 'fira-sans'
  | 'system';

const THEMES: readonly Theme[] = ['light', 'dark', 'system'];
const PALETTES: readonly Palette[] = ['ink', 'grape'];
// Exported (unlike the sibling ladders) because the pinch gesture walks it:
// `pinchFontSize.ts` maps a zoom ratio onto positions in this order, so the
// ascending order is a contract, not just a validation list.
//
// The ladder grew upward rather than being re-spaced: it ran 14-19 and topped
// out at 1.19x the default, which is not much of a large-text mode, but every
// one of those rungs is in use — so the fix is more reach, not coarser steps.
// The top rung is set by a ratio rather than by taste: it has to reach at
// least 2x the default, the magnification WCAG 1.4.4 asks for and the only
// magnification an iOS home-screen app has. 34 was 2x exactly while the
// default was 17; against this 16px default it is 2.13x, which clears the
// target with room rather than missing it — and it stays, because a rung is
// only ever retired for a reason (see below).
// The steps widen only past 20px, where a reader has stopped nudging and wants
// the text bigger, and another 1px is a 5% change nobody can see. The rungs
// past 24px became practical once `--rm-header-h` stopped being a fixed 56px
// and started scaling with the root (`max(56px, 3.5rem)`), so the bar grows to
// fit its own contents rather than the type outgrowing it.
//
// Nothing is ever removed from this list without a reason: `getStoredFontSize`
// snaps a retired step to its neighbor, which is a change to a setting someone
// chose, and the rungs are cheap.
export const FONT_SIZES: readonly FontSize[] = [
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
  '22',
  '24',
  '26',
  '28',
  '30',
  '32',
  '34',
];
const FONTS: readonly FontFamily[] = [
  'roboto',
  'inter',
  'public-sans',
  'work-sans',
  'fira-sans',
  'system',
];

// 16px is the default, so it owns the bare `:root` block and needs no
// `data-font-size` attribute. Moving the default moves that block: 16 loses its
// attribute rung and 17 gains one, and `setStoredFontSize` clears the key on
// the default rather than writing it — so a reader sitting at 17 arrives at 16
// whether they chose 17 or never touched the setting. The two are not
// distinguishable by design, which is the cost of the default-owns-the-baseline
// pattern (shared with palette and font) and the reason moving a default is a
// product decision rather than a constant edit.
export const DEFAULT_FONT_SIZE: FontSize = '16';

// Roboto is the default typeface, so it owns the bare `:root` font token and
// needs no `data-font` attribute (same default-owns-root pattern as palette and
// text size).
const DEFAULT_FONT: FontFamily = 'roboto';

// Display names for the font picker.
export const FONT_LABELS: Record<FontFamily, string> = {
  roboto: 'Roboto',
  inter: 'Inter',
  'public-sans': 'Public Sans',
  'work-sans': 'Work Sans',
  'fira-sans': 'Fira Sans',
  system: 'System',
};

// The native fallback stack, appended after every webfont so a font that fails
// to load (or `system`) renders with the OS's own UI font. Kept in sync with
// `--rm-font-fallback` in global.css.
const SYSTEM_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, " +
  "sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji'";

// The full CSS font-family stack for each option. Mirrors the `[data-font]`
// blocks in global.css; exported so the Settings picker can render each chip's
// label in its own face (live preview) without duplicating the family names.
export const FONT_STACKS: Record<FontFamily, string> = {
  roboto: `'Roboto Variable', ${SYSTEM_STACK}`,
  inter: `'Inter Variable', ${SYSTEM_STACK}`,
  'public-sans': `'Public Sans Variable', ${SYSTEM_STACK}`,
  'work-sans': `'Work Sans Variable', ${SYSTEM_STACK}`,
  'fira-sans': `'Fira Sans', ${SYSTEM_STACK}`,
  system: SYSTEM_STACK,
};

// Display labels for the size pickers (Settings text buttons + the drawer's
// A-glyph row), and the accessible name of each radio.
//
// Raw px rather than the Extra Small/Medium/Huge scale these used to carry.
// English runs out of degrees of "large" well before the ladder does — it ran
// out at nine — and the relative names would have to be re-coined every time the
// ladder grows. A px label says something true, survives a ladder change, and
// leaves the small-to-large reading to the A glyph, which shows it better than a
// word can.
export const FONT_SIZE_LABELS: Record<FontSize, string> = {
  '14': '14px',
  '15': '15px',
  '16': '16px',
  '17': '17px',
  '18': '18px',
  '19': '19px',
  '20': '20px',
  '22': '22px',
  '24': '24px',
  '26': '26px',
  '28': '28px',
  '30': '30px',
  '32': '32px',
  '34': '34px',
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

function isFont(value: unknown): value is FontFamily {
  return (
    typeof value === 'string' && (FONTS as readonly string[]).includes(value)
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

/**
 * The nearest rung to a size that was on the ladder once and isn't now, or
 * `null` for a value that was never a size at all.
 *
 * The ladder is allowed to change shape, and this is what stops that costing
 * readers their setting: the plain `isFontSize` check would send everyone
 * stored on a retired step back to the default, which reads as the app losing
 * their preference rather than as the ladder moving. Ties round up (21 lands on
 * 22, not 20) — someone stored between two rungs was closer to asking for
 * bigger, so the ambiguous case should keep going that way. The old example
 * here was 17 landing on 18, which cannot happen: 17 is itself a rung, so
 * `isFontSize` catches it before this runs.
 */
function nearestFontSize(raw: string | null): FontSize | null {
  const px = Number(raw);
  if (!raw || !Number.isFinite(px)) return null;
  let best: FontSize | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const size of FONT_SIZES) {
    const distance = Math.abs(Number(size) - px);
    // `<=` rather than `<`, walking an ascending ladder, is what rounds a tie up.
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = size;
    }
  }
  return best;
}

export function getStoredFontSize(): FontSize {
  if (!hasWindow()) return DEFAULT_FONT_SIZE;
  try {
    const raw = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
    if (isFontSize(raw)) return raw;
    return nearestFontSize(raw) ?? DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

export function getStoredFont(): FontFamily {
  if (!hasWindow()) return DEFAULT_FONT;
  try {
    const raw = window.localStorage.getItem(FONT_STORAGE_KEY);
    return isFont(raw) ? raw : DEFAULT_FONT;
  } catch {
    return DEFAULT_FONT;
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

export function applyFont(font: FontFamily): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (font === DEFAULT_FONT) {
    root.removeAttribute('data-font');
  } else {
    root.setAttribute('data-font', font);
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

export function setStoredFont(font: FontFamily): void {
  if (hasWindow()) {
    try {
      if (font === DEFAULT_FONT) {
        window.localStorage.removeItem(FONT_STORAGE_KEY);
      } else {
        window.localStorage.setItem(FONT_STORAGE_KEY, font);
      }
    } catch {
      // quota or privacy-mode failures are non-fatal
    }
  }
  applyFont(font);
  window.dispatchEvent(
    new CustomEvent(THEME_CHANGE_EVENT, { detail: { font } }),
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
