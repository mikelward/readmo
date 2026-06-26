// Heuristic "does this URL look like it embeds a secret token?" check —
// CLIENT copy of supabase/functions/_shared/urlSafety.ts (Deno). Keep the two in
// sync; the Deno copy is the canonical one and carries the full rationale.
//
// Per-item ARTICLE URLs can carry a subscriber token in the path or query (a
// feed URL pasted directly by the user lands in feeds.url with secret_url null,
// so even a "public" column can hold a secret — guardrail #6/#7). Before
// forwarding such a URL to a third party (here: HN's Algolia index for the
// reader's comments lookup, mirroring the full-text path's Jina gate) we screen
// it and SKIP anything that looks tokenized. Conservative by design: when in
// doubt, return true (skip). A heuristic, not a proof.

/** True if the URL should NOT be forwarded to a third party because it may
 * carry a secret. */
export function looksTokenized(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true; // unparseable → fail closed
  }
  // Credentials or any query string: never forward (?token=…, ?auth=…, etc.).
  if (u.username || u.password) return true;
  if (u.search !== '') return true;

  for (const rawSeg of u.pathname.split('/')) {
    let seg = rawSeg;
    try {
      seg = decodeURIComponent(rawSeg);
    } catch {
      /* keep the raw segment */
    }
    if (!seg) continue;
    if (segmentLooksTokenized(seg)) return true;
  }
  return false;
}

/** Long hex run (md5/sha-style) — 20+ hex chars with no break. */
function isHexBlob(s: string): boolean {
  return s.length >= 20 && /^[0-9a-f]+$/i.test(s);
}

function segmentLooksTokenized(seg: string): boolean {
  // Short segments can't hold a meaningful secret.
  if (seg.length < 20) return false;
  // Absurdly long single segment → suspicious regardless of composition.
  if (seg.length >= 80) return true;

  // Hyphen/underscore-delimited and all-lowercase-ish: a readable slug or a
  // hyphenated UUID. Let it through, UNLESS one of its parts is itself a long
  // hex blob (e.g. /a/<32-hex>-thumb).
  if (/^[a-z0-9]+([-_][a-z0-9]+)+$/.test(seg)) {
    return seg.split(/[-_]/).some(isHexBlob);
  }

  // A single long hex run (no separators).
  if (isHexBlob(seg)) return true;

  // base64url / random-token charset, no readable word breaks: flag a long run
  // that mixes case, or mixes letters and digits — the signature of an
  // encoded/random token rather than a word.
  if (/^[A-Za-z0-9_-]+$/.test(seg) && seg.length >= 24) {
    const hasLower = /[a-z]/.test(seg);
    const hasUpper = /[A-Z]/.test(seg);
    const hasDigit = /[0-9]/.test(seg);
    if ((hasLower && hasUpper) || ((hasLower || hasUpper) && hasDigit)) {
      return true;
    }
  }

  return false;
}
