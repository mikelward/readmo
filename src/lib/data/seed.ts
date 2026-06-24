import type { Feed, Item, Subscription } from '../types';

// Seed content for the mock data source so the full UX is exercisable with
// no network (SPEC.md PR1 plan). Bodies are small, already-sanitized HTML.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const SEED_FEEDS: Feed[] = [
  {
    id: 'feed-verge',
    url: 'https://www.theverge.com/rss/index.xml',
    siteUrl: 'https://www.theverge.com',
    title: 'The Verge',
    faviconUrl: null,
    errorCount: 0,
    lastError: null,
    parked: false,
  },
  {
    id: 'feed-nasa',
    url: 'https://www.nasa.gov/feed/',
    siteUrl: 'https://www.nasa.gov',
    title: 'NASA Breaking News',
    faviconUrl: null,
    errorCount: 0,
    lastError: null,
    parked: false,
  },
  {
    id: 'feed-css',
    url: 'https://css-tricks.com/feed/',
    siteUrl: 'https://css-tricks.com',
    title: 'CSS-Tricks',
    faviconUrl: null,
    errorCount: 0,
    lastError: null,
    parked: false,
  },
  {
    id: 'feed-reddit-prog',
    url: 'https://www.reddit.com/r/programming/.rss',
    siteUrl: 'https://www.reddit.com/r/programming',
    title: 'r/programming',
    faviconUrl: null,
    errorCount: 0,
    lastError: null,
    parked: false,
  },
  {
    id: 'feed-park',
    url: 'https://example.com/flaky/feed.xml',
    siteUrl: 'https://example.com',
    title: 'Occasionally Down Blog',
    faviconUrl: null,
    errorCount: 7,
    lastError: 'HTTP 503 after 7 attempts',
    parked: true,
  },
];

interface SeedSpec {
  feedId: string;
  title: string;
  author: string | null;
  agoHours: number;
  body: string;
}

const SPECS: SeedSpec[] = [
  {
    feedId: 'feed-verge',
    title: 'A foldable phone that actually folds flat, finally',
    author: 'Jane Doe',
    agoHours: 2,
    body: '<p>After years of visible creases, the latest hinge design promises a display that lies genuinely flat. We went hands-on.</p><p>The improvement is immediately obvious in direct light, where previous models showed a distracting valley down the middle.</p>',
  },
  {
    feedId: 'feed-nasa',
    title: 'Webb telescope captures a galaxy cluster bending light',
    author: null,
    agoHours: 5,
    body: '<p>The image reveals gravitational lensing on a dramatic scale, with background galaxies smeared into arcs.</p><figure><img src="https://www.nasa.gov/example.jpg" alt="Galaxy cluster" /><figcaption>A deep-field exposure.</figcaption></figure>',
  },
  {
    feedId: 'feed-css',
    title: 'Container queries are finally everywhere',
    author: 'Chris Coyier',
    agoHours: 9,
    body: '<p>With the last holdout browser shipping support, you can now lean on <code>@container</code> in production without a polyfill.</p><pre><code>.card { container-type: inline-size; }</code></pre>',
  },
  {
    feedId: 'feed-reddit-prog',
    title: 'Ask: what is your team’s policy on rewriting legacy services?',
    author: 'u/devthrowaway',
    agoHours: 11,
    body: '<p>We have a 12-year-old monolith. Half the team wants a rewrite, half wants to strangle-fig it. What has worked for you?</p>',
  },
  {
    feedId: 'feed-verge',
    title: 'The best laptops you can buy right now',
    author: 'Sam Smith',
    agoHours: 26,
    body: '<p>Our updated picks across budgets, with notes on battery life and keyboard feel.</p>',
  },
  {
    feedId: 'feed-css',
    title: 'A modern reset, revisited for 2026',
    author: 'Chris Coyier',
    agoHours: 30,
    body: '<p>Browser defaults have improved enough that a good reset is now shorter than ever. Here is what is still worth keeping.</p>',
  },
  {
    feedId: 'feed-nasa',
    title: 'Crew returns after a record stay aboard the station',
    author: null,
    agoHours: 50,
    body: '<p>The mission set a new duration record and ran more than two hundred experiments.</p>',
  },
  {
    feedId: 'feed-reddit-prog',
    title: 'Show: I built a tiny RSS reader PWA over the weekend',
    author: 'u/weekendhacker',
    agoHours: 73,
    body: '<p>Offline-first, syncs across devices, no tracking. Feedback welcome.</p>',
  },
  {
    feedId: 'feed-verge',
    title: 'Why your next monitor should be matte again',
    author: 'Jane Doe',
    agoHours: 100,
    body: '<p>Glossy panels lost the plot. New matte coatings preserve contrast while killing reflections.</p>',
  },
  {
    feedId: 'feed-css',
    title: 'Scroll-driven animations without JavaScript',
    author: 'Geri Coady',
    agoHours: 140,
    body: '<p>The new CSS scroll timelines let you tie keyframes to scroll position natively. A few practical recipes.</p>',
  },
];

export const SEED_ITEMS: Item[] = SPECS.map((spec, i) => ({
  id: `item-${i + 1}`,
  feedId: spec.feedId,
  guid: `guid-${i + 1}`,
  url: `https://example.com/article/${i + 1}`,
  title: spec.title,
  author: spec.author,
  publishedAt: Date.now() - spec.agoHours * HOUR,
  contentHtml: spec.body,
  summary: null,
  fullContentHtml: null,
  fullContentStale: false,
  enclosures: [],
}));

export const SEED_SUBSCRIPTIONS: Subscription[] = [
  { feedId: 'feed-verge', folder: 'News', titleOverride: null, muted: false, sort: 0 },
  { feedId: 'feed-nasa', folder: 'News', titleOverride: null, muted: false, sort: 1 },
  { feedId: 'feed-css', folder: 'Dev', titleOverride: null, muted: false, sort: 2 },
  { feedId: 'feed-reddit-prog', folder: 'Dev', titleOverride: null, muted: false, sort: 3 },
  { feedId: 'feed-park', folder: null, titleOverride: null, muted: false, sort: 4 },
];

export const SEED_FOLDERS = [
  { name: 'News', sort: 0 },
  { name: 'Dev', sort: 1 },
];

export { DAY, HOUR };
