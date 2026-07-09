/** XML attribute-value escaping shared by the OPML export/import paths of both
 * data sources, so the mock and the Supabase source round-trip URLs (e.g. `&`
 * in a query string) identically. */

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A numeric character reference's code point, or the original text when the
 * code point is not a valid XML character (NUL, surrogates, out of range) —
 * better to keep the literal than to throw mid-import. */
function decodeNumericRef(match: string, codePoint: number): string {
  if (
    !Number.isFinite(codePoint) ||
    codePoint === 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return match;
  }
  return String.fromCodePoint(codePoint);
}

/** Decode the XML entities OPML attribute values are escaped with (inverse of
 * escapeXml), plus numeric character references (`&#38;` / `&#x26;`) — XML
 * allows those anywhere a named entity is allowed and some readers' OPML
 * exporters emit them; left undecoded they subscribe a literally wrong URL.
 * `&amp;` is decoded last so `&amp;lt;` → `&lt;`, not `<` — the same ordering
 * keeps an escaped ampersand's tail (`&amp;#38;`) from re-reading as a
 * reference. */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex: string) =>
      decodeNumericRef(m, parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (m, dec: string) => decodeNumericRef(m, parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}
