-- Terms and conditions (payments slice 1d): the terms system page and its reserved slug. Needs the
-- 'terms' key committed by 20261114000100_system_page_terms_key.sql.
--
-- Reserved slug: 'terms' is the page's fixed path (/terms, /en/terms), so no custom page or
-- catalog category may take it as a route slug. The CHECK is dropped and re-added with the full
-- list (the existing slugs unchanged, in the same order, then 'terms'), mirrored by
-- RESERVED_ROUTE_SLUGS in src/config/catalog.ts. Every stored route is checked when the
-- constraint is added: a stored 'terms' route would fail the migration.
--
-- The page: like the privacy seed (20261101000300_seed_system_content.sql), published (system
-- pages always are) and out of the nav, with a Danish and an English row. Blank lead and body:
-- the page renders its body from the versioned legal module; title, eyebrow and SEO fields are
-- edited under Admin › Sider (no body editor). A re-run leaves an existing row as it is.
--
-- Re-runnable: drop/add of the constraint, `on conflict do nothing` inserts. No transaction
-- control: the migration runner wraps the file.

-- Reserved slug ---------------------------------------------------------------------------------
alter table public.routes drop constraint if exists routes_slug_reserved;
alter table public.routes
  add constraint routes_slug_reserved check (slug <> all (array['admin', 'auth', 'api', 'da', 'en',
    'kontakt', 'contact', 'privatliv', 'privacy', 'mylife', 'terms']));

-- The terms page --------------------------------------------------------------------------------
insert into public.pages (system_key, status, show_in_nav, published_at)
values ('terms', 'published', false, now())
on conflict (system_key) do nothing;

insert into public.page_translations (page_id, locale, title, lead, body_md, content, seo_title, seo_description)
select p.id, t.locale, t.title, '', '', t.content, '', t.seo_description
  from public.pages p
 cross join (values
   ('da'::public.locale_code, 'Handelsbetingelser', jsonb_build_object('eyebrow', ''),
    'Handelsbetingelser for Monitor-abonnementet hos Alnyron.'),
   ('en'::public.locale_code, 'Terms and conditions', '{}'::jsonb,
    'Terms and conditions for the Monitor subscription from Alnyron.')
 ) as t (locale, title, content, seo_description)
 where p.system_key = 'terms'
on conflict (page_id, locale) do nothing;
