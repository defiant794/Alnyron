-- F1.2 review (M1): admin_reorder_nav wrote nav_order 10, 20, ... — the band of the
-- catalog categories (10-40) — so any reorder in the pages editor moved Kontakt ahead of
-- the catalog. Reordered pages now get 1010, 1020, ...: after every category, like the
-- seeded contact page (1000). The editor orders the pages among themselves; it never
-- moves a page between the categories. `create or replace` keeps the owner and grants.
create or replace function public.admin_reorder_nav(p_page_ids uuid[]) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.pages p
     set nav_order = (1000 + o.ord * 10)::integer, updated_by = (select auth.uid())
    from unnest(p_page_ids) with ordinality as o (id, ord)
   where p.id = o.id;
end;
$$;

comment on function public.admin_reorder_nav(uuid[]) is
  'Sets nav_order = 1000 + 10 * position for the given pages (first id first), above the catalog categories'' band (< 1000). Pages outside the array keep their nav_order.';
