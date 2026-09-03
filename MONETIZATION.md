# Monetization

Where the money would come from, if it came from anywhere. This is the
cross-repo strategy doc for the three web products — readmo, newshacker,
gedmap — and it exists so the reasoning below isn't re-derived from scratch
every few months.

**Operational work lives in each repo's `TODO.md`, not here.** Quota handling,
monitoring, alerting and cost ceilings are production-readiness engineering
that is needed whether or not anything is ever charged for. Keeping them out of
this file means they survive if the revenue idea is dropped.

## The honest position

Readmo will not recover the operator's tooling costs, and almost certainly
never will. That is the normal outcome for a project of this kind and not a
failure state. Two targets are worth keeping apart:

| Target | Realistic? |
|---|---|
| Readmo pays for its own infrastructure | **Yes** — ~6–11 subscribers |
| Readmo pays for the operator's tooling (Claude Max et al.) | No — ~37–60 subscribers, needing 750–3,000 free users |
| Readmo pays for the operator's time | No — a different order of magnitude again |

Claude Max is **not** a readmo cost. It is tooling across ~23 repositories.
Attributing it here makes the arithmetic look impossible and hides the number
that matters, which is readmo's own marginal infrastructure.

**The binding constraint is distribution, not product, billing, or
measurement.** At the current user count no paywall, funnel or analytics change
tells you anything, because there is no denominator. One post to the right
community is worth more than the entire billing stack. See *Distribution*
below.

## Cost base

Monetizing raises the floor before it earns anything — plan for the first
handful of subscribers to buy nothing but the right to charge.

| Line | Today | Once real customers depend on it |
|---|---|---|
| Vercel | Pro, already paid (Hobby forbids commercial use) | unchanged |
| Supabase | free / Micro | **Pro, $25/mo** — the free tier pauses and gives ~1 shared vCPU (`SCALING.md`) |
| Cloudflare | $0 — free WAF rule + the `infra/cf-gateway/` Worker, which rewrites to `<ref>.supabase.co` and avoids the $10/mo Supabase custom-domain add-on | $0 until per-session rate-limit keying is needed (~$5/mo on Pro) |
| Grafana Cloud | $0 — free tier covers a one-operator project | scale-triggered |
| Gemini / Jina | pennies — shared caches, see below | scales with *distinct articles*, not users |

At $5/mo through Stripe the fee is 2.9% + 30¢ = **$0.445**, so a payment nets
**~$4.56** — that is the ~9% drag quoted below (0.445/5). The incremental $25
is ~6 subscribers; readmo's whole infrastructure is ~10–11.

## Unit economics are good; fixed cost and audience are the problem

Worth stating because most products don't have this shape:

- **Poll cost scales with distinct feeds, not users** (`SPEC.md` — one poll
  serves every subscriber, conditional GETs cut it further).
- **Spoiler rewrites cache on the shared item** (`items.spoiler_free_title`) —
  generated once, served to everyone.
- **Summaries are per-article and shared**, bounded to pinned-or-requested.
- **newshacker's warm-summaries cron** keeps the top 30 HN stories cached, so
  the stories most people read cost nothing at the margin.

Marginal cost per additional user is therefore close to zero, which is exactly
the condition a generous free tier needs. It also means AI features cannot be
justified as a paid tier on *cost* grounds — price them on value or not at all.

## What each product is for

The three are not the same shape and should not get the same treatment.

### readmo — the only natural subscription

Daily habit, accumulating state, genuine ongoing server cost. That is the
profile a subscription fits.

**Proposed paid tier ($5/mo):**

- **Raised feed cap.** `subscribe_to_feed` already enforces a per-account cap
  server-side (`0059_feed_cap.sql`, SQLSTATE 53400, typed client error).
  Reading the cap from a plan row instead of a constant is a few lines inside a
  function that already holds the right advisory lock. Self-selects power users
  and leaves the free tier genuinely usable.
- **AI summaries.** Real differentiation against Feedbin/Inoreader.
- **Spoiler filtering.** Near-free at the margin (shared cache) — a sweetener
  in the bundle, not a cost-justified line item.

