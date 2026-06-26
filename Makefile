IMPORT_MAP := supabase/functions/import_map.json

.PHONY: deploy deploy-discover deploy-refresh deploy-poll deploy-img deploy-fulltext deploy-notify-signup migrate check-link

# Fail fast unless we're sitting in the linked project. Without a local
# supabase/config.toml the CLI silently walks up the tree and resolves a
# stray project (e.g. one accidentally linked from $HOME), then deploys/
# migrates against the wrong workdir — see SETUP.md §2.
check-link:
	@test -f supabase/config.toml || { \
	  echo "ERROR: supabase/config.toml not found in $(CURDIR)."; \
	  echo "Run 'supabase link --project-ref <ref>' from the repo root (not \$$HOME),"; \
	  echo "then re-run from here. See SETUP.md §2."; \
	  exit 1; }

## Run pending database migrations
migrate: check-link
	supabase db push

## Deploy all Edge Functions (run migrate first to apply any schema changes)
deploy: migrate deploy-discover deploy-refresh deploy-poll deploy-img deploy-fulltext deploy-notify-signup

deploy-discover: check-link
	supabase functions deploy discover --import-map $(IMPORT_MAP)

deploy-refresh: check-link
	supabase functions deploy refresh --import-map $(IMPORT_MAP)

deploy-poll: check-link
	supabase functions deploy poll --import-map $(IMPORT_MAP) --no-verify-jwt

deploy-img: check-link
	supabase functions deploy img --import-map $(IMPORT_MAP) --no-verify-jwt

deploy-fulltext: check-link
	supabase functions deploy fulltext --import-map $(IMPORT_MAP)

# Server-to-server (called by the auth.users trigger, verifies the bearer
# itself), so deploy with --no-verify-jwt like poll.
deploy-notify-signup: check-link
	supabase functions deploy notify-signup --import-map $(IMPORT_MAP) --no-verify-jwt
