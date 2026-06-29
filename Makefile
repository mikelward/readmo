IMPORT_MAP := supabase/functions/import_map.json

.PHONY: deploy deploy-discover deploy-refresh deploy-poll deploy-img deploy-fulltext deploy-notify-signup deploy-db-perf migrate check-link set-build

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

## Set the READMO_BUILD secret to the commit count (the same build number the
## client stamps as x-readmo-build; see vite.config.ts). The Edge Functions read
## it to version their outbound User-Agent (_shared/version.ts); unset → they
## fall back to the unversioned UA. Unshallow first so a shallow CI checkout
## doesn't undercount, mirroring vite.config.ts.
set-build: check-link
	@if [ "$$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then \
	  echo "Repo is shallow; unshallowing for an accurate commit count..."; \
	  git fetch --unshallow >/dev/null 2>&1 || git fetch --depth=2147483647 >/dev/null 2>&1 || true; \
	fi; \
	build=$$(git rev-list --count HEAD 2>/dev/null); \
	if [ -z "$$build" ]; then \
	  echo "ERROR: could not compute the commit count (is this a git checkout?)."; \
	  exit 1; \
	fi; \
	echo "Setting READMO_BUILD=$$build"; \
	supabase secrets set READMO_BUILD=$$build

## Deploy all Edge Functions (run migrate first to apply any schema changes, and
## refresh the READMO_BUILD secret so the outbound User-Agent carries this build)
deploy: migrate set-build deploy-discover deploy-refresh deploy-poll deploy-img deploy-fulltext deploy-notify-signup deploy-db-perf

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

# Read-only DB performance diagnostics. Called server-to-server by the operator
# / a Grafana alert with the service-role bearer (verified in-handler), so
# deploy with --no-verify-jwt like poll.
deploy-db-perf: check-link
	supabase functions deploy db-perf --import-map $(IMPORT_MAP) --no-verify-jwt
