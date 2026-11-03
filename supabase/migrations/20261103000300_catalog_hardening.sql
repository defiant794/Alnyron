-- F2.1 catalog-model (security review): the catalog rules hold for every writer, not only
-- for the admin RPCs. An admin session can also reach public.media / public.items /
-- public.categories through PostgREST DML, so the media path, type, alt length and
-- 8-image limit are table rules here, and updated_by is stamped by a trigger. Adds the
-- upload pre-check and the orphan listing RPCs, and bounds the RPCs' array inputs.
-- Every RPC stays SECURITY INVOKER (RLS + private.is_admin() authorise the write).
-- Existing rows: none violate the new CHECKs (ADD CONSTRAINT validates them).

-- Media: path and type ----------------------------------------------------------------------
-- The type an object name implies: jpg/jpeg -> image/jpeg, png, webp, avif; null otherwise.
-- One mapping for the CHECK below and admin_attach_media. CHECK expressions run as the
-- writer, so `authenticated` needs EXECUTE (functions created by postgres have none, 0400).
create function private.media_mime_type(p_path text) returns text
language sql immutable set search_path = '' as $$
  select case substring(p_path from '\.([a-z]+)$')
           when 'jpg'  then 'image/jpeg'
           when 'jpeg' then 'image/jpeg'
           when 'png'  then 'image/png'
           when 'webp' then 'image/webp'
           when 'avif' then 'image/avif'
         end;
$$;
grant execute on function private.media_mime_type(text) to authenticated;
comment on function private.media_mime_type(text) is
  'The media type an object name''s extension implies (jpg/jpeg -> image/jpeg, png -> image/png, webp -> image/webp, avif -> image/avif), null for any other name.';

-- A row names an object in its own item's folder (items/{item_id}/{uuid}.{ext}): no other
-- prefix, no traversal, no URL, and an UPDATE cannot re-point a row to another item without
-- also naming a path in that item's folder. mime_type is the extension's type.
alter table public.media
  add constraint media_storage_path_valid
    check (private.media_path_valid(storage_path) and split_part(storage_path, '/', 2) = item_id::text),
  add constraint media_mime_matches_path
    check (coalesce(mime_type = private.media_mime_type(storage_path), false)),
  add constraint media_alt_da_length check (char_length(alt_da) <= 300),
  add constraint media_alt_en_length check (char_length(alt_en) <= 300);

-- Media: at most 8 images per item -------------------------------------------------------------
-- The single source of the limit for every insert (admin_attach_media or direct DML) and for an
-- update that moves a row to another item. The item row is locked first, so concurrent inserts
-- for one item queue up and each counts the rows committed before it (READ COMMITTED: every
-- statement of the function takes a new snapshot). Runs as the writer, before RLS: an admin
-- (or a BYPASSRLS role) locks the item and counts every row. A row it cannot lock belongs to an
-- unknown item (the foreign key refuses it, 23503) or a writer the items UPDATE policy rejects
-- (the media RLS policies refuse it, 42501), so the count is skipped and that error stands.
create function private.media_limit_per_item() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.item_id = old.item_id then
    return new;
  end if;
  perform 1 from public.items i where i.id = new.item_id for update;
  if not found then
    return new;
  end if;
  if (select count(*) from public.media m where m.item_id = new.item_id) >= 8 then
    raise exception 'too_many_media' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
comment on function private.media_limit_per_item() is
  'Trigger: refuses a media insert, or an update moving a row to another item, when that item already has 8 media rows (P0001 too_many_media). Locks the item row first so concurrent inserts cannot both pass.';

create trigger media_limit_per_item before insert or update of item_id on public.media
  for each row execute function private.media_limit_per_item();

-- updated_by: authoritative trigger ----------------------------------------------------------
-- The trigger, not the writer, decides updated_by: it is always the caller's auth.uid()
-- (null for a writer without a user JWT: migrations, postgres, the auth service clearing the
-- column when a user is deleted). A value in the INSERT/UPDATE (direct DML or an RPC) is
-- overwritten, so the column cannot be spoofed. Trigger functions are not EXECUTE-checked
-- when they fire, so this one has no grants.
create function private.stamp_updated_by() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_by := (select auth.uid());
  return new;
end;
$$;
comment on function private.stamp_updated_by() is
  'Trigger: sets updated_by to auth.uid() (null without a user JWT) on every insert and update, overriding any written value. Authoritative for categories.updated_by and items.updated_by.';

create trigger categories_updated_by before insert or update on public.categories
  for each row execute function private.stamp_updated_by();
create trigger items_updated_by before insert or update on public.items
  for each row execute function private.stamp_updated_by();

