import type { ItemId } from './types';

// In-memory scroll-jump diagnostics recorder. When the /debug "scroll-jump
// diagnostics" switch is on, useScrollDiag feeds this a timeline of window
// scroll positions and Done flips, so a jump-to-top after a dismiss can be
// inspected on a device with no console (tap "Report bug" on the Done toast →
// /debug/scroll). Module-level so the timeline survives the navigation from the
// feed to the diagnostics page (the recording component unmounts, the buffer
// doesn't). Purely diagnostic — never read on any user-facing path.

export type DiagKind = 'scroll' | 'done' | 'resize' | 'probe';

export interface DiagEntry {
  /** ms since the first recorded entry — a relative clock so the buffer reads
   * as a timeline rather than wall-clock noise. */
  t: number;
  kind: DiagKind;
  /** window.scrollY when the entry was recorded. */
  y: number;
  /** 'scroll': y minus the previous scroll's y (negative = toward the top, the
   * jump we're hunting). 'resize': the change in `max` since the last resize
   * entry (negative = the document got shorter — the collapse that sets up a
   * clamp). */
  delta?: number;
  /** 'done' only: the dismissed item's id. */
  id?: ItemId;
  /** 'done' only: the dismissed item's headline, captured from the still-present
   * row so the timeline reads as titles rather than opaque UUIDs. Absent when
   * the row isn't in this view's DOM (e.g. dismissed from the reader). */
  title?: string;
  /** Max scrollable offset (`scrollHeight − innerHeight`) at record time. When a
   * jump's `y` lands on `max`, the document became too short and the browser
   * CLAMPED the scroll (height-lock failure); when `max` still exceeds the prior
   * `y`, the scroll moved with room to spare — an anchoring rewind. */
  max?: number;
  /** 'scroll' only: whether the list body's scroll-anchor/height lock was active
   * (`.item-list__body` opted out of anchoring or holding a min-height) when the
   * event fired. `false` at the jump ⇒ the single-dismiss guard wasn't in force.
   * Read on scroll (not done) events, which fire after the synchronous mutation
   * handlers have run, so the lock state is settled. */
  locked?: boolean;
  /** Layout breakdown, recorded on 'done'/'resize'/'probe'. `bodyH` is the list
   * body's own height (`.item-list__body` offsetHeight); `docH` is the whole
   * document (`documentElement.scrollHeight`). Comparing them localizes a
   * collapse: if `docH` drops but `bodyH` holds, the lost height is in the chrome
   * around the list; if `bodyH` drops too, it's inside the row list. */
  bodyH?: number;
  docH?: number;
  /** Rendered row count (`[data-item-id]`) at record time. A momentary collapse
   * with an unchanged `rows` proves no rows actually left — it's a reflow dip,
   * not real removal. */
  rows?: number;
  /** `window.innerHeight` at record time. Recorded on every entry — including
   * 'scroll' — because the transient dynamic-toolbar viewport SPIKE that clamps
   * the scroll (maxScroll = scrollHeight − innerHeight) reverts within a frame or
   * two, so it's usually gone by the next done/resize/probe: only the scroll
   * event fired by the clamp itself captures it. Without it a viewport clamp
   * reads as an unexplained jump (and a stable-looking `vh` across the sparser
   * markers hides it). */
  vh?: number;
}

/** Ring-buffer cap — a few seconds of scrolling plus the surrounding Done
 * markers, bounded so a long session can't grow it without limit. */
const CAP = 200;

let buffer: DiagEntry[] = [];
let startedAt: number | null = null;
// The buffer frozen at "Report bug" time, so scroll noise from navigating to
// the diagnostics page doesn't pollute what the page shows.
let frozen: DiagEntry[] | null = null;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Append an entry, stamping it with the elapsed time since the first record. */
export function recordDiag(entry: Omit<DiagEntry, 't'>): void {
  const at = nowMs();
  if (startedAt === null) startedAt = at;
  buffer.push({ ...entry, t: Math.round(at - startedAt) });
  if (buffer.length > CAP) buffer.splice(0, buffer.length - CAP);
}

/** A copy of the live rolling buffer. */
export function getDiagBuffer(): DiagEntry[] {
  return buffer.slice();
}

/** Freeze the current buffer as the report the diagnostics page renders, so a
 * later scroll (including the navigation there) can't overwrite it. Returns the
 * snapshot. */
export function freezeDiagReport(): DiagEntry[] {
  frozen = buffer.slice();
  return frozen;
}

/** The last frozen report, or null if none has been captured. */
export function getDiagReport(): DiagEntry[] | null {
  return frozen ? frozen.slice() : null;
}

/** Reset the buffer, the relative clock, and any frozen report. */
export function clearDiag(): void {
  buffer = [];
  startedAt = null;
  frozen = null;
}