**Explicitly NOT in the paid tier: full-text reading mode.** The `fulltext`
gate is a *legal* gate, not a cost gate — `_shared/allowlist.ts` says so
outright: it fetches beyond the feed and stores a shared copy, and the
allowlist exists so the operator can keep that to themselves and family.
Selling it changes the character of the exposure from a family tool doing
something gray to a commercial service selling access to publishers' full
text. If it is ever sold, that must be a deliberate decision to retire the
legal gate, taken with eyes open — never a side effect of building a pricing
page. **Paid must never quietly replace allowlisted; if sold, the check is
paid AND allowlisted.**

Offline reading of the *feed body* stays free — it is a core PWA promise and
paywalling it would read as a takeaway to existing users.

### newshacker — free forever, top of funnel

Its job is **reach**, and a paywall reduces reach, undermining the thing it
feeds. A paywalled unofficial HN client would also land badly on Show HN, which
is the single best distribution asset in the portfolio. Keep it unambiguously
free.

The audience overlap with readmo is unusually good — HN readers *are* the RSS
demographic — and most cross-promotion fails precisely because audiences don't
match.

**The bridge already exists and is bidirectional:** `newshacker-sync` (Edge
Function) plus `newshacker_link` (0050) and the `apply_newshacker_state` RPCs
(0062/0063/0065) mirror Done and Pinned state both ways. So the usual
funnel-killer — "great, now start over with an empty account" — is largely
solved.

The promotion should be a product bridge, not a banner: *"You read HN here.
Read everything else the same way — and your Done and Pinned state comes with
you."* Expect 1–3% free→paid conversion, so this needs volume at the top.

### gedmap — one-off, if anything

**Usage shape determines pricing model.** gedmap is episodic: upload a GEDCOM,
look at the map, done. No accumulating state, no reason to return next
Tuesday. Subscriptions need recurring delivered value; charging monthly for a
one-shot tool buys 90% churn in month two. One-off / lifetime is the correct
shape.

**Lifetime is safe only when marginal cost per user is ~zero**, and gedmap's
isn't — HERE geocoding and Mapbox map loads are per-use, so a lifetime buyer
who runs forty files costs forty times a light one, forever, for one payment.
Two ways to make it safe, and they compose:

1. **Persist the geocode cache** so repeat use is nearly free.
2. **BYOK the HERE key**, as clothescast does for Gemini. No revenue, but it
   removes gedmap from the cost line entirely — which for "self-sustaining" is
   nearly as good.

Price anchor: $15–25 one-off reads as impulse-priced against RootsMagic (~$40)
and Family Tree Maker (~$80).

**Open question:** Ancestry has a comparable mapping feature. The tier it sits
in has not been checked. The question that decides it is not which tier but
whether their version requires an Ancestry subscription with the tree inside
their platform — if so, gedmap's niche is "I have a GEDCOM and don't want to be
an Ancestry customer" (Gramps/RootsMagic users, people who have exported,
privacy-minded folks, since genealogy data is unusually personal and full of
living relatives). That niche is real; it is not by itself a business.

## Payments

**Volume is NOT what makes this safe, and the first draft of this section got
that wrong.** Cross-border digital sales to consumers carry **zero**
registration thresholds in several places — UK VAT for a non-established
supplier, and EU VAT for a non-EU supplier of digital services, are the usual
examples — so the *first* taxable sale can create an obligation. "Only a few
friends are paying" is therefore not a defense, and waiting for volume to
trigger a switch to a merchant of record is the wrong trigger entirely.

**Settle this before taking a single payment**, one of two ways:

1. **Restrict who can buy** — sell only into the operator's own jurisdiction,
   where the domestic threshold is a real number rather than zero. **This is
   not a Checkout toggle**, contrary to an earlier draft of this section:
   Checkout Sessions expose `allowed_countries` only under
   `shipping_address_collection`, which a digital subscription does not use;
   `billing_address_collection` merely decides whether an address is
   *collected*, not from where. So restricting sales means building an
   eligibility gate ourselves before creating the session — and a
   self-declared country is weak evidence, since the card's own country is not
   known until payment. Treat option 1 as real work with a soft edge, not a
   setting.
