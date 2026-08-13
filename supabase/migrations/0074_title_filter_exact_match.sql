-- Drop the plural allowance from the title matcher: a filter entry now matches
-- exactly the words it contains, and nothing else.
--
-- WHY. The allowance was add-only (`tariff` also matched "tariffs", plus `+es`
-- and consonant-y → `-ies`) and it was correct as far as it went. It goes
-- because the feature it serves is small and unproven — nobody has used the
-- filtered-words list in anger yet — and this was the most linguistic knowledge
-- in the whole feature: English pluralization rules, hand-written, that no
-- other language's plurals obey, duplicated between the client matcher and this
-- one. A reader who wants both forms adds both, and the row menu offers
-- whichever forms the headline actually contains. See SPEC *Filtered words*.
--
-- What is deliberately NOT dropped is server-side filtering itself. It is the
-- reason a feed's unread badge agrees with the list it opens, and the reason a
-- feed whose newest articles all match still shows the ones behind them instead
-- of rendering empty. That half earns its cost; the plural rules did not.
--
-- The needle is now the entry verbatim, wrapped in the same single spaces the
-- haystack carries, so the whole matcher is one `strpos` per entry.
--
-- ROLLOUT: APPLY THIS BEFORE THE CLIENT SHIPS. The two halves change semantics
-- together, and the mismatch is not symmetric — one order is safe and the other
-- hides articles, so the order is not a matter of taste (Codex P1 on #629).
-- Both directions were run against a real Postgres rather than reasoned about:
--
--   * MIGRATION FIRST (this predicate live, cached client still plural-aware):
--     for filter `tariff` and the title "New tariffs announced", the server
--     matches nothing, so it SERVES and counts the row; the old client hides it
--     locally. The badge over-counts and the row spends a floor slot — the
--     under-filtering direction, which costs the reader no article.
--
--   * CLIENT FIRST (new exact-only client against a not-yet-migrated backend):
--     the old predicate's plural allowance matches, so the server WITHHOLDS a
--     row the new client would have shown. An article hidden with no cue — the
--     direction this whole line of work exists to eliminate.
--
-- So: `make migrate` from this branch before the frontend auto-deploys on
-- merge, and there is no window at all. If the client does land first, the
-- window lasts until the migration runs and only affects entries whose plural
-- appears in a title.
--
-- Deliberately NOT gated behind a client-version capability check. That would
-- mean versioning the matcher's semantics and teaching both sides to negotiate
-- them, which is more machinery than the whole feature — and this feature is
-- explicitly scoped as small and unproven (SPEC *Filtered words*). A correct
-- deploy order costs nothing and achieves the same thing.

drop function if exists public.title_token_variants(text);

create or replace function public.title_is_filtered(p_title_normalized text, p_filters text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select exists (
    select 1
    from unnest(coalesce(p_filters, '{}'::text[])) as e
    where e <> ''
      and strpos(p_title_normalized, ' ' || e || ' ') > 0
  );
$$;

comment on function public.title_is_filtered(text, text[]) is
  'Whether an ALREADY-NORMALIZED title (items.title_normalized) contains any of '
  'the reader''s already-normalized filter entries as a whole word or contiguous '
  'run. Both sides are space-wrapped upstream, so substring containment IS '
  'whole-word matching. Exact only — no plural or stem allowance. A NULL '
  'title_normalized matches nothing.';
