import { isSafeHttpUrl } from './itemMeta';

// Read-later "save" links. Each supported service exposes a public
// "save this page" URL — a plain deep link that opens the service's own
// save/confirmation page in a new tab (prompting login if the reader isn't
// signed in). No API call, no stored credentials, no cost: this is the same
// deep-link shape as "Open on newshacker" and the Google News fallback
// (CLAUDE.md *External services* — none added). Pocket is deliberately absent:
// Mozilla shut it down in July 2025.

export type ReadLaterService = 'instapaper' | 'raindrop' | 'readwise';

export interface ReadLaterTarget {
  service: ReadLaterService;
  /** Menu label, e.g. "Save to Instapaper". */
  label: string;
  /** The save URL to open, or null when the article has no safe http(s) URL
   *  to save (the target is then omitted from the menu). */
  href: string | null;
}

interface ReadLaterServiceDef {
  service: ReadLaterService;
  label: string;
  build: (url: string, title: string) => string;
}

const SERVICES: readonly ReadLaterServiceDef[] = [
  {
    service: 'instapaper',
    label: 'Save to Instapaper',
    // Instapaper's publisher "Save to Instapaper" link: it shows a confirmation
    // page and offers login/signup when the reader isn't signed in. `title` is
    // optional but recommended.
    build: (url, title) =>
      `https://www.instapaper.com/hello2?url=${encodeURIComponent(url)}` +
      (title ? `&title=${encodeURIComponent(title)}` : ''),
  },
  {
    service: 'raindrop',
    label: 'Save to Raindrop',
    // Raindrop.io's "add bookmark" deep link: opens the app's save dialog
    // pre-filled with the article, prompting login if the reader isn't signed
    // in. `title` is optional but pre-fills the bookmark title.
    build: (url, title) =>
      `https://app.raindrop.io/add?link=${encodeURIComponent(url)}` +
      (title ? `&title=${encodeURIComponent(title)}` : ''),
  },
  {
    service: 'readwise',
    label: 'Save to Readwise Reader',
    // Readwise Reader's documented save-by-URL endpoint: saves the article to
    // the Reader inbox (login if needed). It doesn't take a title.
    build: (url) => `https://wise.readwise.io/save?url=${encodeURIComponent(url)}`,
  },
];

/** Build the read-later save targets for an article. Each target's `href` is
 *  null when the article URL isn't a safe http(s) URL — callers omit those (a
 *  non-http item, e.g. a `mailto:`/relative URL, has nothing to save). `title`
 *  is the article's real headline (used only by services that accept a title
 *  param, e.g. Instapaper); the read-later app shows the article's own content,
 *  so the list-only spoiler-free rewrite isn't relevant here. */
export function readLaterTargets(
  articleUrl: string | null | undefined,
  title?: string | null,
): ReadLaterTarget[] {
  const safe = isSafeHttpUrl(articleUrl) ? articleUrl : null;
  const cleanTitle = title?.trim() ?? '';
  return SERVICES.map((s) => ({
    service: s.service,
    label: s.label,
    href: safe ? s.build(safe, cleanTitle) : null,
  }));
}