2. **Use a merchant of record from the start** (Paddle, Lemon Squeezy, ~5% +
   50¢). They become the seller of record and own the liability everywhere,
   which removes the question rather than answering it.

**Stripe direct is the better teacher** — it exposes the subscription objects,
webhook events and retry semantics that are the point of building this, where
an MoR abstracts away the part with the lesson in it. But that was recommended
on the assumption that option 1 was a checkbox, and it is not: a self-declared
eligibility gate is the weakest link in a chain whose failure mode is a tax
obligation in someone else's country. **So this needs the maintainer's
decision, not a default** — the trade is roughly 5% + 50¢ per sale against
building and trusting that gate. At the volumes in this document the MoR fee is
a couple of dollars a month; the exposure it removes is not measured in
dollars a month. Take option 2 whenever the answer is unclear, and take it
regardless the moment sales open beyond one jurisdiction.

**This is a real-money question and not one to settle from a repo doc.** The
operator's own jurisdiction decides the domestic threshold and the registration
mechanics, so confirm it against current guidance (or an accountant) rather than
against this file.

Use **Stripe Checkout and the Customer Portal**, both hosted. No billing UI, no
card data anywhere near the database, no PCI surface.

Offer annual (~$50/yr) whenever there is anyone to offer it to: it cuts fee
drag from ~9% to ~3.5% and cuts churn, which matters more than the headline
price.

## Entitlements

Readmo has already built most of this machinery. **Generalize the allowlist;
don't invent a parallel system.**

- **Table.** `entitlements(user_id, tier, status, current_period_end,
  feed_cap, stripe_customer_id, stripe_subscription_id)`. RLS: a user may
  `select` their own row and has **no** insert or update grant at all. Only
  `service_role` writes. Guardrail 7.
- **Two AUTHENTICATED endpoints come first, or nothing can be assigned.** The
  webhook cannot pick an `entitlements.user_id` on its own: it has to be told.
  So a signed-in caller hits our own endpoint to *create* the Checkout session,
  and that endpoint stamps `client_reference_id` with `auth.uid()` — a trusted
  field the webhook reads back. Matching on the checkout email instead is
  wrong: the buyer types it, it need not be the account's, and it can change,
  so it would credit the wrong account. The Customer Portal needs the same
  treatment in reverse — a server endpoint that derives the Stripe customer
  from the *signed-in user's own* stored entitlement, never from a
  client-supplied customer id, which would otherwise let anyone open anyone
  else's billing page. Cross-account tests for both.
- **Creating a Checkout session must be idempotent too, for a reason the
  webhook's idempotency doesn't cover.** A retried request, a double-tapped
  button, or the same person in two tabs creates two *sessions*, and two
  completed sessions create two subscriptions — both real, both billing, while
  the entitlement model is one row per user and can only remember one of them.
  The second becomes a charge with nothing pointing at it and a refund
  conversation.

  **A time-window key and an "is there an open session?" check are both too
  weak to rely on**, in ways that only show up under the concurrency that
  causes the bug. Two requests either side of a window boundary get *different*
  idempotency keys, so Stripe happily creates two sessions; and there is a gap
  after Checkout completes but before its webhook writes the entitlement where
  neither guard sees anything — no open session, no active entitlement — so a
  second attempt sails through and buys a second subscription. So the durable
  shape is a **persisted attempt row keyed by user**, with a unique constraint
  doing the serializing: record the attempt before redirecting, derive the
  Stripe `Idempotency-Key` from that row's stable id rather than from a clock,
  reuse the row's session while it is live, and refuse when the caller already
  holds an active entitlement — sending them to the Portal, which is where
  changing an existing subscription belongs anyway. The row is also what covers
  the webhook gap, since it exists from before the redirect until the
  entitlement lands. Test two concurrent creates and a create in that gap.
- **The webhook is the source of truth, never the checkout redirect.** A public
  Edge Function verifying the Stripe signature, handling
  `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.payment_failed`. Idempotent by
  event id — Stripe retries.
