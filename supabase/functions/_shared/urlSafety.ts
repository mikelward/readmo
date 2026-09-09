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

/** Redact a URL down to scheme://host for safe logging. Strips userinfo, path,
 * query, and fragment — any of which can carry a subscriber token (a feed URL
 * pasted directly by the user lands in feeds.url with secret_url null, so the
 * "public" column can in fact contain a secret; SPEC.md / guardrail #6).
 * Returns '<unparseable-url>' if the URL won't parse — never the raw input. */
export function redactUrl(url: string | null | undefined): string {
  if (!url) return '<no-url>';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '<unparseable-url>';
  }
}

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

/** A short non-negative integer (≤4 digits) — the only query VALUE shape a
 * favicon URL is allowed to carry (`w=150`, `dpr=2`, `q=80`, `crop=1`). */
const SHORT_INT_VALUE = /^[0-9]{1,4}$/;

/** Image sizing/quality query KEYS a favicon may carry. Paired with the
 * integer-value rule, this is the leak guard: a `?subscriber_id=1234` or
 * `?token=1234` has an integer value but a non-image key, so it's rejected —
 * only a known image param with a numeric value passes. */
const BENIGN_IMAGE_QUERY_KEYS = new Set([
  'w', 'h', 'width', 'height', 'maxw', 'maxh', 'size',
  'dpr', 'dpi', 'scale', 'zoom', 'crop', 'q', 'quality', 'px',
  'blur', 'sharpen', 'brightness', 'contrast', 'rotate', 'rect', 'pad', 'trim',
  'v', 'ver', 'version', 'rev', 'cache', 'cachebust', 'cb',
]);

/**
 * Like {@link looksTokenized}, but a favicon's query string is allowed when
 * **every param is a known image key with a short-integer value** (image
 * sizing/quality params like `?w=150&h=150&crop=1`). Embedded credentials and
 * tokenized/matrix path segments are still rejected. For favicon URLs:
 * publishers' advertised icons routinely carry numeric resize params, which are
 * not secrets, and the favicon is loaded directly by the browser `<img>` rather
 * than forwarded to a third party. Anything else — a non-image key
 * (`subscriber_id`, `token`, …) or a non-integer value (token, base64,
 * timestamp, string param, embedded `key=value`) — is rejected, so no
 * secret/user-specific query is stored/exposed via `feeds_public`.
 */
export function looksTokenizedAllowingQuery(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true; // unparseable → fail closed
  }
  if (u.username || u.password) return true; // credentials are always a secret
  for (const rawSeg of u.pathname.split('/')) {
    let seg = rawSeg;
    try {
      seg = decodeURIComponent(rawSeg);
    } catch {
      /* keep the raw segment */
    }
    if (!seg) continue;
    // Matrix params (`/icon.png;jsessionid=abc`) embed a key=value pair in the
    // path — abnormal for a favicon and a credential-smuggling vector; reject.
    if (seg.includes(';')) return true;
    if (segmentLooksTokenized(seg)) return true;
  }
  // Favicon query: every param must be a known image key with an integer value.
  for (const [key, value] of u.searchParams) {
    if (!BENIGN_IMAGE_QUERY_KEYS.has(key.toLowerCase())) return true;
    if (!SHORT_INT_VALUE.test(value)) return true;
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
