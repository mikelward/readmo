// Readmo-hosted link for an article — the URL the reader's Share action hands
// out so the recipient opens the article INSIDE Readmo (the /item/:id reader),
// not the publisher's page. A signed-in recipient lands in the reader; a
// recipient who can't see the item under RLS still resolves it when its feed is
// public, via the get_shared_item capability read (0068). SPEC.md "Sharing an
// article". The publisher's own URL is shared separately via "Share original".

/** Build the hosted reader URL for an item id. `origin` defaults to the current
 * document origin; passing it keeps the builder pure/testable. */
export function readmoItemUrl(id: string, origin?: string): string {
  const base =
    origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/item/${encodeURIComponent(id)}`;
}
