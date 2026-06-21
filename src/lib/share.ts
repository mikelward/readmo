export interface SharePayload {
  title: string;
  text: string;
  url: string;
}

/** The minimal item shape needed to build a share payload — just enough
 * to title and link the share without coupling to the full `Item`. */
export interface ShareableItem {
  title?: string | null;
  /** The original article URL. */
  url?: string | null;
}

export function buildSharePayload(item: ShareableItem): SharePayload {
  const title = item.title?.trim() || 'Readmo article';
  // Unlike newshacker (which shared its own on-site /item/:id thread for
  // the OG preview and to route to the discussion), Readmo shares the
  // ORIGINAL article URL: there is no on-site discussion page to prefer,
  // and publishers want canonical-page traffic (SPEC.md *Reader view →
  // Share*).
  const url = item.url?.trim() ?? '';
  return { title, text: title, url };
}

export interface ShareDeps {
  share?: (data: SharePayload) => Promise<void>;
  copy?: (text: string) => Promise<void>;
}

export type ShareResult = 'shared' | 'copied' | 'unavailable' | 'cancelled';

export async function shareOrCopy(
  payload: SharePayload,
  deps: ShareDeps,
): Promise<ShareResult> {
  if (deps.share) {
    try {
      await deps.share(payload);
      return 'shared';
    } catch (err) {
      // AbortError = user dismissed the share sheet; treat as cancelled.
      if (err instanceof Error && err.name === 'AbortError') {
        return 'cancelled';
      }
      // Fall through to clipboard fallback.
    }
  }
  if (deps.copy) {
    try {
      await deps.copy(payload.url);
      return 'copied';
    } catch {
      return 'unavailable';
    }
  }
  return 'unavailable';
}
