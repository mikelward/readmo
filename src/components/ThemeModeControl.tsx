import { useTheme } from '../hooks/useTheme';
import type { Theme } from '../lib/theme';
import { TooltipButton } from './TooltipButton';
import './ThemeModeControl.css';

const MS_VIEWBOX = '0 -960 960 960';

function ThemeIcon({ path }: { path: string }) {
  return (
    <svg viewBox={MS_VIEWBOX} fill="currentColor" width="22" height="22" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  );
}

const LIGHT_PATH =
  'M480-360q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35Zm0 80q-83 0-141.5-58.5T280-480q0-83 58.5-141.5T480-680q83 0 141.5 58.5T680-480q0 83-58.5 141.5T480-280ZM200-440H40v-80h160v80Zm720 0H760v-80h160v80ZM440-760v-160h80v160h-80Zm0 720v-160h80v160h-80ZM256-650l-101-97 57-59 96 100-52 56Zm492 496-97-101 53-55 101 97-57 59Zm-98-550 97-101 59 57-100 96-56-52ZM154-212l101-97 55 53-97 101-59-57Zm326-268Z';
const DARK_PATH =
  'M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q14 0 27.5 1t26.5 3q-41 29-65.5 75.5T444-660q0 90 63 153t153 63q55 0 101-24.5t75-65.5q2 13 3 26.5t1 27.5q0 150-105 255T480-120Z';
const SYSTEM_PATH =
  'M80-120v-80h240v-80H160q-33 0-56.5-23.5T80-360v-400q0-33 23.5-56.5T160-840h640q33 0 56.5 23.5T880-760v400q0 33-23.5 56.5T800-280H640v80h240v80H80Zm80-240h640v-400H160v400Zm0 0v-400 400Z';

const THEME_OPTIONS: Array<{ value: Theme; label: string; path: string }> = [
  { value: 'light', label: 'Light', path: LIGHT_PATH },
  { value: 'dark', label: 'Dark', path: DARK_PATH },
  { value: 'system', label: 'System', path: SYSTEM_PATH },
];

/** Light / Dark / System mode picker as a segmented row of icon buttons.
 * Shared by the Settings page and the navigation drawer so the control reads
 * identically wherever it appears. `onClick` stops propagation so using it
 * inside the drawer (whose panel closes on click) doesn't dismiss the drawer. */
export function ThemeModeControl({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  return (
    <div
      className={'theme-mode' + (className ? ` ${className}` : '')}
      role="radiogroup"
      aria-label="Dark/Light mode"
    >
      {THEME_OPTIONS.map((opt) => (
        <TooltipButton
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={theme === opt.value}
          tooltip={opt.label}
          aria-label={opt.label}
          className="theme-mode__btn"
          data-active={theme === opt.value || undefined}
          onClick={(e) => {
            e.stopPropagation();
            setTheme(opt.value);
          }}
        >
          <ThemeIcon path={opt.path} />
        </TooltipButton>
      ))}
    </div>
  );
}
