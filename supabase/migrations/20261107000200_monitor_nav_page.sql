-- Monitor nav (slice B): Monitor as a link in the public header nav, shown or hidden from
-- Admin › Sider. Needs the 'monitor' key committed by 20261107000100_monitor_page_key.sql.

-- The Monitor page ------------------------------------------------------------------------------
-- Monitor is an app area (alnyron.dk/monitor, outside the CMS and the [locale] routing), so its
-- row carries only the nav flag and order: no page_translations (nothing to edit) and no routes
-- (system pages have fixed routes; the site links the raw /monitor path). It starts hidden
-- (show_in_nav = false, the admin opts in) in the pages band after Kontakt (1000), the band
-- admin_reorder_nav keeps every page in (1000 + 10 * position, after the catalog categories).
-- System pages are always published (pages_system_always_published, pages_published_has_date).
-- A re-run leaves an existing row as it is.
insert into public.pages (system_key, status, show_in_nav, nav_order, published_at)
values ('monitor', 'published', false, 1100, now())
on conflict (system_key) do nothing;

-- Nav flag ----------------------------------------------------------------------------------------
-- The Sider list switches the flag in place for a page without an editor (Monitor); pages with an
-- editor still save it with admin_save_page. Guarded like the other page RPCs: security invoker
-- (pages RLS applies too) plus an explicit is_admin() check for a clear 42501. Touches only
-- show_in_nav and updated_by, so pages_system_guard has nothing to object to.
create function public.admin_set_page_nav(p_page_id uuid, p_show boolean) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.pages
     set show_in_nav = p_show, updated_by = (select auth.uid())
   where id = p_page_id;
  if not found then raise exception 'page_not_found' using errcode = 'P0002'; end if;
end;
$$;

comment on function public.admin_set_page_nav(uuid, boolean) is
  'Shows (p_show = true) or hides a page in the public nav. Admins only (42501); P0002 when no page has the id.';

revoke execute on function public.admin_set_page_nav(uuid, boolean) from public, anon;
grant  execute on function public.admin_set_page_nav(uuid, boolean) to authenticated;
