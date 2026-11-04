-- F2.3 catalog-admin (security review, Low): unattached uploads cannot pile up in an item's
-- folder of the public media bucket.
--
-- admin_check_media_slot is the pre-check run before the app issues a signed upload URL. It
-- counted public.media rows only, so the app's own upload action could keep minting URLs for an
-- item with room, upload to each and never attach: every object stayed publicly fetchable with
-- no row. The check now also raises P0001 too_many_media while the item's folder
-- (items/{p_item_id}/) holds 16 or more objects that no media row references. Attached objects
-- are already bounded by the 8-image limit, so they do not count against this ceiling. The
-- count stops at the ceiling, so a large folder costs no more than a full one.
-- Scope: this bounds the APPLICATION upload flow and is advisory, like the 8-image pre-check — a
-- URL issued before the ceiling was reached stays valid for its 2 hours. A caller holding a valid
-- admin JWT could still write to the media bucket directly via the Storage API (gated only by the
-- media_objects_insert is_admin() policy); a compromised admin can already delete the bucket, so
-- direct-API abuse is out of scope for this control. The admin's upload action sweeps orphans
-- older than a day (admin_list_orphan_media) before each new upload URL, so a folder at the
-- ceiling clears itself.
--
-- Same signature, volatility and SECURITY INVOKER as 20261103000300 (RLS: admins read every
-- media row and every media-bucket object): `create or replace` keeps the owner and the grants,
-- which are restated below anyway so this file alone shows who may call the function.

create or replace function public.admin_check_media_slot(p_item_id uuid) returns void
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
  -- Uploads in the item's folder that no media row references (never attached, or left behind
  -- by a failed removal), counted up to the ceiling of 16.
  if (select count(*)
        from (select 1
                from storage.objects so
               where so.bucket_id = 'media'
                 and so.name like ('items/' || p_item_id::text || '/%')
                 and not exists (select 1 from public.media m where m.storage_path = so.name)
               limit 16) as pending) >= 16 then
    raise exception 'too_many_media' using errcode = 'P0001';
  end if;
end;
$$;

revoke execute on function public.admin_check_media_slot(uuid) from public, anon;
grant  execute on function public.admin_check_media_slot(uuid) to authenticated;

comment on function public.admin_check_media_slot(uuid) is
  'Upload pre-check: returns when the item exists (P0002 item_not_found), has fewer than 8 media rows and fewer than 16 objects in its media-bucket folder that no media row references (P0001 too_many_media for either). Called before a signed upload URL is issued; the media_limit_per_item trigger enforces the 8-image limit on attach, and the orphan sweep (admin_list_orphan_media) clears unattached objects older than a day.';
