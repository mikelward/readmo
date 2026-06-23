// Heuristic "does this URL look like it embeds a secret token?" check.
//
// The full-text function may fall back to a third-party reader (r.jina.ai) when
// a publisher 403s a direct fetch. Full-text runs on per-item ARTICLE URLs,
// which — unlike discovery's public site URL — could carry a subscriber token in
// the path or query. We have no reliable "this feed is public" signal, so before
// forwarding a URL to the third party we screen it here and SKIP anything that
// looks tokenized. Conservative by design: when in doubt, return true (skip).
//
// This is a heuristic, not a proof (see PR #56 discussion). It aims to let
// ordinary article URLs through — readable slugs, date paths, numeric ids, and
// hyphen-delimited UUIDs — while catching raw high-entropy tokens (long hex
// blobs, JWT/base64url strings) and any query string.

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