- **`client_reference_id` is on the Checkout Session and nothing else, so the
  subscription events need their own copy of the user id.** Only
  `checkout.session.completed` carries it; `customer.subscription.updated`,
  `.deleted` and `invoice.payment_failed` carry a customer and a subscription
  and no idea who that is to us. Deriving the user by looking up the
  entitlement row keyed on `stripe_customer_id` works *once a row exists* — and
  the out-of-order delivery the bullet below already anticipates is precisely
  the case where it does not. So stamp the id twice at session creation:
  `client_reference_id` **and** `subscription_data.metadata.user_id`, which
  Stripe copies onto the subscription object and every later event about it.
  Then a subscription event that overtakes its checkout can still write the
  right row. Test that ordering explicitly — arriving first, not merely late.
- **Idempotency is not ordering, and the difference bites.** Event-id
  deduplication stops the *same* event applying twice; it does nothing about
  two *different* events arriving out of order. A delayed
  `customer.subscription.updated` landing after a `deleted` would restore
  access to a cancelled subscription; a stale `invoice.payment_failed` would
  revoke access that has since renewed. Writes must be **monotonic per
  subscription**, and **the event timestamp is not the way to do it**: Stripe's
  `created` has second resolution, so an update and a deletion raised in the
  same second cannot be ordered at all — accepting equal timestamps lets a
  delayed update restore deleted access, and rejecting them discards an event
  that may be the genuinely newer one. Use an authoritative source instead:
  re-fetch the subscription's current state from Stripe and write that rather
  than trusting the payload, or order on a token that actually increases per
  subscription. Test reverse-order delivery explicitly — it is the case that
  never turns up by accident.
- **Enforcement goes exactly where the allowlist's is:** server-side, inside
  the function, before the expensive work.
- **An entitlement gate is added ALONGSIDE the allowlist, never in place of
  it.** The two answer different questions — the allowlist is a *legal* gate on
  what we may fetch and store, the entitlement is a *commercial* gate on who
  has paid — so a path that is allowlisted today stays allowlisted, and a paid
  caller who is not on the list gains nothing there. This matters most on
  `summary`, which fetches the full article through Jina
  (`supabase/functions/summary/index.ts`): swapping its
  `loadAllowlistFromDb` for `loadEntitlement` would sell exactly the
  full-text access the *readmo* section above says must not be sold.
  So: `summary` becomes **entitlement AND allowlist**; `subscribe_to_feed`
  reads `feed_cap` from the entitlement row and has no allowlist to preserve.
- **The pin trigger must NOT be gated as a whole.** 0053/0054 (retried by 0066)
  fire `summary` on pin, and that one call launches **two** things: the AI
  summary *and* the full-text download — 0066's own header says so. Gating the
  trigger on entitlement would therefore switch off the server-side full-text
  prewarm `SPEC.md` promises for a pinned item, for an allowlisted user who
  simply hasn't paid — silently making a *free* feature worse in order to sell
  a paid one. **Gate the summary leg only**, or split the two legs so the
  full-text prewarm keeps firing on its own allowlist check.
- **Gating generation is not gating the feature — delivery is a separate
  path.** `feed_items` includes `ai_summary` on the row itself, gated only on
  `email_is_allowlisted()` (0073), and `useSummary` renders that ride-along
  with no Edge round-trip at all — instantly, and offline. So an entitlement
  check inside the `summary` function stops a free user *generating* a summary
  and does nothing to stop them *reading* one another subscriber generated.
  Since the allowlist is the family, that would leave the paid tier gating
  nothing for precisely the people who might pay for it. Entitlement-gate the
  row projection and the display path as well, keeping the allowlist check
  alongside.
