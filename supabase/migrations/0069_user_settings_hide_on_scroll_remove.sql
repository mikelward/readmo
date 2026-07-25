-- Sub-setting of "Mark Done as you scroll" (0064's `hide_on_scroll`): whether a
-- row the reader scrolled past is REMOVED from the list, or left in place
-- struck through until the list next re-materializes. Account intent like its
-- parent — a reader who wants one behavior wants it on every device — so it
-- lives here rather than staying device-local.
--
-- NULL = "not set", the client default (ON — remove, the behavior that shipped
-- before this column existed) applies. Same convention as every other column in
-- this table; see 0064 for the row/RLS/grant design this extends.
--
-- Backwards compatible (guardrail #11): additive. A client predating this
-- column never selects or writes it; a client that has it feature-detects a
-- backend without it (42703/PGRST204, see lib/data/supabaseMappers
-- `isMissingSchemaError`) and keeps the sub-setting device-local until this
-- migration lands. Goes live via `make migrate`.

alter table public.user_settings
  add column if not exists hide_on_scroll_remove boolean;