export interface DiagSummary {
  entries: number;
  /** The single biggest toward-top jump (most negative scroll delta), or null
   * when nothing scrolled upward. */
  biggestJump: DiagEntry | null;
  /** The most recent Done flip, or null. */
  lastDone: DiagEntry | null;
  /** ms from `lastDone` to `biggestJump` when the jump landed after the dismiss
   * — the "it jumped N ms after Done" signal. null when the jump preceded the
   * last Done (or either is missing). */
  jumpAfterDoneMs: number | null;
}

/** Reduce a timeline to the headline signals: how far the view jumped toward
 * the top and whether that jump followed a dismiss. Pure so the diagnostics
 * page and its tests share one derivation. */
export function summarizeDiag(entries: DiagEntry[]): DiagSummary {
  let biggestJump: DiagEntry | null = null;
  let lastDone: DiagEntry | null = null;
  for (const e of entries) {
    if (e.kind === 'done') lastDone = e;
    if (e.kind === 'scroll' && e.delta != null && e.delta < 0) {
      if (!biggestJump || e.delta < (biggestJump.delta ?? 0)) biggestJump = e;
    }
  }
  // Time the jump against the Done that most recently PRECEDES it, not the last
  // Done in the whole buffer — otherwise a second dismiss between the jump and
  // the reader tapping "Report bug" (Done A → jump → Done B) would overwrite the
  // reference and wrongly report "no Done before it", losing the key signal.
  let doneBeforeJump: DiagEntry | null = null;
  if (biggestJump) {
    for (const e of entries) {
      if (e.kind === 'done' && e.t <= biggestJump.t) doneBeforeJump = e;
    }
  }
  const jumpAfterDoneMs =
    biggestJump && doneBeforeJump ? biggestJump.t - doneBeforeJump.t : null;
  return { entries: entries.length, biggestJump, lastDone, jumpAfterDoneMs };
}

/** One timeline row as text: `Done <id>` for a dismiss, else the scroll offset
 * and its signed delta. Shared by the page's rendered rows and the copyable
 * report. */
export function formatDiagEntry(e: DiagEntry): string {
  const max = e.max != null ? ` max=${e.max}` : '';
  const sign = (e.delta ?? 0) > 0 ? '+' : '';
  const lock = e.locked != null ? ` lock=${e.locked ? 'on' : 'off'}` : '';
  // Layout breakdown suffix (present on done/resize/probe once captured): body
  // height vs. whole document localizes a collapse; `rows` shows no rows left
  // mid-dip; `vh` catches a viewport change.
  const layout = [
    e.bodyH != null ? `body=${e.bodyH}` : null,
    e.docH != null ? `doc=${e.docH}` : null,
    e.rows != null ? `rows=${e.rows}` : null,
    e.vh != null ? `vh=${e.vh}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const layoutSuffix = layout ? ` ${layout}` : '';
  if (e.kind === 'done') {
    const id = `Done ${e.id ?? ''}`.trim();
    return `${e.title ? `${id} — ${e.title}` : id}${max}${layoutSuffix}`;
  }
  if (e.kind === 'resize') {
    // The document height changed with no scroll — `y` is where the reader still
    // sits, `max` the new ceiling, `delta` how far it moved.
    return `resize y=${e.y} (${sign}${e.delta ?? 0})${max}${layoutSuffix}${lock}`;
  }
  if (e.kind === 'probe') {
    // A post-Done animation-frame sample: where the reader sits plus the layout
    // breakdown, so the momentary collapse's shape and composition are visible.
    return `probe y=${e.y}${max}${layoutSuffix}${lock}`;
  }
  // `vh` sits next to `max` (they're related: max = doc − vh), so a maxScroll
  // that dropped because the viewport SPIKED — not because the document shrank —
  // is visible right at the jump. Only on the scroll line; done/resize/probe
  // carry vh in their layout suffix above.
  const vh = e.vh != null ? ` vh=${e.vh}` : '';
  return `scroll y=${e.y} (${sign}${e.delta ?? 0})${max}${vh}${lock}`;
}

/** The one-line headline: how far the view jumped toward the top and whether
 * that jump followed a dismiss. Shared by the page and {@link formatDiagReport}
 * so the rendered summary and the copied text never drift. */
export function diagHeadline(summary: DiagSummary): string {
  if (summary.entries === 0) return 'No timeline recorded yet.';
  if (summary.jumpAfterDoneMs != null && summary.biggestJump) {
    return `Jumped ${summary.biggestJump.delta}px toward the top ${summary.jumpAfterDoneMs}ms after Done.`;
  }
  if (summary.biggestJump) {
    return `Biggest jump ${summary.biggestJump.delta}px (no Done before it).`;
  }
  return 'No upward jump recorded.';
}

/** The whole report as plain text — headline then one tab-separated row per
 * event — for the page's "Copy timeline" button, so the reader can paste it
 * back without wrestling with mobile text selection. */
export function formatDiagReport(entries: DiagEntry[]): string {
  const headline = diagHeadline(summarizeDiag(entries));
  const rows = entries.map((e) => `${e.t}ms\t${formatDiagEntry(e)}`);
  return [headline, ...rows].join('\n');
}
