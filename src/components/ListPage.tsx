import type { ReactNode } from 'react';
import { ListToolbar } from './ListToolbar';
import '../pages/PageHeader.css';
import './ItemList.css';

interface Props {
  /** Page-header content — a title (+ optional badge) or the search input.
   * Wrapped in `.page-header`; omit for no header. */
  header?: ReactNode;
  /** Whether the bottom toolbar renders the Undo + Sweep actions. Defaults to
   * false (Back to top only); feed views opt in. */
  actions?: boolean;
  children: ReactNode;
}

/** The shared shell for non-feed list views (library, search, offline): an
 * optional page header, the list body, and a bottom toolbar that is *always*
 * present so Back to top is never lost (SPEC.md *List toolbar*). Putting the
 * toolbar here makes it structural — a page can't forget it. */
export function ListPage({ header, actions = false, children }: Props) {
  return (
    <div>
      {header != null ? <div className="page-header">{header}</div> : null}
      {children}
      <ListToolbar placement="bottom" actions={actions} />
    </div>
  );
}