- **The spoiler path is part of the migration too, and is easy to miss.** It
  is gated in three more places the list above doesn't reach, and they don't
  all fail the same way. Two are a paid user not getting what they bought: the
  poller selects work through `feeds_with_allowlisted_subscriber` (0045,
  service-role only), and the client hides the controls behind the full-text
  capability. The third runs the other way — the rewrite caches on the
  **shared** item, and the server hands it to every co-subscriber of the feed
  whether or not they are entitled, so a UI gate hides a value the device
  already holds. That one has to be gated in the row projection server-side,
  the way `ai_summary` already is. All three need an entitlement-aware
  equivalent — and note this one is deliberately **entitlement OR allowlist**,
  not AND: the rewrite reads only the headline and the already-stored feed
  body, so it carries none of the full-text exposure that makes `summary`
  different.
- **The client only displays tier, never decides it** — the FAMILY chip pattern
  in the account menu is already the right shape, and the capability it reads
  must be **server-derived**, never computed client-side.
- **An absent TABLE means current behavior; an absent ROW does not.** These are
  two different facts and collapsing them is a leak with a long tail. The
  allowlist's "empty table → open to all" semantic is the right model for the
  first: the two halves deploy on different clocks, so a client in front of a
  backend without the entitlements table must keep working exactly as today,
  and existing family users get grandfathered by having rows written *for*
  them, never by a gate flipping shut on deploy. But once the table is live and
  backfilled, a missing row is no longer evidence of an old backend — it is a
  **new signup**, and reading that as "current behavior" hands every future
  free user the legacy uncapped feed and, if they are allowlisted, summaries,
  permanently. So: table or capability absent → legacy behavior; table present
  and row absent → the free tier. Provision a free row from a signup trigger as
  well, so the second case is rare rather than load-bearing.
- **Fail CLOSED when the entitlement read fails**, matching guardrail 7 and
  what `loadAllowlistFromDb` already does. An unreadable row means the caller's
  status is unknown, and treating unknown as paid hands out the feed cap and
  uncontrolled Gemini/Jina work precisely while the backend is degraded —
  the moment that is least affordable. Surface it as a retryable error, not a
  silent downgrade.
- **The grace window is a different thing and stays.** It applies to a row that
  was read *successfully* and whose `current_period_end` has just lapsed, so a
  dropped webhook or a failed renewal doesn't lock out someone who paid. Keep
  the two apart: "we couldn't check" fails closed, "we checked and it recently
  expired" gets the grace.

## Rolling this out

Both the migration and the webhook function need manual `make migrate` /
`make deploy` — they do not ride the Vercel auto-deploy. **They are not the
whole of it, and the rest is not a deploy at all**: three things have to be set
by hand at the provider, in this order, or the first paying customer meets a
half-wired system.

0. **Add all three functions to the `Makefile`** — the webhook and the two
   session endpoints. `deploy` enumerates every function by name
   (`deploy-discover deploy-refresh deploy-poll …`), so nothing is discovered
   automatically and an unregistered function is simply never deployed:
   Checkout and the Portal would 404 after a rollout that looked complete. The
   webhook's own target takes `--no-verify-jwt`, like `deploy-poll` — it is
   public and verifies Stripe's signature itself. This step is code, not
   configuration, so it belongs in the PR rather than in the operator's hands.
1. **Deploy the webhook function**, so there is a URL to register. It will
   reject every event until step 3 gives it a signing secret; that is expected
   at this point and is why nothing is pointed at it yet.
2. **Register the endpoint in Stripe**, against exactly the four events above
   and pointing at that URL. Stripe sends nothing until it is told to, so a
   deployed-but-unregistered webhook looks identical to a broken one: payments
   succeed and no entitlement is ever written. **This step is what generates
   the signing secret**, so it cannot come after the step that sets it.
3. **Set the Supabase secrets** — the signing secret from step 2, plus the
   Stripe API key — with the CLI/dashboard like `JINA_API_KEY` and the `SMTP_*`
   pair already are (SETUP.md §6). Each function reads only what it needs: the
   webhook verifies with the signing secret, the two session endpoints call
   Stripe with the API key. Neither ever reaches the client. Redeploy if the
   runtime does not pick up a changed secret on its own.
4. **Create the price in Stripe**, with its id configured for the session
   endpoint. A price id is environment-specific; test-mode and live-mode ids
   are different objects.

