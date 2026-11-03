-- F2.1 catalog-model (code review 5): an already-attached path is a duplicate, never a refused
-- upload, and the updated_by triggers are the column's only writer.
--
-- admin_attach_media: the media_limit_per_item trigger (P0001) and the media CHECKs (23514) fire
-- before the unique index on media.storage_path, so re-attaching a path that a row already holds
-- (a double-submitted 8th image, or a full item) failed with P0001 instead of 23505. The service
-- removes the object of a P0001/23514 attach, which deleted the file the existing row shows. The
-- RPC now checks for that row itself, under the item lock, before any other check of the object:
-- 23505 media_storage_path_key means "already attached, keep the object". The lock makes the
-- check reliable: a path names its item's folder (media_storage_path_valid), so every attach of
-- that path, through this RPC or a direct insert (media_limit_per_item locks the item too), waits
-- for this transaction and then sees its row.
--
-- updated_by: the items_updated_by / categories_updated_by triggers (20261103000300, 0400) always
-- overwrite the column, so the RPCs no longer write it. Behaviour is unchanged.
--
-- Same signatures as before: `create or replace` keeps the owner and the grants, which are
-- restated below anyway so this file alone shows who may call the functions.

-- payload: {id?, kind? (insert only, required there), featured?, nav_order?,
--           translations: {da: {title, description, seo_title, seo_description, slug?}, en: {...}}}
create or replace function public.admin_save_category(payload jsonb) returns uuid
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
    insert into public.categories (kind, status, featured, nav_order)
    values ((payload ->> 'kind')::public.catalog_kind, 'draft',
            coalesce((payload ->> 'featured')::boolean, false),
            coalesce((payload ->> 'nav_order')::integer, 100))
    returning id into v_id;
  else
    update public.categories c
       set featured  = coalesce((payload ->> 'featured')::boolean, c.featured),
           nav_order = coalesce((payload ->> 'nav_order')::integer, c.nav_order)
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

create or replace function public.admin_set_category_status(p_category_id uuid, p_status public.content_status) returns void
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
     set status = p_status
   where c.id = p_category_id;
end;
$$;

-- payload: {id?, category_id (insert only), featured?, price_type?, price_amount?, price_currency?,
--           external_links?, translations: {da: {slug, title, summary, body_md, seo_title,
--           seo_description}, en: {...}}, media?: [{id, alt_da, alt_en, sort_order}]}
create or replace function public.admin_save_item(payload jsonb) returns uuid
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
  -- An item holds at most 8 images, so a longer media list cannot name only its own.
  if jsonb_array_length(coalesce(payload -> 'media', '[]'::jsonb)) > 8 then
    raise exception 'too_many_media' using errcode = 'P0001';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  if v_id is null then
    v_category := nullif(payload ->> 'category_id', '')::uuid;
    if v_category is null then
      raise exception 'category_required' using errcode = '22023';
    end if;
    insert into public.items
      (category_id, status, sort_order, featured, price_type, price_amount, price_currency, external_links)
    values (v_category, 'draft',
            coalesce((select max(i.sort_order) from public.items i where i.category_id = v_category), 0) + 10,
            coalesce((payload ->> 'featured')::boolean, false),
            (payload ->> 'price_type')::public.price_type,
            (payload ->> 'price_amount')::numeric,
            coalesce(payload ->> 'price_currency', 'DKK'),
            coalesce(nullif(payload -> 'external_links', 'null'::jsonb), '{}'::jsonb))
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
                                 else i.external_links end
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

create or replace function public.admin_set_item_status(p_item_id uuid, p_status public.content_status) returns void
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
         published_at = case when p_status = 'published' then coalesce(i.published_at, now()) else i.published_at end
   where i.id = p_item_id;
end;
$$;

create or replace function public.admin_reorder_items(p_category_id uuid, p_item_ids uuid[]) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if cardinality(p_item_ids) > 1000 then
    raise exception 'too_many_items' using errcode = '22023';
  end if;
  if not exists (select 1 from public.categories c where c.id = p_category_id) then
    raise exception 'category_not_found' using errcode = 'P0002';
  end if;
  update public.items i
     set sort_order = (o.ord * 10)::integer
    from unnest(p_item_ids) with ordinality as o (id, ord)
   where i.id = o.id and i.category_id = p_category_id;
end;
$$;

