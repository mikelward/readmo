// Palette for the initial-on-color account disc shown when a user has no
// OAuth picture (deterministic, offline, zero requests — SPEC.md *Auth →
// Account UI*). These vivid hues sit apart from the muted brand-mark accents
// (charcoal ink / grape) so the disc reads as a peer of the logo
// rather than fighting it. Each color clears white-text contrast for the
// centered initial.
export const AVATAR_COLORS = [
  '#2563eb', // blue
  '#0d9488', // teal
  '#16a34a', // green
  '#7c3aed', // purple
  '#db2777', // pink
  '#0891b2', // cyan
  '#be185d', // rose
  '#475569', // slate
  '#b45309', // amber
] as const;

// Small deterministic hash — same input always picks the same color, and
// two different strings with matching first letters usually land on
// different colors.
export function avatarColorForString(value: string): string {
  if (!value) return AVATAR_COLORS[0];
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31 + value.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
