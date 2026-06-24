import { execSync } from 'node:child_process';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// `process.env.VITEST` is set when vitest boots; skip the PWA plugin in
// tests because it adds startup cost per worker and exercises no behavior
// the unit tests need.
const isTest = process.env.VITEST === 'true';

// Build metadata captured at config-load time so /debug (and /settings) can
// answer "what commit is this bundle from?" without a runtime endpoint. Vercel
// checks out via git during the build, so `git` works there, and it also sets
// the VERCEL_* env vars we prefer when present (more reliable than git on a
// shallow checkout). Anything we can't determine falls back to '' / 0 and the
// UI hides that row.
interface BuildInfo {
  /** 'production' | 'preview' | 'development' (Vercel) or 'local'. */
  environment: string;
  /** Short commit SHA, or '' when git metadata is unavailable. */
  shortSha: string;
  /** Branch ref the bundle was built from, or ''. */
  branch: string;
  /** Commits reachable from HEAD (≈ "commits on main" for production), or 0. */
  commitCount: number;
  /** ISO commit timestamp of the deployed bundle, or ''. */
  commitTime: string;
  /** First line of the deployed commit's message, or ''. */
  commitSubject: string;
  /** ISO timestamp of when this bundle was built. */
  buildTime: string;
}

function git(args: string): string {
  try {
    return execSync(`git ${args}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

// Run a git command and surface its output. Unlike `git()` above, this is for
// state-changing commands (fetch) where we want to see what happened in the
// build log — silent failures here are what produced the commitCount=0
// mystery this code is solving. Returns true on exit 0, false otherwise; the
// command's stdout/stderr is forwarded to the parent so it lands in build logs.
function gitRun(args: string, timeout = 60_000): boolean {
  console.log(`[vite.config] git ${args}`);
  try {
    execSync(`git ${args}`, { stdio: 'inherit', timeout });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[vite.config] git ${args} failed: ${msg}`);
    return false;
  }
}

function readBuildInfo(): BuildInfo {
  const env = process.env;
  const environment =
    env.VERCEL_ENV || (env.NODE_ENV === 'production' ? 'production' : 'local');
  const shortSha = (env.VERCEL_GIT_COMMIT_SHA || git('rev-parse HEAD')).slice(
    0,
    7,
  );
  const branch = env.VERCEL_GIT_COMMIT_REF || git('rev-parse --abbrev-ref HEAD');
  // Distinguish the three commitCount=0 paths up front so build logs say which
  // one we're on — without this, "shallow with failed unshallow", "no .git at
  // all", and "git binary missing" all look identical at the version-gate
  // abort below.
  const inRepo = git('rev-parse --is-inside-work-tree') === 'true';
  if (!inRepo) {
    console.error(
      '[vite.config] not inside a git work tree — commitCount will be 0 ' +
        '(no .git directory, or git binary unavailable).',
    );
  }
  // Vercel clones at depth ~10; try hard to recover full history so
  // `rev-list --count HEAD` is accurate. Sequence: --unshallow (the normal
  // path); then --deepen with a large step (some remotes/clones reject
  // --unshallow but accept --deepen); finally re-check. Each step prints its
  // output to the build log so a future "commitCount=0" failure is
  // diagnosable from the log alone.
  if (inRepo && git('rev-parse --is-shallow-repository') === 'true') {
    const recovered =
      gitRun('fetch --unshallow', 60_000) ||
      gitRun('fetch origin --unshallow', 60_000) ||
      gitRun('fetch --depth=2147483647', 60_000) ||
      gitRun('fetch --deepen=1000000', 60_000);
    if (!recovered) {
      console.error(
        '[vite.config] every unshallow attempt failed; commitCount will be 0.',
      );
    }
    if (git('rev-parse --is-shallow-repository') === 'true') {
      console.error(
        '[vite.config] repository is still shallow after unshallow attempts.',
      );
    }
  }
  const commitCount =
    !inRepo || git('rev-parse --is-shallow-repository') === 'true'
      ? 0
      : Number(git('rev-list --count HEAD')) || 0;
  // The client stamps commitCount as `x-readmo-build` and the version gate
  // rejects builds below MIN_CLIENT_BUILD. A *production* bundle that stamped 0
  // (shallow checkout that couldn't be unshallowed) would be rejected the moment
  // the gate is armed above zero — locking out the newest client. Fail the
  // production build instead of shipping that poison pill; a shallow prod
  // checkout is a CI problem to fix, not to paper over. Gated on VERCEL_ENV (the
  // real deploy users run), so local/CI `npm run build` and previews are
  // unaffected.
  if (env.VERCEL_ENV === 'production' && commitCount === 0) {
    throw new Error(
      'Build aborted: commitCount is 0 in a production build. Shipping it ' +
        'would let the x-readmo-build version gate reject the newest client. ' +
        'See the [vite.config] log lines above for which path produced 0 ' +
        '(not-a-git-repo, all unshallow attempts failed, or still-shallow ' +
        'after recovery) and ensure full git history before building.',
    );
  }
  const commitTime = git('log -1 --format=%cI');
  const commitSubject =
    env.VERCEL_GIT_COMMIT_MESSAGE?.split('\n')[0] || git('log -1 --format=%s');
  return {
    environment,
    shortSha,
    branch,
    commitCount,
    commitTime,
    commitSubject,
    buildTime: new Date().toISOString(),
  };
}

// URL pattern for the Workbox data cache (Supabase REST/RPC reads). Derived
// from the configured Supabase origin so it keeps matching after a gateway
// migration — pointing VITE_SUPABASE_URL at e.g. api.readmo.app would otherwise
// silently drop the offline cache, since reads would no longer hit
// *.supabase.co. Falls back to any project ref when the URL is unset (local
// dev, or .env-only setups where the var isn't in process.env at build time).
function supabaseRestCachePattern(): RegExp {
  const url = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (url) {
    try {
      const host = new URL(url).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^https://${host}/rest/v1/.*`);
    } catch {
      // Malformed URL — fall through to the default below.
    }
  }
  return /^https:\/\/.*\.supabase\.co\/rest\/v1\/.*/;
}

const TEST_BUILD_INFO: BuildInfo = {
  environment: 'test',
  shortSha: 'abc1234',
  branch: 'main',
  commitCount: 42,
  commitTime: '2026-01-01T00:00:00.000Z',
  commitSubject: 'Test commit',
  buildTime: '2026-01-01T00:00:00.000Z',
};

const buildInfo = isTest ? TEST_BUILD_INFO : readBuildInfo();

export default defineConfig({
  // Expose VITE_* (our own) and NEXT_PUBLIC_* (what the Supabase↔Vercel
  // integration provisions) to the client bundle. NEXT_PUBLIC_ is public by
  // convention, so this is safe; we deliberately do NOT add the `SUPABASE_`
  // prefix, which would leak SERVICE_ROLE/SECRET/JWT/POSTGRES_* secrets.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo),
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
              // SPEC.md *PWA & Offline → Caching strategy*). Pattern is derived
              // from VITE_SUPABASE_URL so it follows a gateway/custom-domain
              // migration instead of silently dropping the offline cache.
              urlPattern: supabaseRestCachePattern(),
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
