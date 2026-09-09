/** Given the current row order, compute the would-be order while dragging
 * `draggingId`: drop it back among the other rows at the slot whose vertical
 * midpoint the pointer (`clientY`) has crossed. Rows with no measured rect are
 * skipped. Pure so the drag math is unit-testable without real layout. */
export function orderForPointer<T>(
  order: readonly T[],
  draggingId: T,
  clientY: number,
  rects: Map<T, { top: number; height: number }>,
): T[] {
  const others = order.filter((id) => id !== draggingId);
  let insert = others.length;
  for (let i = 0; i < others.length; i++) {
    const r = rects.get(others[i]);
    if (!r) continue;
    if (clientY < r.top + r.height / 2) {
      insert = i;
      break;
    }
  }
  others.splice(insert, 0, draggingId);
  return others;
}

/** Return a new array with the element at `from` moved to index `to`. Indices
 * are clamped into range, so an out-of-bounds drag target lands at the nearest
 * end rather than dropping the element. Pure — the input array is not mutated.
 * Used by the drag-to-reorder subscription list. */
export function arrayMove<T>(items: readonly T[], from: number, to: number): T[] {
  const next = items.slice();
  if (next.length === 0) return next;
  const clamp = (n: number) => Math.max(0, Math.min(n, next.length - 1));
  const f = clamp(from);
  const t = clamp(to);
  if (f === t) return next;
  const [moved] = next.splice(f, 1);
  next.splice(t, 0, moved);
  return next;
}