-- Same checks as 20261103000300, plus the already-attached check right after the item lock.
create or replace function public.admin_attach_media(p_item_id uuid, p_path text, p_alt_da text, p_alt_en text,
                                                     p_width integer, p_height integer) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_id          uuid;
  v_mime_type   text;
  v_stored_type text;
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not coalesce(private.media_path_valid(p_path) and split_part(p_path, '/', 2) = p_item_id::text, false) then
    raise exception 'invalid_media_path' using errcode = '22023';
  end if;
  -- Locked before the duplicate check and sort_order are read: concurrent attaches of one item
  -- queue here, so a repeated path sees the earlier row and positions are distinct.
  perform 1 from public.items i where i.id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  -- A row already holds this object: report the duplicate before the limit trigger or a CHECK
  -- can refuse the insert, since those errors tell the caller the upload is unusable.
  if exists (select 1 from public.media m where m.storage_path = p_path) then
    raise exception 'media_storage_path_key' using errcode = '23505';
  end if;

  select o.metadata ->> 'mimetype' into v_stored_type
    from storage.objects o
   where o.bucket_id = 'media' and o.name = p_path;
  if not found then
    raise exception 'media_not_stored' using errcode = 'P0002';
  end if;
  v_mime_type := private.media_mime_type(p_path);
  -- Content types are case-insensitive (RFC 9110); the bucket only accepts the four image types.
  if v_stored_type is not null and lower(btrim(v_stored_type)) <> v_mime_type then
    raise exception 'media_type_mismatch' using errcode = '22023';
  end if;

  insert into public.media (item_id, storage_path, alt_da, alt_en, width, height, mime_type, sort_order)
  values (p_item_id, p_path, p_alt_da, coalesce(p_alt_en, ''), p_width, p_height, v_mime_type,
          coalesce((select max(m.sort_order) from public.media m where m.item_id = p_item_id), 0) + 10)
  returning id into v_id;   -- P0001 too_many_media from media_limit_per_item
  return v_id;
end;
$$;

revoke execute on function public.admin_save_category(jsonb),
                           public.admin_set_category_status(uuid, public.content_status),
                           public.admin_save_item(jsonb),
                           public.admin_set_item_status(uuid, public.content_status),
                           public.admin_reorder_items(uuid, uuid[]),
                           public.admin_attach_media(uuid, text, text, text, integer, integer) from public, anon;
grant  execute on function public.admin_save_category(jsonb),
                           public.admin_set_category_status(uuid, public.content_status),
                           public.admin_save_item(jsonb),
                           public.admin_set_item_status(uuid, public.content_status),
                           public.admin_reorder_items(uuid, uuid[]),
                           public.admin_attach_media(uuid, text, text, text, integer, integer) to authenticated;

comment on function public.admin_save_category(jsonb) is
  'Creates (no id: draft, nav_order 100, kind required -> 22023 kind_required) or updates a category (featured/nav_order coalesced, kind fixed) and upserts each given locale''s translation and, when the locale has a slug key, its route. P0002 category_not_found; 23505 slug taken; 23514 routes_slug_format / routes_slug_reserved / category_translations_da_title. updated_by is set by the categories_updated_by trigger.';
comment on function public.admin_set_category_status(uuid, public.content_status) is
  'Publishes or unpublishes a category. Publishing needs a DA and an EN route (P0001 missing_slugs). The public still sees it only once it holds a published item (private.category_is_public). P0002 category_not_found. updated_by is set by the categories_updated_by trigger.';
comment on function public.admin_save_item(jsonb) is
  'Creates (no id: draft, sort_order = category max + 10, category_id required -> 22023 category_required, unknown -> 23503) or updates an item: price/link keys present in the payload replace the column, absent keys keep it; category_id is fixed. Upserts each given locale''s translation and updates alt/sort_order of the listed media of this item (at most 8 entries -> P0001 too_many_media; P0002 media_not_found otherwise). P0002 item_not_found; 23505 slug taken; 23514 by constraint name. updated_by is set by the items_updated_by trigger.';
comment on function public.admin_set_item_status(uuid, public.content_status) is
  'Publishes or unpublishes an item. Publishing needs a DA and an EN translation (P0001 missing_translations) and stamps published_at on the first publish only. P0002 item_not_found. updated_by is set by the items_updated_by trigger.';
comment on function public.admin_reorder_items(uuid, uuid[]) is
  'Sets sort_order = 10 * position for the given items of the category (first id first, at most 1000 ids -> 22023 too_many_items); ids of other categories are ignored. P0002 category_not_found. updated_by is set by the items_updated_by trigger.';
comment on function public.admin_attach_media(uuid, text, text, text, integer, integer) is
  'Attaches an uploaded media-bucket object to an item: path items/{p_item_id}/{uuid}.{ext} (22023 invalid_media_path), item present (P0002 item_not_found, row locked), path not attached yet (23505 media_storage_path_key, checked before the rules below, so an attached object comes back as a duplicate, not as a refused upload), object present (P0002 media_not_stored), its recorded metadata mimetype, when present, equal to the extension''s type (22023 media_type_mismatch), at most 8 per item (P0001 too_many_media, from the media_limit_per_item trigger). mime_type from the extension, sort_order = max + 10. 23514 media_alt_da_check / media_alt_da_length / media_alt_en_length / media_width_check / media_height_check.';
