import { useSyncExternalStore } from 'react';
import { useDataSource } from '../lib/data/context';
import { useFeedBar } from './FeedBarContext';
import { TooltipButton } from './TooltipButton';
import './ListToolbar.css';

const MS_VIEWBOX = '0 -960 960 960';

function UndoIcon() {
  return (
    <svg viewBox={MS_VIEWBOX} width="24" height="24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M280-200v-80h284q63 0 109.5-40T720-420q0-60-46.5-100T564-560H312l104 104-56 56-200-200 200-200 56 56-104 104h252q97 0 166.5 63T800-420q0 94-69.5 157T564-200H280Z"
      />
    </svg>
  );
}

function SweepIcon() {
  return (
    <svg viewBox={MS_VIEWBOX} width="24" height="24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M400-240v-80h240v80H400Zm-158 0L15-467l57-57 170 170 366-366 57 57-423 423Zm318-160v-80h240v80H560Zm160-160v-80h240v80H720Z"
      />
    </svg>
  );
}

/** Sticky list toolbar: right-aligned Undo + Sweep (Hide unpinned). The RSS
 * analog of newshacker's Undo + Sweep (SPEC.md *List toolbar*). */
export function ListToolbar() {
  const ds = useDataSource();
  const store = ds.stateStore;
  const { sweep, sweepCount } = useFeedBar();

  const canUndo = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.canUndo(),
    () => store.canUndo(),
  );

  const canSweep = !!sweep && sweepCount > 0;

  return (
    <section className="list-toolbar" aria-label="List actions">
      <div className="list-toolbar__row" role="toolbar">
        <div className="list-toolbar__right">
          <TooltipButton
            type="button"
            className="list-toolbar__button"
            data-testid="undo-btn"
            onClick={canUndo ? () => store.undoLast() : undefined}
            disabled={!canUndo}
            tooltip={canUndo ? 'Undo hide' : 'Nothing to undo'}
            aria-label={canUndo ? 'Undo hide' : 'Nothing to undo'}
          >
            <UndoIcon />
          </TooltipButton>
          <TooltipButton
            type="button"
            className="list-toolbar__button"
            data-testid="sweep-btn"
            onClick={canSweep ? sweep : undefined}
            disabled={!canSweep}
            tooltip={canSweep ? 'Hide unpinned' : 'Nothing to hide'}
            aria-label={canSweep ? 'Hide unpinned' : 'Nothing to hide'}
          >
            <SweepIcon />
          </TooltipButton>
        </div>
      </div>
    </section>
  );
}
