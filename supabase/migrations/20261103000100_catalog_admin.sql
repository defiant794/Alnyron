-- F2.1 catalog-model: the admin data layer for categories, items and media.
-- Storage path rules for the `media` bucket, a CHECK on items.external_links, `mylife`
-- reserved as a top-level slug, and the eight catalog admin RPCs. Additive: no data changes.
-- Like the page RPCs (0100), every RPC is SECURITY INVOKER: it runs under the caller's RLS,
-- so the admin cookie session is what authorises the write; no secret key is involved.

-- Storage: media object paths ---------------------------------------------------------------
-- Uploads land at items/{item id}/{random uuid}.{ext}: one folder per item, a server-chosen
-- file name (no user text, no traversal), and only the bucket's image types. Policies run as
-- the invoker, so `authenticated` needs EXECUTE (functions created by postgres have none, 0400).
create function private.media_path_valid(p_path text) returns boolean
language sql immutable set search_path = '' as $$
  select p_path ~ '^items/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|avif)$';
$$;
grant execute on function private.media_path_valid(text) to authenticated;
comment on function private.media_path_valid(text) is
  'True iff p_path is items/{uuid}/{uuid}.{jpg|jpeg|png|webp|avif} (lower-case hex): the only object names admins may write to the media bucket.';

-- Admins read the bucket's rows: storage.remove() and the Storage API's upload checks
-- (INSERT ... RETURNING) need a SELECT policy. Public URLs never read storage.objects.
create policy media_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'media' and (select private.is_admin()));

alter policy media_objects_insert on storage.objects
  with check (bucket_id = 'media' and (select private.is_admin()) and private.media_path_valid(name));

-- An update (e.g. a Storage API move) may not rename an object out of items/{uuid}/.
alter policy media_objects_update on storage.objects
  using (bucket_id = 'media' and (select private.is_admin()))
  with check (bucket_id = 'media' and (select private.is_admin()) and private.media_path_valid(name));