Until step 3 lands, Stripe's delivery attempts fail — which is harmless here,
because its retries run for three days and will re-deliver anything sent in the
gap. Do not open checkout to a real customer before then.

Do the whole sequence in Stripe **test mode** first, against a deployed
preview, and only then repeat it live. Neither the secrets nor the
registration is in this repository, so nothing in CI will notice a missing
step.

**Cost and reliability of the dependency** (guardrail 5). *Cost:* 2.9% + 30¢
per successful charge and nothing otherwise — no monthly fee, no minimum, so
zero subscribers costs zero. At $5/mo that is $0.445, netting ~$4.56, the ~9%
drag noted above; annual billing cuts it to ~3.5%. Disputes are $15 each,
which at this price point makes a single chargeback cost three months of the
subscription. *Reliability:* Stripe's API is rate limited (order of ~100
requests/second in live mode) — far above anything this will produce, and the
two session endpoints are called once per human action, so the limit is not a
design constraint here. What matters is the failure shape, and it is
favorable in one direction and not the other. **No read path depends on
Stripe** — entitlement checks read our own table, so a full Stripe outage
leaves every existing subscriber working normally. But **the two session
endpoints are synchronously on a button**: each must call Stripe to create the
session *before* it can redirect, so Stripe's latency is on that click even
though the page it lands on is hosted there. Budget roughly a few hundred
milliseconds for the create call in the normal case, give it an explicit
timeout, and show a pending state on the button rather than letting a slow
call look like a dead one — measure it once against the real API instead of
trusting this figure. Only two things break in an outage: a new purchase can't
start (the session endpoint fails, and it should say so rather than silently
rendering a dead button), and webhooks stop arriving —
which self-heals, since Stripe retries a failed delivery with backoff for up
to three days, and the grace window above is what keeps a renewal that is
merely *late* from locking someone out. The one thing that does not self-heal
is a webhook we accept and mishandle: a 2xx tells Stripe we are done. Return
5xx on anything unprocessed so the retry actually happens.

## Distribution

This is the constraint. Everything above is downstream of it.

Two products have a *natural* audience rather than a hypothetical one:

- **newshacker → Show HN.** It is an HN client; that is literally its market.
- **gedmap → genealogy communities** (r/Genealogy, forums, groups) — large,
  underserved by good tooling, full of hobbyists who already pay for software.
- readmo's audience (r/rss, RSS-adjacent HN threads) is smaller and better
  served by incumbents. It is the *destination* of the funnel, not its mouth.

**Sequence: instrument, harden against the traffic, launch free, then price
from what is learned.** Launching with a paywall on an unvalidated product
conflates "do people want this?" with "will they pay?" and answers neither
cleanly. And instrumentation must predate the push — measuring after the fact
says nothing about what changed.

The hard part of a self-sustaining product is distribution, and it is the part
that gets validated *before* building. That lesson is available here for free.

## Before charging anyone

Non-negotiable prerequisites, none of them code:

- [ ] Terms of service and a refund policy (Stripe requires them; consumer law
      in several jurisdictions does too).
- [ ] A privacy policy that actually matches what the app does.
- [ ] A support channel that works — a monitored address, before there is
      anyone to support.
- [ ] Account deletion and data export (readmo has `export_subscriptions`,
      0061 — confirm it covers what a departing customer is owed).
- [ ] A decision on what happens to paid features if the service is ever shut
      down. Owed to anyone who paid, and cheapest to decide now.

## Costs of charging that are not money

Worth weighing, and consistently underestimated: taking payment creates
obligations that don't currently exist — support expectations, uptime
expectations, refunds, and no longer being free to break things on a whim. For
a family tool that is a real quality-of-life cost.

The corollary, and the single most important operating principle here:
**keep the running cost low enough that it never feels like a reproach.**
Projects like this rarely die from lack of revenue. They die when the monthly
bill turns a pleasure into an obligation. At $10–35/mo these can simply run for
years, and that is the thing worth protecting — which argues for staying on the
free tiers rather than monetizing into a higher floor before there is anyone to
monetize.
