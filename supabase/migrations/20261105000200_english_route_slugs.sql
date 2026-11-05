-- english-slugs: every public URL path segment is English on both locales.
--
-- The site now builds every section and item address from the English slug on BOTH locales
-- (`URL_SLUG_LOCALE = "en"` in src/config/catalog.ts): /websites and /en/websites,
-- /services/web-development and /en/services/web-development. The Danish route rows of the
-- categories still held the old Danish slugs (hjemmesider, ydelser, 3d-modeller), which are no
-- address any more and now answer 404 (no redirects). This data-only migration sets each
-- category's Danish route slug to its English route slug, so the admin section editor and any
-- locale-keyed read of `routes` show the real address, and an old Danish slug is free again.
-- `apps` is already the same in both locales and is left alone.
--
-- Only category routes change: custom-page routes and the item slugs (item_translations) keep
-- their per-locale values. Schema, constraints and the reserved route slugs are unchanged. The
-- English slugs already pass routes_slug_format / routes_slug_reserved, and routes_guard only
-- rejects routes of system pages (category rows have no page_id). If another Danish route
-- (a custom page) already held one of the English slugs, the routes primary key (locale, slug)
-- fails with 23505 and the whole migration rolls back.

update public.routes da
   set slug = en.slug
  from public.routes en
 where da.locale = 'da'
   and en.locale = 'en'
   and da.category_id is not null
   and en.category_id = da.category_id
   and da.slug <> en.slug;
