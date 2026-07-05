# Cloudflare consolidation — Vercel → Cloudflare Pages (proposal)

> **Status: proposal, not yet executed.** This scopes moving the *frontend* off
> Vercel onto Cloudflare Pages, taking the stack from **three vendors
> (Vercel + Cloudflare + Supabase) to two (Cloudflare + Supabase)**. Nothing here
> is live. See [`ENVIRONMENTS.md`](./ENVIRONMENTS.md) for the preview/production
> split this interacts with, and [`infra/cf-gateway/README.md`](./infra/cf-gateway/README.md)
> for the already-deployed API gateway.

## Why (and the hard line: Supabase stays)

We already run Cloudflare (authoritative DNS + the API gateway Worker) and
Supabase (the whole backend). The only reason Vercel is still in the picture is
that it hosts the static frontend and one small edge shim. Folding that onto
Cloudflare Pages:

- **Removes a vendor** — one fewer dashboard, bill, and DNS/ownership boundary.
- **Unifies the app with the gateway Worker** on one platform (Pages Functions
  *are* Workers), so the `/api/img` shim and the gateway can even share code.
- **Makes the image cache fall out naturally** — a Cloudflare cache sits in front
  of Pages without having to orange-cloud a Vercel-hosted origin (the awkward
  part of the SETUP §6 image-cache note).

