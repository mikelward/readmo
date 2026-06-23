IMPORT_MAP := supabase/functions/import_map.json

.PHONY: deploy deploy-discover deploy-refresh deploy-poll deploy-img deploy-fulltext deploy-notify-signup migrate

## Run pending database migrations
migrate:
	supabase db push

## Deploy all Edge Functions (run migrate first to apply any schema changes)
deploy: migrate deploy-discover deploy-refresh deploy-poll deploy-img deploy-fulltext deploy-notify-signup

deploy-discover:
	supabase functions deploy discover --import-map $(IMPORT_MAP)

deploy-refresh:
	supabase functions deploy refresh --import-map $(IMPORT_MAP)

deploy-poll:
	supabase functions deploy poll --import-map $(IMPORT_MAP) --no-verify-jwt

deploy-img:
	supabase functions deploy img --import-map $(IMPORT_MAP) --no-verify-jwt

deploy-fulltext:
	supabase functions deploy fulltext --import-map $(IMPORT_MAP)

# Server-to-server (called by the auth.users trigger, verifies the bearer
# itself), so deploy with --no-verify-jwt like poll.
deploy-notify-signup:
	supabase functions deploy notify-signup --import-map $(IMPORT_MAP) --no-verify-jwt
