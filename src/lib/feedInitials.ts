// Initials for a feed's fallback icon.
//
// When a feed's stored favicon fails to load — most often the guessed
// `<origin>/favicon.ico` for a publisher that serves none there (ft.com,
// economist.com), whose real icon is only on a bot-blocked homepage the poller
// can't reach — `FeedFavicon` draws a deterministic initial-on-color badge
// instead of leaving the row blank. Same idea as the account `UserAvatar` disc:
// offline, zero requests, no third-party favicon service. The badge color comes
// from `avatarColorForString` (shared palette, white-text contrast).

/**
 * Up to two uppercase initials for a feed name, or '' when none can be derived
 * (the caller then keeps its blank placeholder). Drops a leading article so
 * "The Economist" → "E" and "The Old New Thing" → "ON"; takes the first
 * alphanumeric of the first two remaining words ("Financial Times" → "FT"), or
 * just the first for a single-word name ("Reddit" → "R").
 */
export function feedInitials(name: string | null | undefined): string {
  if (!name) return '';
  const cleaned = name.trim().replace(/^the\s+/i, '');
  const letters: string[] = [];
  for (const word of cleaned.split(/\s+/)) {
    const m = word.match(/[a-z0-9]/i);
    if (!m) continue;
    letters.push(m[0].toUpperCase());
    if (letters.length === 2) break;
  }
  return letters.join('');
}
