import { useCallback, useEffect, useState } from 'react';
import {
  THEME_CHANGE_EVENT,
  type Palette,
  type Theme,
  applyPalette,
  applyTheme,
  applyThemeColorMeta,
  getStoredPalette,
  getStoredTheme,
  resolveTheme,
  setStoredPalette,
  setStoredTheme,
} from '../lib/theme';

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme());
  const [palette, setPaletteState] = useState<Palette>(() => getStoredPalette());
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    resolveTheme(getStoredTheme()),
  );

  useEffect(() => {
    const sync = () => {
      const next = getStoredTheme();
      const nextPalette = getStoredPalette();
      setThemeState(next);
      setPaletteState(nextPalette);
      setResolved(resolveTheme(next));
      // Repaint, not just re-render: the page is styled off the
      // `data-theme`/`data-palette` attributes on <html>, which only the tab
      // that called setStoredTheme/Palette has applied. A cross-tab `storage`
      // event must apply them here too or this tab's picker flips while the
      // page colors stay stale. (Idempotent for the same-tab
      // THEME_CHANGE_EVENT case.)
      applyTheme(next);
      applyPalette(nextPalette);
    };
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  useEffect(() => {
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const next = resolveTheme('system');
      setResolved(next);
      // Keep the browser chrome tint in sync when the OS flips under a
      // `system` selection — `applyTheme` only runs on explicit user
      // changes, so without this the meta would lag the CSS by a
      // whole page reload.
      applyThemeColorMeta(next);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setStoredTheme(t), []);
  const setPalette = useCallback((p: Palette) => setStoredPalette(p), []);

  return { theme, palette, resolved, setTheme, setPalette };
}
