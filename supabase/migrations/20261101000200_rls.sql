-- F0.4 content model: RLS on every table, explicit grants, policies and the
-- media storage bucket (architecture.md §5).
-- Pattern: `(select private.is_admin())` is evaluated once per statement (initPlan);
-- security-definer helpers live only in the non-exposed `private` schema.
-- anon evaluating private.is_admin() gets false (no auth.uid()).

alter table public.user_allowlist        enable row level security;
alter table public.profiles              enable row level security;
alter table public.pages                 enable row level security;
alter table public.page_translations     enable row level security;
alter table public.routes                enable row level security;
alter table public.categories            enable row level security;
alter table public.category_translations enable row level security;
alter table public.items                 enable row level security;
alter table public.item_translations     enable row level security;
alter table public.media                 enable row level security;
alter table public.site_settings         enable row level security;

-- Grants ------------------------------------------------------------------------------
revoke all on table public.user_allowlist, public.profiles, public.pages, public.page_translations,
  public.routes, public.categories, public.category_translations, public.items,
  public.item_translations, public.media, public.site_settings from anon, authenticated;

grant select on table public.pages, public.page_translations, public.routes, public.categories,
  public.category_translations, public.items, public.item_translations, public.media,
  public.site_settings to anon, authenticated;
grant insert, update, delete on table public.pages, public.page_translations, public.routes,
  public.categories, public.category_translations, public.items, public.item_translations,
  public.media to authenticated;
grant update on table public.site_settings to authenticated;
grant select, update, delete on table public.profiles to authenticated;
grant select, insert, update, delete on table public.user_allowlist to authenticated;
grant select on table public.user_allowlist to supabase_auth_admin;   -- hook reads it

revoke all on all functions in schema private from public;
grant execute on function private.is_admin(), private.page_is_public(uuid),
  private.category_is_public(uuid), private.item_is_public(uuid) to anon, authenticated;
grant execute on function private.is_owner() to authenticated;

-- Public read: published only; admins read everything ----------------------------------
create policy pages_select on public.pages for select to anon, authenticated
  using (status = 'published' or (select private.is_admin()));
create policy page_translations_select on public.page_translations for select to anon, authenticated
  using ((select private.is_admin()) or private.page_is_public(page_id));
create policy routes_select on public.routes for select to anon, authenticated
  using ((select private.is_admin())
      or (page_id is not null and private.page_is_public(page_id))
      or (category_id is not null and private.category_is_public(category_id)));
create policy categories_select on public.categories for select to anon, authenticated
  using ((select private.is_admin()) or private.category_is_public(id));
create policy category_translations_select on public.category_translations for select to anon, authenticated
  using ((select private.is_admin()) or private.category_is_public(category_id));
create policy items_select on public.items for select to anon, authenticated
  using ((select private.is_admin()) or private.item_is_public(id));
create policy item_translations_select on public.item_translations for select to anon, authenticated
  using ((select private.is_admin()) or private.item_is_public(item_id));
create policy media_select on public.media for select to anon, authenticated
  using ((select private.is_admin()) or private.item_is_public(item_id));
create policy site_settings_select on public.site_settings for select to anon, authenticated
  using (true);

-- Admin writes ------------------------------------------------------------------------
create policy pages_insert on public.pages for insert to authenticated with check ((select private.is_admin()));
create policy pages_update on public.pages for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy pages_delete on public.pages for delete to authenticated using ((select private.is_admin()) and system_key is null);

create policy page_translations_insert on public.page_translations for insert to authenticated with check ((select private.is_admin()));
create policy page_translations_update on public.page_translations for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy page_translations_delete on public.page_translations for delete to authenticated using ((select private.is_admin()) and locale <> 'da');

create policy routes_insert on public.routes for insert to authenticated with check ((select private.is_admin()));
create policy routes_update on public.routes for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy routes_delete on public.routes for delete to authenticated using ((select private.is_admin()));

create policy categories_insert on public.categories for insert to authenticated with check ((select private.is_admin()));
create policy categories_update on public.categories for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy categories_delete on public.categories for delete to authenticated using ((select private.is_admin()));

create policy category_translations_insert on public.category_translations for insert to authenticated with check ((select private.is_admin()));
create policy category_translations_update on public.category_translations for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy category_translations_delete on public.category_translations for delete to authenticated using ((select private.is_admin()) and locale <> 'da');

create policy items_insert on public.items for insert to authenticated with check ((select private.is_admin()));
create policy items_update on public.items for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy items_delete on public.items for delete to authenticated using ((select private.is_admin()));

create policy item_translations_insert on public.item_translations for insert to authenticated with check ((select private.is_admin()));
create policy item_translations_update on public.item_translations for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy item_translations_delete on public.item_translations for delete to authenticated using ((select private.is_admin()) and locale <> 'da');

create policy media_insert on public.media for insert to authenticated with check ((select private.is_admin()));
create policy media_update on public.media for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy media_delete on public.media for delete to authenticated using ((select private.is_admin()));

create policy site_settings_update on public.site_settings for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- Profiles + allowlist: owner manages access ---------------------------------------------
create policy profiles_select on public.profiles for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_owner()));
create policy profiles_update on public.profiles for update to authenticated
  using ((select private.is_owner())) with check ((select private.is_owner()));
create policy profiles_delete on public.profiles for delete to authenticated
  using ((select private.is_owner()));

create policy user_allowlist_owner on public.user_allowlist for all to authenticated
  using ((select private.is_owner())) with check ((select private.is_owner()));
create policy user_allowlist_auth_hook on public.user_allowlist for select to supabase_auth_admin
  using (true);

-- Storage (bucket ready in P1, uploads UI in P2) -------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
on conflict (id) do nothing;

create policy media_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (select private.is_admin()));
create policy media_objects_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and (select private.is_admin()))
  with check (bucket_id = 'media' and (select private.is_admin()));
create policy media_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (select private.is_admin()));
