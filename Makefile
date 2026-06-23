IMPORT_MAP := supabase/functions/import_map.json

.PHONY: deploy deploy-discover deploy-refresh deploy-poll deploy-img deploy-fulltext migrate

## Run pending database migrations
migrate:
	supabase db push

## Deploy all Edge Functions (run migrate first to apply any schema changes)
deploy: migrate deploy-discover deploy-refresh deploy-poll deploy-img deploy-fulltext

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
