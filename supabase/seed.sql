-- LOCAL TEST DATA ONLY (supabase db reset on a local stack). Never applied to the
-- cloud project: `npm run db:push` pushes migrations without --include-seed.
-- Runs after the migrations, so system pages, site settings and the four catalog
-- categories already exist.

-- Local owner for invite/login testing (invite this address from local Studio).
insert into public.user_allowlist (email, role) values ('owner@alnyron.local', 'owner');

-- Draft custom page with slugs in both locales: invisible to anon until published.
with p as (
  insert into public.pages (status, show_in_nav, nav_order) values ('draft', true, 500) returning id),
tr as (
  insert into public.page_translations (page_id, locale, title, lead, body_md)
  select id, 'da'::public.locale_code, 'Testside (kladde)', 'Lokal testside.', 'Indhold til lokal test.' from p
  union all
  select id, 'en'::public.locale_code, 'Test page (draft)', 'Local test page.', 'Content for local testing.' from p
)
insert into public.routes (locale, slug, page_id)
select 'da'::public.locale_code, 'testside', id from p
union all
select 'en'::public.locale_code, 'test-page', id from p;

-- One published test item in "apps" (makes that category visible locally) and one
-- draft test item in "websites" (that category stays hidden).
with i as (
  insert into public.items (category_id, status, sort_order, price_type, published_at)
  select id, 'published', 10, 'contact', now() from public.categories where kind = 'apps'
  returning id)
insert into public.item_translations (item_id, locale, slug, title, summary)
select id, 'da'::public.locale_code, 'testapp', 'Testapp', 'Lokal testdata.' from i
union all
select id, 'en'::public.locale_code, 'test-app', 'Test app', 'Local test data.' from i;

with i as (
  insert into public.items (category_id, status, sort_order)
  select id, 'draft', 10 from public.categories where kind = 'websites'
  returning id)
insert into public.item_translations (item_id, locale, slug, title)
select id, 'da'::public.locale_code, 'testhjemmeside-kladde', 'Testhjemmeside (kladde)' from i;
