IMPORT_MAP := supabase/functions/import_map.json

.PHONY: deploy deploy-discover deploy-refresh deploy-poll deploy-img deploy-fulltext deploy-summary deploy-newshacker-sync deploy-notify-signup deploy-db-perf migrate set-build check-link

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

## Set the build-number secret the Edge Functions stamp into their outbound
## User-Agent (`Readmo/<build>`), using the SAME commit-count scheme the client
## uses (buildInfo.commitCount / x-readmo-build). Unshallow first if needed so
## the count is accurate (the client's vite.config.ts does the same). Read by
## `readmoBuildNumber()` in _shared/ssrf.ts; `0` until this is set.
set-build: check-link
	@if [ "$$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then \
	  git fetch --unshallow >/dev/null 2>&1 || true; fi
	supabase secrets set READMO_BUILD=$$(git rev-list --count HEAD)

## Deploy all Edge Functions (run migrate first to apply any schema changes,
## and stamp the current build number into the functions' outbound User-Agent)
deploy: migrate set-build deploy-discover deploy-refresh deploy-poll deploy-img deploy-fulltext deploy-summary deploy-newshacker-sync deploy-notify-signup deploy-db-perf

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

# AI article summaries. Browser-invoked with the caller's JWT (verified for the
# allowlist gate), so deploy WITH jwt verification like fulltext. The DB pin
# trigger (0053) also calls it with the service-role key as bearer — that key is
# a project-signed JWT, so it passes verification too; no --no-verify-jwt
# needed. Needs the GOOGLE_API_KEY secret set (see SETUP.md) to actually
# generate.
deploy-summary: check-link
	supabase functions deploy summary --import-map $(IMPORT_MAP)

# Mirror HN dismissals to newshacker. Browser-invoked with the caller's JWT
# (verified to identify the user before reading their link token), so deploy
# WITH jwt verification like summary.
deploy-newshacker-sync: check-link
	supabase functions deploy newshacker-sync --import-map $(IMPORT_MAP)

# Server-to-server (called by the auth.users trigger, verifies the bearer
# itself), so deploy with --no-verify-jwt like poll.
deploy-notify-signup: check-link
	supabase functions deploy notify-signup --import-map $(IMPORT_MAP) --no-verify-jwt

# Read-only DB performance diagnostics. Called server-to-server by the operator
# / a Grafana alert with the service-role bearer (verified in-handler), so
# deploy with --no-verify-jwt like poll.
deploy-db-perf: check-link
	supabase functions deploy db-perf --import-map $(IMPORT_MAP) --no-verify-jwt
