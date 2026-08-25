// Display ordering for an item's publisher-supplied categories/tags.

/** Categories so generic they say nothing about the article, folded for
 * comparison. A publisher that tags every article "News" (The Verge does)
 * would otherwise spend the row's one category slot on a label shared by its
 * whole feed, hiding the tag that actually distinguishes the story
 * ("Ride-sharing", "Transportation"). */
const GENERIC_CATEGORIES = new Set(["news"]);

/** The publisher's categories in display order: their own order, except that
 * generic ones (see {@link GENERIC_CATEGORIES}) sink to the end. Stable — the
 * relative order within each group is the publisher's — so a feed whose tags
 * carry no generic entry is returned unchanged. Display-only: the stored
 * array and everything matching against it (filters) keep the publisher's
 * order. */
export function orderCategories(
  categories: readonly string[] | undefined,
): string[] {
  // Optional/loose input: a persisted query-cache entry written by a build
  // predating `Item.categories` has none at all (see ItemRow.tsx's meta tail).
  if (!categories || categories.length === 0) return [];
  const specific: string[] = [];
  const generic: string[] = [];
  for (const category of categories) {
    if (GENERIC_CATEGORIES.has(category.trim().toLowerCase()))
      generic.push(category);
    else specific.push(category);
  }
  return generic.length === 0 ? [...categories] : [...specific, ...generic];
}
