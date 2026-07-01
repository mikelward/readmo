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

/** Decode the XML entities OPML attribute values are escaped with (inverse of
 * escapeXml). `&amp;` is decoded last so `&amp;lt;` → `&lt;`, not `<`. */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
