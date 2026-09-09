import { escapeXml } from './xmlEntities';

/** One exported subscription, ready to serialize as an `<outline>`. */
export interface OpmlOutline {
  /** Display name (title override, else feed title, else a fallback). */
  title: string;
  /** The feed's fetch URL — what an importer subscribes to (`xmlUrl`). */
  xmlUrl: string;
  /** The publisher home page (`htmlUrl`), omitted from the outline when absent. */
  htmlUrl?: string | null;
}

/**
 * Serialize subscriptions to an OPML 2.0 document (the shared export format for
 * both data sources). Pass `dateCreated` to stamp the head with an RFC-822
 * export time — the OPML head's standard timestamp field, which importers and
 * humans use to see when the list was taken; omit it for deterministic output.
 */
export function buildOpml(outlines: OpmlOutline[], opts?: { dateCreated?: Date }): string {
  const body = outlines
    .map(
      (o) =>
        `    <outline type="rss" text="${escapeXml(o.title)}" title="${escapeXml(
          o.title,
        )}" xmlUrl="${escapeXml(o.xmlUrl)}"${
          o.htmlUrl ? ` htmlUrl="${escapeXml(o.htmlUrl)}"` : ''
        } />`,
    )
    .join('\n');
  // Date.prototype.toUTCString() is already RFC-822/1123 ("Sat, 12 Jul 2026
  // 14:30:00 GMT"), the format the OPML spec calls for.
  const dateLine = opts?.dateCreated
    ? `<dateCreated>${escapeXml(opts.dateCreated.toUTCString())}</dateCreated>`
    : '';
  const head = `  <head><title>Readmo subscriptions</title>${dateLine}</head>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n${head}\n  <body>\n${body}\n  </body>\n</opml>\n`;
}
