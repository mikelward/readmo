import { execSync } from 'node:child_process';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// `process.env.VITEST` is set when vitest boots; skip the PWA plugin in
// tests because it adds startup cost per worker and exercises no behavior
// the unit tests need.
const isTest = process.env.VITEST === 'true';

// Captured at config-load time so /settings (and a future /debug) can show
// "what commit is this bundle from?" without a runtime endpoint. Vercel
// checks out via git during the build, so `git log` works there; on a
// shallow checkout / no git we fall back to '' and the UI hides the row.
function readCommitTime(): string {
  try {
    return execSync('git log -1 --format=%cI', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

const TEST_BUILD_COMMIT_TIME = '2026-01-01T00:00:00.000Z';
const buildCommitTime = isTest ? TEST_BUILD_COMMIT_TIME : readCommitTime();

export default defineConfig({
  // Expose VITE_* (our own) and NEXT_PUBLIC_* (what the Supabase↔Vercel
  // integration provisions) to the client bundle. NEXT_PUBLIC_ is public by
  // convention, so this is safe; we deliberately do NOT add the `SUPABASE_`
  // prefix, which would leak SERVICE_ROLE/SECRET/JWT/POSTGRES_* secrets.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  define: {
    __BUILD_COMMIT_TIME__: JSON.stringify(buildCommitTime),
  },
  plugins: [
    react(),
    !isTest &&
      VitePWA({
        // autoUpdate silently activates a new service worker on the next
        // navigation (no prompt). A reader app has no in-progress state to
        // lose on refresh, so the simpler behavior wins (see SPEC.md
        // *PWA & Offline → Service worker*).
        registerType: 'autoUpdate',
        includeAssets: [
          'favicon.svg',
          'favicon-32.png',
          'apple-touch-icon.png',
        ],
        manifest: {
          name: 'readmo',
          short_name: 'readmo',
          description:
            'A mobile-friendly, installable reader for your RSS, Atom, and JSON feeds.',
          theme_color: '#faf9f5',
          background_color: '#faf9f5',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: '/icon-512-maskable.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          // Offline navigation to /pinned, /item/:id, etc. resolves to the
          // precached shell and React Router takes over.
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//],
          cleanupOutdatedCaches: true,
          runtimeCaching: [
            {
              // Data reads from Supabase REST/RPC — NetworkFirst so a healthy
              // network always wins, with a cache fallback offline (see
              // SPEC.md *PWA & Offline → Caching strategy*). The host is
              // swapped in for the real project ref when PR2 wires Supabase.
              urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/.*/,
              handler: 'NetworkFirst',
              options: {
                cacheName: 'readmo-data',
                networkTimeoutSeconds: 10,
                expiration: { maxEntries: 200, maxAgeSeconds: 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // Article images proxied through our same-origin /api/img
              // endpoint — StaleWhileRevalidate, capped. Doubles as the
              // offline-image source (SPEC.md *Privacy* / *Article images*).
              urlPattern: /\/api\/img(?:\?.*)?$/,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'readmo-images',
                expiration: { maxEntries: 300, maxAgeSeconds: 7 * 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // Favicons — CacheFirst, long TTL, capped.
              urlPattern: /\/api\/favicon(?:\?.*)?$/,
              handler: 'CacheFirst',
              options: {
                cacheName: 'readmo-favicons',
                expiration: {
                  maxEntries: 200,
                  maxAgeSeconds: 30 * 24 * 60 * 60,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: {
          // Don't generate a SW in `npm run dev` — it caches aggressively
          // and makes iteration painful. Exercised by build && preview.
          enabled: false,
        },
      }),
  ],
  test: {
    globals: true,
    // SPEC.md *Testing* calls for jsdom; the per-file `// @vitest-environment
    // node` docblock opts pure-logic tests under src/lib and the server
    // shared modules into the faster node environment.
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    unstubGlobals: true,
    // `*.deno.test.ts` are Deno-runtime integration tests (real TCP/TLS) run by
    // `deno test` in the `edge` CI job, not Vitest — exclude them here.
    exclude: [...configDefaults.exclude, '**/*.deno.test.ts'],
  },
});