-- Items: external links -----------------------------------------------------------------------
-- The site renders these as links, so only known keys holding https URLs are stored: no
-- javascript:/data:/http: URLs, no markup characters, no non-string values. A CHECK cannot
-- hold a subquery, hence the helper; it runs as the writer, so `authenticated` needs EXECUTE.
create function private.external_links_valid(p_links jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_links) = 'object' then not exists (
      select 1 from jsonb_each(p_links) as e (key, value)
       where e.key <> all (array['website', 'demo', 'app_store', 'google_play', 'download'])
          or jsonb_typeof(e.value) <> 'string'
          or (e.value #>> '{}') !~ '^https://[^[:space:]<>"]+$'
          or char_length(e.value #>> '{}') > 2048)
    else false
  end;
$$;
grant execute on function private.external_links_valid(jsonb) to authenticated;
comment on function private.external_links_valid(jsonb) is
  'True iff p_links is an object whose keys are website/demo/app_store/google_play/download and whose values are https URL strings (no whitespace or <>", at most 2048 characters).';

alter table public.items
  add constraint items_external_links_valid check (private.external_links_valid(external_links));

-- Routes: `mylife` is the MyLife area's path, never a category or page slug ------------------
alter table public.routes
  drop constraint routes_slug_reserved,
  add constraint routes_slug_reserved check (slug <> all (array['admin', 'auth', 'api', 'da', 'en',
    'kontakt', 'contact', 'privatliv', 'privacy', 'mylife']));

-- Admin RPCs ------------------------------------------------------------------------------------
-- Error contract (the TS services map SQLSTATE + message): 42501 forbidden; P0002 *_not_found /
-- media_not_stored; P0001 missing_slugs / missing_translations / too_many_media; 22023
-- kind_required / category_required / invalid_media_path; constraint errors pass through
-- (23505 slug taken, 23514 by constraint name, 23503 unknown category).

-- payload: {id?, kind? (insert only, required there), featured?, nav_order?,
--           translations: {da: {title, description, seo_title, seo_description, slug?}, en: {...}}}
create function public.admin_save_category(payload jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_id     uuid;
  v_locale public.locale_code;
  v_tr     jsonb;
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  if v_id is null then
    if nullif(payload ->> 'kind', '') is null then
      raise exception 'kind_required' using errcode = '22023';
    end if;
    insert into public.categories (kind, status, featured, nav_order, updated_by)
    values ((payload ->> 'kind')::public.catalog_kind, 'draft',
            coalesce((payload ->> 'featured')::boolean, false),
            coalesce((payload ->> 'nav_order')::integer, 100),
            (select auth.uid()))
    returning id into v_id;
  else
    update public.categories c
       set featured   = coalesce((payload ->> 'featured')::boolean, c.featured),
           nav_order  = coalesce((payload ->> 'nav_order')::integer, c.nav_order),
           updated_by = (select auth.uid())
     where c.id = v_id;
    if not found then raise exception 'category_not_found' using errcode = 'P0002'; end if;
  end if;

  for v_locale, v_tr in
    select key::public.locale_code, value from jsonb_each(coalesce(payload -> 'translations', '{}'::jsonb))
  loop
    insert into public.category_translations (category_id, locale, title, description, seo_title, seo_description)
    values (v_id, v_locale,
            coalesce(v_tr ->> 'title', ''), coalesce(v_tr ->> 'description', ''),
            coalesce(v_tr ->> 'seo_title', ''), coalesce(v_tr ->> 'seo_description', ''))
    on conflict (category_id, locale) do update
      set title = excluded.title, description = excluded.description,
          seo_title = excluded.seo_title, seo_description = excluded.seo_description;

    if v_tr ? 'slug' then
      insert into public.routes (locale, slug, category_id) values (v_locale, v_tr ->> 'slug', v_id)
      on conflict (category_id, locale) where category_id is not null do update set slug = excluded.slug;
    end if;
  end loop;

  return v_id;
end;
$$;

create function public.admin_set_category_status(p_category_id uuid, p_status public.content_status) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.categories c where c.id = p_category_id) then
    raise exception 'category_not_found' using errcode = 'P0002';
  end if;
  if p_status = 'published'
     and (select count(*) from public.routes r where r.category_id = p_category_id) < 2 then
    raise exception 'missing_slugs' using errcode = 'P0001';
  end if;
  update public.categories c
     set status = p_status, updated_by = (select auth.uid())
   where c.id = p_category_id;
end;
$$;

-- payload: {id?, category_id (insert only), featured?, price_type?, price_amount?, price_currency?,
--           external_links?, translations: {da: {slug, title, summary, body_md, seo_title,
--           seo_description}, en: {...}}, media?: [{id, alt_da, alt_en, sort_order}]}
create function public.admin_save_item(payload jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_id       uuid;
  v_category uuid;
  v_locale   public.locale_code;
  v_tr       jsonb;
  v_media    jsonb;
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  if v_id is null then
    v_category := nullif(payload ->> 'category_id', '')::uuid;
    if v_category is null then
      raise exception 'category_required' using errcode = '22023';
    end if;
    insert into public.items
      (category_id, status, sort_order, featured, price_type, price_amount, price_currency, external_links, updated_by)
    values (v_category, 'draft',
            coalesce((select max(i.sort_order) from public.items i where i.category_id = v_category), 0) + 10,
            coalesce((payload ->> 'featured')::boolean, false),
            (payload ->> 'price_type')::public.price_type,
            (payload ->> 'price_amount')::numeric,
            coalesce(payload ->> 'price_currency', 'DKK'),
            coalesce(nullif(payload -> 'external_links', 'null'::jsonb), '{}'::jsonb),
            (select auth.uid()))
    returning id into v_id;   -- 23503 when category_id names no category
  else
    -- A price/link key present in the payload replaces the column (JSON null clears it:
    -- SQL null for the price, the column default for currency and links); absent keeps it.
    -- category_id is fixed after insert.
    update public.items i
       set featured       = coalesce((payload ->> 'featured')::boolean, i.featured),
           price_type     = case when payload ? 'price_type'
                                 then (payload ->> 'price_type')::public.price_type else i.price_type end,
           price_amount   = case when payload ? 'price_amount'
                                 then (payload ->> 'price_amount')::numeric else i.price_amount end,
           price_currency = case when payload ? 'price_currency'
                                 then coalesce(payload ->> 'price_currency', 'DKK') else i.price_currency end,
           external_links = case when payload ? 'external_links'
                                 then coalesce(nullif(payload -> 'external_links', 'null'::jsonb), '{}'::jsonb)
                                 else i.external_links end,
           updated_by     = (select auth.uid())
     where i.id = v_id;
    if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  end if;

  for v_locale, v_tr in
    select key::public.locale_code, value from jsonb_each(coalesce(payload -> 'translations', '{}'::jsonb))
  loop
    insert into public.item_translations
      (item_id, locale, slug, title, summary, body_md, seo_title, seo_description)
    values (v_id, v_locale, v_tr ->> 'slug',
            coalesce(v_tr ->> 'title', ''), coalesce(v_tr ->> 'summary', ''), coalesce(v_tr ->> 'body_md', ''),
            coalesce(v_tr ->> 'seo_title', ''), coalesce(v_tr ->> 'seo_description', ''))
    on conflict (item_id, locale) do update
      set slug = excluded.slug, title = excluded.title, summary = excluded.summary,
          body_md = excluded.body_md, seo_title = excluded.seo_title,
          seo_description = excluded.seo_description;   -- 23505 item_translations_locale_slug_key = slug taken
  end loop;

  for v_media in select value from jsonb_array_elements(coalesce(payload -> 'media', '[]'::jsonb))
  loop
    update public.media m
       set alt_da     = coalesce(v_media ->> 'alt_da', m.alt_da),
           alt_en     = coalesce(v_media ->> 'alt_en', m.alt_en),
           sort_order = coalesce((v_media ->> 'sort_order')::integer, m.sort_order)
     where m.id = (v_media ->> 'id')::uuid and m.item_id = v_id;
    if not found then raise exception 'media_not_found' using errcode = 'P0002'; end if;
  end loop;

  return v_id;
end;
$$;

create function public.admin_set_item_status(p_item_id uuid, p_status public.content_status) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.items i where i.id = p_item_id) then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  if p_status = 'published' and not (
       exists (select 1 from public.item_translations t where t.item_id = p_item_id and t.locale = 'da')
       and exists (select 1 from public.item_translations t where t.item_id = p_item_id and t.locale = 'en')) then
    raise exception 'missing_translations' using errcode = 'P0001';
  end if;
  update public.items i
     set status       = p_status,
         published_at = case when p_status = 'published' then coalesce(i.published_at, now()) else i.published_at end,
         updated_by   = (select auth.uid())
   where i.id = p_item_id;
end;
$$;

create function public.admin_reorder_items(p_category_id uuid, p_item_ids uuid[]) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.categories c where c.id = p_category_id) then
    raise exception 'category_not_found' using errcode = 'P0002';
  end if;
  update public.items i
     set sort_order = (o.ord * 10)::integer, updated_by = (select auth.uid())
    from unnest(p_item_ids) with ordinality as o (id, ord)
   where i.id = o.id and i.category_id = p_category_id;
end;
$$;

create function public.admin_delete_item(p_item_id uuid) returns text[]
language plpgsql security invoker set search_path = '' as $$
declare
  v_paths text[];
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The row lock keeps admin_attach_media (which locks the item too) from adding a media
  -- row between reading the paths and the delete: its object would never be removed.
  perform 1 from public.items i where i.id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;

  select coalesce(array_agg(m.storage_path order by m.sort_order, m.created_at), '{}')
    into v_paths
    from public.media m
   where m.item_id = p_item_id;

  delete from public.items i where i.id = p_item_id;   -- cascades to item_translations + media
  return v_paths;
end;
$$;

create function public.admin_attach_media(p_item_id uuid, p_path text, p_alt_da text, p_alt_en text,
                                          p_width integer, p_height integer) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid;
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not coalesce(private.media_path_valid(p_path) and split_part(p_path, '/', 2) = p_item_id::text, false) then
    raise exception 'invalid_media_path' using errcode = '22023';
  end if;
  -- Locked so two concurrent attaches cannot both pass the 8-image limit.
  perform 1 from public.items i where i.id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = p_path) then
    raise exception 'media_not_stored' using errcode = 'P0002';
  end if;
  if (select count(*) from public.media m where m.item_id = p_item_id) >= 8 then
    raise exception 'too_many_media' using errcode = 'P0001';
  end if;

  insert into public.media (item_id, storage_path, alt_da, alt_en, width, height, mime_type, sort_order)
  values (p_item_id, p_path, p_alt_da, coalesce(p_alt_en, ''), p_width, p_height,
          case substring(p_path from '\.([a-z]+)$')
            when 'jpg'  then 'image/jpeg'
            when 'jpeg' then 'image/jpeg'
            when 'png'  then 'image/png'
            when 'webp' then 'image/webp'
            when 'avif' then 'image/avif'
          end,
          coalesce((select max(m.sort_order) from public.media m where m.item_id = p_item_id), 0) + 10)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.admin_detach_media(p_media_id uuid) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  v_path text;
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.media m where m.id = p_media_id returning m.storage_path into v_path;
  if not found then raise exception 'media_not_found' using errcode = 'P0002'; end if;
  return v_path;
end;
$$;

revoke execute on function public.admin_save_category(jsonb),
                           public.admin_set_category_status(uuid, public.content_status),
                           public.admin_save_item(jsonb),
                           public.admin_set_item_status(uuid, public.content_status),
                           public.admin_reorder_items(uuid, uuid[]),
                           public.admin_delete_item(uuid),
                           public.admin_attach_media(uuid, text, text, text, integer, integer),
                           public.admin_detach_media(uuid) from public, anon;
grant  execute on function public.admin_save_category(jsonb),
                           public.admin_set_category_status(uuid, public.content_status),
                           public.admin_save_item(jsonb),
                           public.admin_set_item_status(uuid, public.content_status),
                           public.admin_reorder_items(uuid, uuid[]),
                           public.admin_delete_item(uuid),
                           public.admin_attach_media(uuid, text, text, text, integer, integer),
                           public.admin_detach_media(uuid) to authenticated;

comment on function public.admin_save_category(jsonb) is
  'Creates (no id: draft, nav_order 100, kind required -> 22023 kind_required) or updates a category (featured/nav_order coalesced, kind fixed) and upserts each given locale''s translation and, when the locale has a slug key, its route. P0002 category_not_found; 23505 slug taken; 23514 routes_slug_format / routes_slug_reserved / category_translations_da_title.';
comment on function public.admin_set_category_status(uuid, public.content_status) is
  'Publishes or unpublishes a category. Publishing needs a DA and an EN route (P0001 missing_slugs). The public still sees it only once it holds a published item (private.category_is_public). P0002 category_not_found.';
comment on function public.admin_save_item(jsonb) is
  'Creates (no id: draft, sort_order = category max + 10, category_id required -> 22023 category_required, unknown -> 23503) or updates an item: price/link keys present in the payload replace the column, absent keys keep it; category_id is fixed. Upserts each given locale''s translation and updates alt/sort_order of the listed media of this item (P0002 media_not_found otherwise). P0002 item_not_found; 23505 slug taken; 23514 by constraint name.';
comment on function public.admin_set_item_status(uuid, public.content_status) is
  'Publishes or unpublishes an item. Publishing needs a DA and an EN translation (P0001 missing_translations) and stamps published_at on the first publish only. P0002 item_not_found.';
comment on function public.admin_reorder_items(uuid, uuid[]) is
  'Sets sort_order = 10 * position for the given items of the category (first id first); ids of other categories are ignored. P0002 category_not_found.';
comment on function public.admin_delete_item(uuid) is
  'Deletes an item with its translations and media rows and returns the media storage paths (ordered by sort_order, ''{}'' when none) for the caller to remove from the media bucket. P0002 item_not_found.';
comment on function public.admin_attach_media(uuid, text, text, text, integer, integer) is
  'Attaches an uploaded media-bucket object to an item: path items/{p_item_id}/{uuid}.{ext} (22023 invalid_media_path), object present (P0002 media_not_stored), at most 8 per item (P0001 too_many_media, item row locked). mime_type from the extension, sort_order = max + 10. P0002 item_not_found; 23514 media_alt_da_check / media_width_check / media_height_check; 23505 media_storage_path_key.';
comment on function public.admin_detach_media(uuid) is
  'Deletes a media row and returns its storage_path for the caller to remove from the media bucket. P0002 media_not_found.';
