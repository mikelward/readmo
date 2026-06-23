// Combined bottom of the chrome that's sticky-pinned to the top of
// the viewport: the <AppHeader> (always present) and the
// <ListToolbar> (present on every list view; see SPEC.md § List
// toolbar / Sticky pinned just below the header).
//
// `StoryList`'s sweep IntersectionObserver shrinks the root's top by
// this value so that a row visually hidden behind either sticky
// strip is not counted as "fully visible". When both elements are
// stuck at the top, the toolbar's bottom is what matters — it's
// lower in the viewport than the header. When the toolbar is still
// in normal flow near scroll=0, its natural bottom is also the right
// inset, because no story row sits above it anyway. Taking the
// max of the bottoms is correct in both states; a header-only inset
// caused Sweep to swallow rows hidden behind the toolbar after the
// toolbar became sticky (Codex on PR #299).
export function measureStickyInset(): number {
  if (typeof document === 'undefined') return 0;
  let bottom = 0;
  for (const selector of ['.app-header', '.list-toolbar']) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > bottom) bottom = rect.bottom;
  }
  return Math.max(0, Math.ceil(bottom));
}

// How far the sticky *bottom* list toolbar (`.list-toolbar--bottom`, pinned at
// `bottom: 0` — see ListToolbar.css) intrudes up from the bottom of the
// viewport. Unlike newshacker — whose feed footer is `position: relative` and
// never overlaps rows — readmo pins the bottom toolbar to the viewport foot, so
// a row tucked behind it is *not* fully visible. The sweep IntersectionObserver
// shrinks its root's bottom edge by this value so such a row isn't swept.
//
// When the toolbar is pinned, its top sits at `viewportHeight - height`, so the
// intrusion is its height. When it's still in normal flow below the fold its
// top is past the viewport bottom, yielding a negative intrusion that clamps to
// 0 — nothing to exclude. (Codex P2 on PR #44.)
export function measureStickyBottomInset(): number {
  if (typeof document === 'undefined' || typeof window === 'undefined') return 0;
  const el = document.querySelector('.list-toolbar--bottom');
  if (!el) return 0;
  const rect = el.getBoundingClientRect();
  return Math.max(0, Math.ceil(window.innerHeight - rect.top));
}