-- Admin RPCs ------------------------------------------------------------------------------------
-- New: admin_check_media_slot (the upload pre-check) and admin_list_orphan_media. Replaced with
-- the same signatures: admin_save_item (media array bound), admin_reorder_items (id array bound)
-- and admin_attach_media (the limit moves to the trigger; type mapping via media_mime_type).
-- `create or replace` keeps owner and grants; both are restated below anyway.

-- Checks, before a signed upload URL is issued, that the item exists and has room for another
-- image, so no object is uploaded for an unknown or full item. Advisory: the media trigger
-- enforces the limit at attach time.
create function public.admin_check_media_slot(p_item_id uuid) returns void
language plpgsql stable security invoker set search_path = '' as $$
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.items i where i.id = p_item_id) then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  if (select count(*) from public.media m where m.item_id = p_item_id) >= 8 then
    raise exception 'too_many_media' using errcode = 'P0001';
  end if;
end;
$$;

-- Objects in the media bucket that no media row references (an upload never attached, or one
-- whose row was deleted while its removal failed), older than p_older_than, oldest first, at
-- most 1000 (the Storage API's limit for one remove call). The caller removes them through the
-- Storage API, then calls again while the result is full.
create function public.admin_list_orphan_media(p_older_than interval default interval '24 hours') returns text[]
language plpgsql stable security invoker set search_path = '' as $$
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return (
    select coalesce(array_agg(o.name order by o.created_at, o.name), '{}')
      from (select so.name, so.created_at
              from storage.objects so
             where so.bucket_id = 'media'
               and private.media_path_valid(so.name)
               and so.created_at < now() - p_older_than
               and not exists (select 1 from public.media m where m.storage_path = so.name)
             order by so.created_at, so.name
             limit 1000) as o);
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
     set sort_order = (o.ord * 10)::integer, updated_by = (select auth.uid())
    from unnest(p_item_ids) with ordinality as o (id, ord)
   where i.id = o.id and i.category_id = p_category_id;
end;
$$;

-- Same checks as 20261103000200 except the 8-image limit, which the media_limit_per_item
-- trigger now enforces on the insert (P0001 too_many_media, unchanged for callers).
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
  -- Locked before sort_order is read, so concurrent attaches get distinct positions.
  perform 1 from public.items i where i.id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;

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

revoke execute on function public.admin_check_media_slot(uuid),
                           public.admin_list_orphan_media(interval),
                           public.admin_save_item(jsonb),
                           public.admin_reorder_items(uuid, uuid[]),
                           public.admin_attach_media(uuid, text, text, text, integer, integer) from public, anon;
grant  execute on function public.admin_check_media_slot(uuid),
                           public.admin_list_orphan_media(interval),
                           public.admin_save_item(jsonb),
                           public.admin_reorder_items(uuid, uuid[]),
                           public.admin_attach_media(uuid, text, text, text, integer, integer) to authenticated;

comment on function public.admin_check_media_slot(uuid) is
  'Upload pre-check: returns when the item exists (P0002 item_not_found) and has fewer than 8 media rows (P0001 too_many_media). Called before a signed upload URL is issued; the media_limit_per_item trigger enforces the limit on attach.';
comment on function public.admin_list_orphan_media(interval) is
  'Names of media-bucket objects with a valid items/{uuid}/{uuid}.{ext} name, no public.media row and created more than p_older_than (default 24 hours) ago, oldest first, at most 1000. The caller removes them through the Storage API.';
comment on function public.admin_save_item(jsonb) is
  'Creates (no id: draft, sort_order = category max + 10, category_id required -> 22023 category_required, unknown -> 23503) or updates an item: price/link keys present in the payload replace the column, absent keys keep it; category_id is fixed. Upserts each given locale''s translation and updates alt/sort_order of the listed media of this item (at most 8 entries -> P0001 too_many_media; P0002 media_not_found otherwise). P0002 item_not_found; 23505 slug taken; 23514 by constraint name. updated_by is set by the items_updated_by trigger.';
comment on function public.admin_reorder_items(uuid, uuid[]) is
  'Sets sort_order = 10 * position for the given items of the category (first id first, at most 1000 ids -> 22023 too_many_items); ids of other categories are ignored. P0002 category_not_found.';
comment on function public.admin_attach_media(uuid, text, text, text, integer, integer) is
  'Attaches an uploaded media-bucket object to an item: path items/{p_item_id}/{uuid}.{ext} (22023 invalid_media_path), object present (P0002 media_not_stored), its recorded metadata mimetype, when present, equal to the extension''s type (22023 media_type_mismatch), at most 8 per item (P0001 too_many_media, from the media_limit_per_item trigger). mime_type from the extension, sort_order = max + 10. P0002 item_not_found; 23514 media_alt_da_check / media_alt_da_length / media_alt_en_length / media_width_check / media_height_check; 23505 media_storage_path_key.';
