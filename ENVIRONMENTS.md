# Environments — separating preview from production (proposal)

> **Status: proposal / reference.** This describes how to properly separate a
> **preview** environment from **production**, and the trade-offs of each level of
> isolation. Today there is effectively *one* environment (production), and any
> "preview" shares production's database. Related: [`CLOUDFLARE.md`](./CLOUDFLARE.md)
> (Pages preview mechanics), [`SETUP.md`](./SETUP.md),
> [`infra/cf-gateway/README.md`](./infra/cf-gateway/README.md).

## The problem

Two things make "just use a preview deploy" not a real preview today:

1. **One Supabase project.** Every deploy — production or preview — points at the
   same Supabase project, so a preview is *not* isolated at the data layer. A
   preview write is a production write (bounded by RLS to the signed-in user's
   own rows, but real).
2. **The API base URL is a build-time constant.** `VITE_SUPABASE_URL` is baked
   into the bundle at build (`src/lib/supabase/client.ts` reads
   `import.meta.env.VITE_SUPABASE_URL ?? NEXT_PUBLIC_SUPABASE_URL`), so which
   backend a build talks to is fixed per deploy, not per request/user.

A preview differs from production along several **independent** axes. You can
separate some without separating all:

| Axis | How it separates | Cost/effort |
|---|---|---|
| Frontend build/deploy | Preview URL (Vercel/Pages) | Free, already exists |
| API endpoint (gateway vs direct) | Per-environment `VITE_SUPABASE_URL` | Free |
| **Database / data** | See options below | **The hard one** |
| Auth (redirects, sign-in) | Supabase Auth config per env | Free (config) |
| Client caches (SW/IndexedDB) | Origin-scoped — different preview origin isolates automatically (guardrail #8 is per-origin) | Free |

## Database separation — the real decision

Cheapest → most isolated:

### Option 0 — Shared production DB (today)

Previews read/write production data, RLS-scoped to the signed-in user. **Fine for
config/UX/infra testing** (e.g. the gateway flip); **never for destructive tests
or migrations** — those hit production for real.

- **Cost:** $0. **Isolation:** none at the data layer.
- **Risk:** a preview bug mutates production data (bounded to your own rows by
  RLS). Treat every preview write as a production write.

### Option 1 — A second Supabase project (staging DB)

A separate free-tier Supabase project as the preview/staging backend. Full data
isolation.

- **Cost:** $0 on free tier for one extra project (note: free projects **pause
  after inactivity** — a staging project may need a poke before use).
- **Upsides:** real data isolation; its own Auth config (preview sign-in ≠ prod).
- **Downsides:** you must **keep schema in sync** — run `make migrate` against
  *both* projects, and seed data. Two sets of secrets. Migration drift is the
  main hazard: staging that's behind prod tests the wrong thing.

### Option 2 — Supabase Branching (per-PR preview databases)

Supabase's built-in **branching** spins up an ephemeral database per Git
branch/PR, applies the repo's migrations, and seeds it — wired through the
Supabase↔GitHub/Vercel integration. **This is the purpose-built answer**, and the
`Supabase Preview` check already present on our PRs (currently *skipped*) is
exactly this integration waiting to be enabled.

- **Cost:** **paid** — branching runs on paid compute (per-branch, while alive).
  Budget it explicitly before enabling (guardrail #5); it is *not* free like the
  rest of the stack.
- **Upsides:** automatic per-PR DB, migrations applied from the repo, no manual
  sync, teardown on merge.
- **Downsides:** costs money; ephemeral DBs start **empty/seeded**, not a copy of
  production data — good for schema/logic, not for "does it work against real
  content."

## Env var strategy (concrete)

Set these per environment (Production vs Preview scope) on the host (Vercel today,
Pages later). Who reads what:

| Var | Read by | Production | Preview |
|---|---|---|---|
| `VITE_SUPABASE_URL` | **Client** bundle (wins over `NEXT_PUBLIC_*`) | `https://api.readmo.app` (gateway) | direct `…supabase.co` of the preview DB, **or** gateway + allow-listed origin |
| `NEXT_PUBLIC_SUPABASE_URL` | Client fallback | direct | direct (preview DB) |
| `*_ANON_KEY` | Client | prod anon | preview-DB anon (if Option 1/2) |
| `SUPABASE_URL` | **Server** (`/api/img` shim) | **direct** `…supabase.co` | **direct** (preview DB) |

**Recommendation:** keep previews **off the gateway** (point them at the direct
Supabase URL) unless you are *specifically* testing the gateway. That avoids the
`APP_ORIGINS` + Supabase-redirect allow-listing churn on every preview origin. If
you *do* want gateway coverage on a preview, use a **stable** origin (below), not
an ephemeral per-deploy hash.

## Auth across environments

- **Site URL** stays production (`readmo.app`).
- **Redirect URLs** must include any preview origin you want OAuth sign-in on.
  Wildcards for ephemeral `*.pages.dev`/`*.vercel.app` hashes are impractical —
  use a **stable** preview hostname instead.
- With a **separate preview Supabase project** (Option 1/2), that project has its
  *own* Auth config — point its Site URL/redirects at the preview origin, keeping
  preview auth fully isolated from production auth.

## Use a stable preview hostname

Whichever DB option you pick, prefer a **stable** preview origin —
`staging.readmo.app` (a custom domain pinned to the preview deploy) or a pinned
`<branch>.<project>.pages.dev` — over ephemeral per-deploy URLs. You then
allow-list it **once** (gateway `APP_ORIGINS` + Supabase redirect URLs) instead of
re-doing it per deploy. This is the single biggest ergonomics win for a real
preview setup.

## Recommended setups by goal

| Your goal | Setup |
|---|---|
| Safely try **config/infra** changes (gateway flip, env tweaks) | **Option 0** (shared DB) + a **stable `staging.readmo.app`** allow-listed once. Cheapest; covers the common case. |
| Test **schema/data** changes before prod | **Option 1** (second Supabase project) — full isolation, at the cost of keeping migrations in sync. |
| **Per-PR** ephemeral previews with their own DB | **Option 2** (Supabase Branching) — most automated, **paid**, seeded-not-real data. Enables the existing `Supabase Preview` check. |

## Cost / reliability summary (guardrail #5)

- **Option 0:** $0, no isolation, RLS-bounded blast radius.
- **Option 1:** $0 (extra free project; pauses when idle), manual migration sync.
- **Option 2:** **paid** (branch compute), fully automated, ephemeral seeded DBs.
- Frontend previews, the stable-hostname trick, and per-environment env vars are
  all free on both Vercel and Cloudflare Pages.
