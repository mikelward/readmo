import { useTheme } from '../hooks/useTheme';
import { FONT_SIZE_LABELS, type FontSize } from '../lib/theme';
import { TooltipButton } from './TooltipButton';
import './TextSizeControl.css';

// Each option renders as a capital "A" whose glyph size hints the scale
// (small / medium / large), echoing the conventional font-size control. The
// accessible name still comes from the label.
const FONT_SIZE_OPTIONS: Array<{ value: FontSize; label: string; glyph: number }> = [
  { value: '15', label: FONT_SIZE_LABELS['15'], glyph: 14 },
  { value: '16', label: FONT_SIZE_LABELS['16'], glyph: 18 },
  { value: '17', label: FONT_SIZE_LABELS['17'], glyph: 22 },
  { value: '18', label: FONT_SIZE_LABELS['18'], glyph: 26 },
];

/** Text-size picker as a segmented row of capital-A glyphs. Shared by the
 * Settings page and the navigation drawer so the control reads identically
 * wherever it appears. `onClick` stops propagation so using it inside the drawer
 * (whose panel closes on click) doesn't dismiss the drawer. */
export function TextSizeControl({ className }: { className?: string }) {
  const { fontSize, setFontSize } = useTheme();
  return (
    <div
      className={'text-size' + (className ? ` ${className}` : '')}
      role="radiogroup"
      aria-label="Text size"
    >
      {FONT_SIZE_OPTIONS.map((opt) => (
        <TooltipButton
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={fontSize === opt.value}
          tooltip={opt.label}
          aria-label={opt.label}
          className="text-size__btn"
          data-active={fontSize === opt.value || undefined}
          onClick={(e) => {
            e.stopPropagation();
            setFontSize(opt.value);
          }}
        >
          <span
            className="text-size__glyph"
            style={{ fontSize: opt.glyph }}
            aria-hidden="true"
          >
            A
          </span>
        </TooltipButton>
      ))}
    </div>
  );
}
