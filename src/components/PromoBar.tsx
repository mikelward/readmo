import type { ReactNode } from 'react';
import { usePromoDismissed } from '../hooks/usePromoDismissed';
import { TooltipButton } from './TooltipButton';
import { Close, PushPinOutline } from './icons';
import './PromoBar.css';

interface Props {
  /** Stable id used to remember the dismissal per device. */
  id: string;
  /** Bar copy (US English). */
  children: ReactNode;
}

/** A dismissable one-line promo / onboarding hint shown above a list. Renders
 * nothing once dismissed on this device (see {@link usePromoDismissed}). The
 * dismiss control is a single 44×44 tap target, keeping within the tap-target
 * guardrails. */
export function PromoBar({ id, children }: Props) {
  const { dismissed, dismiss } = usePromoDismissed(id);
  if (dismissed) return null;

  return (
    <div className="promo-bar" role="note">
      <PushPinOutline className="promo-bar__icon" />
      <p className="promo-bar__text">{children}</p>
      <TooltipButton
        type="button"
        className="promo-bar__dismiss"
        onClick={dismiss}
        tooltip="Dismiss"
        aria-label="Dismiss"
      >
        <Close />
      </TooltipButton>
    </div>
  );
}
