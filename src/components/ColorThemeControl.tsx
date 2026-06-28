import type { CSSProperties } from 'react';
import { useTheme } from '../hooks/useTheme';
import {
  PALETTE_LABELS,
  PALETTE_SWATCHES,
  type Palette,
} from '../lib/theme';
import { TooltipButton } from './TooltipButton';
import './ColorThemeControl.css';

const PALETTE_OPTIONS: Array<{ value: Palette; label: string }> = (
  Object.keys(PALETTE_LABELS) as Palette[]
).map((value) => ({ value, label: PALETTE_LABELS[value] }));

/** A two-tone disc previewing a palette: paper background + accent, split on
 * the diagonal. Colors come from PALETTE_SWATCHES so the swatch shows each
 * palette's identity regardless of which one is currently applied. */
function PaletteSwatch({ palette }: { palette: Palette }) {
  const { bg, accent } = PALETTE_SWATCHES[palette];
  return (
    <span
      className="color-theme__swatch"
      style={
        { '--rm-swatch-bg': bg, '--rm-swatch-accent': accent } as CSSProperties
      }
      aria-hidden="true"
    />
  );
}

/** Color-theme (palette) picker as a segmented row of two-tone swatches.
 * Currently shown only on the Settings page, but kept as its own component so it
 * matches the Dark/Light mode and Text size controls. `onClick` stops
 * propagation to stay drawer-safe if it's ever placed there. */
export function ColorThemeControl({ className }: { className?: string }) {
  const { palette, setPalette } = useTheme();
  return (
    <div
      className={'color-theme' + (className ? ` ${className}` : '')}
      role="radiogroup"
      aria-label="Color theme"
    >
      {PALETTE_OPTIONS.map((opt) => (
        <TooltipButton
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={palette === opt.value}
          tooltip={opt.label}
          aria-label={opt.label}
          className="color-theme__btn"
          data-active={palette === opt.value || undefined}
          onClick={(e) => {
            e.stopPropagation();
            setPalette(opt.value);
          }}
        >
          <PaletteSwatch palette={opt.value} />
        </TooltipButton>
      ))}
    </div>
  );
}