**Supabase is *not* on the table.** Supabase is not "just Postgres" — it's
Postgres **+ Auth (GoTrue) + RLS + PostgREST + Edge Functions + pg_cron/pg_net/
Vault**. Cloudflare has no managed-Postgres-with-auth equivalent (Hyperdrive is a
pooler for an existing Postgres; D1 is SQLite with no RLS/PostgREST). Replacing
Supabase would be a full backend rewrite that re-implements the per-user security
boundary (guardrail #7) in application code and probably *adds* an auth vendor.
This doc is only about the **frontend host**.

## What moves

| Today (Vercel) | On Cloudflare Pages |
|---|---|
| Static Vite SPA (`npm run build` → `dist/`) | Pages static deploy of `dist/` |
| `api/img.ts` (Vercel Edge Function) | Pages Function at `functions/api/img.ts` |
| `vercel.json` SPA rewrite (`/((?!api/).*) → /index.html`) | `_routes.json` (Functions own `/api/*`) + SPA fallback to `/index.html` |
| `VERCEL_*` build env (in `vite.config.ts`) | `CF_PAGES*` build env (code change, below) |
| Env vars (Production/Preview scopes) | Pages project env vars (Production/Preview scopes) |
| Auto-deploy on push (Vercel GitHub app) | Auto-deploy on push (Pages GitHub integration) |

## Concrete code/config changes required

1. **Port `api/img.ts` → a Pages Function.** The pure helpers
   (`buildUpstreamUrl`, `isServeableImageType`, `buildAnonHeaders`,
   `uncacheableError`) move **unchanged** — and so does `api/img.test.ts`, which
   tests those. Only the handler wrapper changes:
   - Signature: `export async function onRequestGet(context)` instead of
     `export default async function handler(req)`.
   - Env access: `context.env.SUPABASE_URL` instead of `process.env.SUPABASE_URL`
     (Pages Functions use the Workers runtime, not Node `process.env`).
   - **SSRF posture is unaffected** (guardrail #6): the shim never fetches the
     user URL — it forwards to the Supabase `img` function, whose SSRF-hardened
     `safeFetch` does the validation. That stays on Supabase; the port only
     changes where the *forwarder* runs.
2. **Routing.** Replace `vercel.json` with Pages equivalents placed in
   **`public/`** so the Vite build copies them into the deploy output (`dist/`).
   Cloudflare Pages reads these from the *build output*, not the repo root — a
   `_routes.json` left beside `vercel.json` is ignored, and `/api/img` then falls
   through to the SPA fallback (breaking article images).
   - `public/_routes.json` — include `/api/*` so the img Function runs there and
     everything else is served static (Cloudflare *Functions invocation routes*).
   - `public/_redirects` — SPA fallback (`/* /index.html 200`), ordered *after*
     `/api/*` so an image request never hits the SPA fallback.
3. **Build info (`vite.config.ts` `readBuildInfo`).** Today it prefers
   `VERCEL_ENV` / `VERCEL_GIT_COMMIT_SHA` / `VERCEL_GIT_COMMIT_REF`, falling back
   to `git`. Two changes, and the second is easy to miss:
   - **Value fallbacks:** add the Cloudflare equivalents — `CF_PAGES` (presence),
     `CF_PAGES_BRANCH`, `CF_PAGES_COMMIT_SHA`. The existing git + unshallow
     fallback carries over (Pages also shallow-clones, and the code already
     handles that).
   - **Extend the production-build abort.** The zero-build guard currently fires
     only on `env.VERCEL_ENV === 'production'` (`vite.config.ts:118`) — on Pages
     that var is never set, so a Pages *production* deploy that couldn't recover
     git history would silently ship `x-readmo-build: 0` and get 426'd the moment
     `MIN_CLIENT_BUILD` is armed. Carry the abort over to the Cloudflare
     production signal (`CF_PAGES` set **and** `CF_PAGES_BRANCH` === the
     production branch), not just the SHA/branch value fallback.

   Land **both** *before* ever arming `MIN_CLIENT_BUILD`.
4. **Env vars** (set in the Pages project, per environment — a fresh project
   starts empty, so copy the *whole* set, same footgun as any new deploy target):
   - `VITE_SUPABASE_URL` → the gateway (`https://api.readmo.app`) for Production.
   - `NEXT_PUBLIC_SUPABASE_URL` / anon key → as today (client fallbacks).
   - `SUPABASE_URL` (server-side, read by the img Function) → the **direct**
     `…supabase.co` origin — never the gateway (the shim can't carry
     `x-readmo-build`, so through the gateway it'd 426 once the gate is armed).
5. **Build settings.** Build command `npm run build`, output `dist`, Node pinned
   to the `engines` range (20/22/24). Add a `_headers` file for asset
   cache-control if you want to tune it (Vite's hashed filenames make the JS/CSS
   immutable-cacheable).

## How preview works on Pages (and its friction)

Cloudflare Pages gives every push a **preview deployment** at
`<hash>.<project>.pages.dev`, plus a stable per-branch alias
`<branch>.<project>.pages.dev`; **production** is the production branch (`main`)
on the custom domain. So previews exist — but two gotchas, both shared with the
Vercel-preview problem we already hit:

- **CORS:** `*.pages.dev` preview origins are **not** in the gateway Worker's
  `APP_ORIGINS`, so a preview pointed at the gateway fails CORS (the Worker
  echoes `readmo.app` back to a `pages.dev` caller). Fix: either point previews
  at the **direct** Supabase URL (no gateway → no CORS setup), or allow-list a
  **stable** preview origin (a pinned `<branch>.pages.dev` or a
  `staging.readmo.app` custom domain) in `APP_ORIGINS`. See `ENVIRONMENTS.md`.
- **Auth:** OAuth sign-in from a preview needs that origin in Supabase Auth →
  Redirect URLs, or the round-trip refuses to return. Site URL stays `readmo.app`.

## Downsides / risks (read before committing to this)

- **You lose Vercel's DX.** PR preview comments, one-click rollback UI,
  Speed Insights/analytics, and the generally slicker dashboard. Pages previews
  work but the ergonomics are rougher.
- **Preview CORS + auth allow-listing friction** (above). With Vercel today you
  have the *same* friction, but if you're currently pointing previews at direct
  Supabase you may not have felt it yet.
- **Runtime differences** in the img Function (`env` vs `process.env`, Workers
  vs Vercel Edge APIs). Small, but must be tested on a real Pages deploy, not
  just unit tests.
- **DNS cutover is the real risk.** Moving `readmo.app`/`www` from Vercel to the
  Pages project is a live DNS + TLS change. Do it staged (below) with Vercel kept
  warm for rollback; a botched cutover is downtime.
- **New-project env drift.** A fresh Pages project has no env vars — miss one and
  it fails confusingly. Copy the full set (see §4).
- **CI rewiring.** CI itself only builds/tests (unchanged), but the deploy trigger
  moves from Vercel's GitHub app to Pages' — minor, one-time.
- **Not a performance or cost win.** Both hosts are free at this scale and both
  serve from a global edge. The payoff is *vendor consolidation + easier image
  caching*, not speed or money. **Don't do this under time pressure** — it's
  optional tidy-up, and the DNS cutover wants a calm window.

## Cost / reliability (guardrail #5)

- **$0.** Pages free tier: generous static requests/bandwidth, 500 builds/month;
  Pages Functions draw on the Workers free allotment (~100k req/day) already noted
  in the gateway README. No new paid services.
- **Reliability:** same Cloudflare edge as the gateway. A failed build leaves the
  previous deploy serving; the only sharp edge is the one-time DNS cutover, which
  the staged plan de-risks.

## Migration plan (staged, reversible)

Each phase is independently verifiable; rollback at any point is "DNS back to
Vercel."

- **A — Stand up Pages, no custom domain.** Create the Pages project on the repo,
  build `main`, deploy to `<project>.pages.dev`. Point its env at direct Supabase
  (simplest) and confirm the app loads, signs in, reads/writes.
- **B — Port the img shim.** Add `functions/api/img.ts` + `_routes.json`; confirm
  images load on the `pages.dev` deploy.
- **C — Build info.** Add the `CF_PAGES*` fallback to `vite.config.ts`; confirm
  `/debug` shows a real build number/SHA on Pages (not `0`).
- **D — Cutover DNS.** Add `readmo.app` + `www` as custom domains on the Pages
  project (smooth, since Cloudflare is already your DNS). **Keep the Vercel
  deployment live.** Watch real traffic.
- **E — Retire Vercel** once Pages is stable for a few days.

Rollback: repoint the domains at Vercel (records are all in Cloudflare DNS
already), redeploy if needed.

## What does *not* move

- **Supabase** — the entire backend (see the hard line above).
- **The gateway Worker** — stays as-is. Optional future tidy: fold the img
  Function into the same Worker/project so the image path and the API gateway
  share one deploy.
