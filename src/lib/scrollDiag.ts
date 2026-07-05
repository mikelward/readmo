import type { ItemId } from './types';

// In-memory scroll-jump diagnostics recorder. When the /debug "scroll-jump
// diagnostics" switch is on, useScrollDiag feeds this a timeline of window
// scroll positions and Done flips, so a jump-to-top after a dismiss can be
// inspected on a device with no console (tap "Report bug" on the Done toast →
// /debug/scroll). Module-level so the timeline survives the navigation from the
// feed to the diagnostics page (the recording component unmounts, the buffer
// doesn't). Purely diagnostic — never read on any user-facing path.

export type DiagKind = 'scroll' | 'done';

export interface DiagEntry {
  /** ms since the first recorded entry — a relative clock so the buffer reads
   * as a timeline rather than wall-clock noise. */
  t: number;
  kind: DiagKind;
  /** window.scrollY when the entry was recorded. */
  y: number;
  /** 'scroll' only: y minus the previous scroll's y. Negative = moved toward
   * the top (the jump we're hunting). */
  delta?: number;
  /** 'done' only: the dismissed item's id. */
  id?: ItemId;
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
