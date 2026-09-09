-- Regression test for 0068_shared_public_items.sql — shared /item/<id> links.
--
-- Proves the capability-by-URL model: get_shared_item resolves a PUBLIC feed's
-- item for a NON-subscriber (who presents the item's uuid) while returning
-- nothing for a private/tokenized feed, AND that we did NOT widen the row
-- policies (a non-subscriber still can't `select` the item/feed directly). Plain
-- SQL (no pgTAP): each check raises NOTICE 'PASS …' on success and an EXCEPTION
-- on failure, so `psql -v ON_ERROR_STOP=1` makes it a hard gate. Mirrors the
-- style of access_rpcs.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/shared_public_items.sql

-- --- Fresh fixtures (cascades clean up any prior run) -----------------------
delete from auth.users where id = '33333333-3333-3333-3333-333333333333';
delete from public.feeds where id in (
  'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',   -- public
  'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2',   -- tokenized url (private)
  'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3');  -- secret_url-backed (private)

insert into auth.users (id) values
  ('33333333-3333-3333-3333-333333333333');  -- a signed-in user who subscribes to NOTHING

-- Public feed (plain url, no token) + item.
insert into public.feeds (id, url, site_url, title, favicon_url) values
  ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
   'https://public.example/feed.xml', 'https://public.example', 'Public Feed',
   'https://public.example/icon.png');
insert into public.items (id, feed_id, guid, url, title, content_html) values
  ('11aa11aa-11aa-11aa-11aa-11aa11aa11aa',
   'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'g-pub',
   'https://public.example/story', 'Public Story', '<p>public body</p>');

-- Private feed by a tokenized url (long high-entropy path segment) + item.
insert into public.feeds (id, url, site_url, title) values
  ('b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2',
   'https://paid.example/feed/0123456789abcdef0123456789abcdef/rss.xml',
   'https://paid.example', 'Paid Feed');
insert into public.items (id, feed_id, guid, url, title, content_html) values
  ('22bb22bb-22bb-22bb-22bb-22bb22bb22bb',
   'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2', 'g-paid',
   'https://paid.example/story', 'Paid Story', '<p>paid body</p>');

-- Private feed by a secret_url (public url present but the fetch url is tokenized).
insert into public.feeds (id, url, secret_url, site_url, title) values
  ('c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3',
   'https://news.example/feed', 'https://news.example/feed?token=XYZ',
   'https://news.example', 'Secret-backed Feed');
insert into public.items (id, feed_id, guid, url, title) values
  ('33cc33cc-33cc-33cc-33cc-33cc33cc33cc',
   'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3', 'g-secret',
   'https://news.example/story', 'Secret Story');

-- ===== Test 1: looks_tokenized classifies representative URLs ===============
do $$
begin
  -- Public shapes → false.
  if public.looks_tokenized('https://public.example/feed.xml') then
    raise exception 'FAIL T1a: plain feed url flagged tokenized'; end if;
  if public.looks_tokenized('https://example.com/2024/01/my-article-title') then
    raise exception 'FAIL T1b: readable slug path flagged tokenized'; end if;
  -- Tokenized shapes → true.
  if not public.looks_tokenized('https://x.example/feed?token=abcdef') then
    raise exception 'FAIL T1c: query string not flagged'; end if;
  if not public.looks_tokenized('https://user:pass@x.example/feed') then
    raise exception 'FAIL T1d: embedded credentials not flagged'; end if;
  if not public.looks_tokenized('https://x.example/f/0123456789abcdef0123456789abcdef') then
    raise exception 'FAIL T1e: long hex path segment not flagged'; end if;
  if not public.looks_tokenized('ftp://x.example/feed') then
    raise exception 'FAIL T1f: non-http scheme not flagged'; end if;
  if not public.looks_tokenized(null) then
    raise exception 'FAIL T1g: null url not flagged'; end if;
  -- A long percent-encoded path segment (e.g. a foreign-language slug) must NOT
  -- be treated as tokenized — it decodes to readable text, so blanket-rejecting
  -- raw %xx would wrongly hide foreign-language feeds. (Accepted residual: an
  -- encoded ASCII token could slip — unrealistic; soft gate + uuid boundary.)
  if public.looks_tokenized('https://x.example/%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF/story') then
    raise exception 'FAIL T1h: long encoded (foreign) slug wrongly flagged private'; end if;
  if public.looks_tokenized('https://x.example/caf%C3%A9/story') then
    raise exception 'FAIL T1i: short encoded slug wrongly flagged'; end if;
  raise notice 'PASS T1: looks_tokenized classifies public vs tokenized URLs';
end $$;

-- ===== Test 2: a non-subscriber still cannot SEE the item/feed directly =====
-- (Proves 0068 did NOT widen items_select / feeds_select.)
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  set local role authenticated;
  select count(*) into n from public.items where id='11aa11aa-11aa-11aa-11aa-11aa11aa11aa';
  if n <> 0 then raise exception 'FAIL T2a: public item visible via items_select without subscribing'; end if;
  select count(*) into n from public.feeds where id='a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1';
  if n <> 0 then raise exception 'FAIL T2b: public feed visible via feeds_select without subscribing'; end if;
  raise notice 'PASS T2: row policies unchanged — no direct visibility for a non-subscriber';
end $$;

-- ===== Test 3: get_shared_item resolves the PUBLIC item for a non-subscriber =
do $$
declare r record; n int;
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  set local role authenticated;
  select count(*) into n from public.get_shared_item('11aa11aa-11aa-11aa-11aa-11aa11aa11aa');
  if n <> 1 then raise exception 'FAIL T3a: get_shared_item returned % rows for the public item', n; end if;
  select * into r from public.get_shared_item('11aa11aa-11aa-11aa-11aa-11aa11aa11aa');
  if r.content_html is null or r.content_html <> '<p>public body</p>' then
    raise exception 'FAIL T3b: shared item body not returned'; end if;
  if r.feed_title <> 'Public Feed' or r.feed_favicon_url <> 'https://public.example/icon.png' then
    raise exception 'FAIL T3c: shared feed metadata not returned'; end if;
  raise notice 'PASS T3: get_shared_item resolves the public item + feed metadata';
end $$;

-- ===== Test 4: get_shared_item returns NOTHING for private/tokenized feeds ==
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  set local role authenticated;
  select count(*) into n from public.get_shared_item('22bb22bb-22bb-22bb-22bb-22bb22bb22bb');
  if n <> 0 then raise exception 'FAIL T4a: tokenized-url feed item resolved (% rows)', n; end if;
  select count(*) into n from public.get_shared_item('33cc33cc-33cc-33cc-33cc-33cc33cc33cc');
  if n <> 0 then raise exception 'FAIL T4b: secret_url-backed feed item resolved (% rows)', n; end if;
  raise notice 'PASS T4: get_shared_item withholds private/tokenized feed items';
end $$;

-- ===== Test 5: get_shared_item exposes no copyright-gated columns ===========
-- Structural guard: the function's result type must not carry full_content_html
-- or ai_summary, so a caller can never read them through this path.
do $$
declare n int;
begin
  select count(*) into n
  from information_schema.routines r
  join information_schema.parameters p
    on p.specific_name = r.specific_name
  where r.routine_schema = 'public'
    and r.routine_name = 'get_shared_item'
    and p.parameter_mode = 'OUT'
    and p.parameter_name in ('full_content_html', 'ai_summary');
  if n <> 0 then raise exception 'FAIL T5: get_shared_item exposes a gated column'; end if;
  raise notice 'PASS T5: get_shared_item returns no full_content_html / ai_summary';
end $$;

-- ===== Test 6: get_capabilities advertises shared_items = true ==============
-- The client feature-detects the deployed backend on this flag; the reader hands
-- out /item/:id links only when it's true (else the publisher URL).
do $$
declare v boolean;
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  set local role authenticated;
  select shared_items into v from public.get_capabilities();
  if v is not true then raise exception 'FAIL T6: get_capabilities.shared_items not TRUE'; end if;
  raise notice 'PASS T6: get_capabilities reports shared_items = true';
end $$;

reset role;
