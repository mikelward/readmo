IMPORT_MAP := supabase/functions/import_map.json

.PHONY: deploy deploy-discover deploy-refresh deploy-poll deploy-img

## Deploy all Edge Functions
deploy: deploy-discover deploy-refresh deploy-poll deploy-img

deploy-discover:
	supabase functions deploy discover --import-map $(IMPORT_MAP)

deploy-refresh:
	supabase functions deploy refresh --import-map $(IMPORT_MAP)

deploy-poll:
	supabase functions deploy poll --import-map $(IMPORT_MAP)

deploy-img:
	supabase functions deploy img --import-map $(IMPORT_MAP) --no-verify-jwt
