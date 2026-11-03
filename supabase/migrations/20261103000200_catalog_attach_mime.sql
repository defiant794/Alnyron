-- F2.1 catalog-model (review): admin_attach_media also checks the uploaded object's type.
-- media.mime_type comes from the path's extension. The Storage API records the content type
-- the upload declared in storage.objects.metadata->>'mimetype'; when that is present and names
-- another type, the object is not the image its name claims, so the attach is refused
-- (22023 media_type_mismatch). An object without a recorded type still attaches.
-- Same signature as 20261103000100: `create or replace` keeps the owner and the grants, which
-- are restated below anyway so this file alone shows who may call the function.
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
  -- Locked so two concurrent attaches cannot both pass the 8-image limit.
  perform 1 from public.items i where i.id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;

  select o.metadata ->> 'mimetype' into v_stored_type
    from storage.objects o
   where o.bucket_id = 'media' and o.name = p_path;
  if not found then
    raise exception 'media_not_stored' using errcode = 'P0002';
  end if;
  v_mime_type := case substring(p_path from '\.([a-z]+)$')
                   when 'jpg'  then 'image/jpeg'
                   when 'jpeg' then 'image/jpeg'
                   when 'png'  then 'image/png'
                   when 'webp' then 'image/webp'
                   when 'avif' then 'image/avif'
                 end;
  -- Content types are case-insensitive (RFC 9110); the bucket only accepts the four image types.
  if v_stored_type is not null and lower(btrim(v_stored_type)) <> v_mime_type then
    raise exception 'media_type_mismatch' using errcode = '22023';
  end if;

  if (select count(*) from public.media m where m.item_id = p_item_id) >= 8 then
    raise exception 'too_many_media' using errcode = 'P0001';
  end if;

  insert into public.media (item_id, storage_path, alt_da, alt_en, width, height, mime_type, sort_order)
  values (p_item_id, p_path, p_alt_da, coalesce(p_alt_en, ''), p_width, p_height, v_mime_type,
          coalesce((select max(m.sort_order) from public.media m where m.item_id = p_item_id), 0) + 10)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.admin_attach_media(uuid, text, text, text, integer, integer) from public, anon;
grant  execute on function public.admin_attach_media(uuid, text, text, text, integer, integer) to authenticated;

comment on function public.admin_attach_media(uuid, text, text, text, integer, integer) is
  'Attaches an uploaded media-bucket object to an item: path items/{p_item_id}/{uuid}.{ext} (22023 invalid_media_path), object present (P0002 media_not_stored), its recorded metadata mimetype, when present, equal to the extension''s type (22023 media_type_mismatch), at most 8 per item (P0001 too_many_media, item row locked). mime_type from the extension, sort_order = max + 10. P0002 item_not_found; 23514 media_alt_da_check / media_width_check / media_height_check; 23505 media_storage_path_key.';
