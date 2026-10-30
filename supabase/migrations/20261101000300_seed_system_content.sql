-- F0.4 production structure + approved DA copy (architecture.md §4 seed).
-- System pages (home, contact, privacy) are always published; EN rows start blank
-- and fall back to DA. Catalog categories stay hidden until they have a published item.
-- `{email}` in content strings renders site_settings.contact_email as a mailto link.

insert into public.site_settings (company_name, contact_email) values ('Alnyron', 'info@alnyron.dk');

-- Home ---------------------------------------------------------------------------------
with p as (
  insert into public.pages (system_key, status, show_in_nav, nav_order, published_at)
  values ('home', 'published', true, 0, now()) returning id)
insert into public.page_translations (page_id, locale, title, lead, content)
select id, 'da'::public.locale_code,
  'Moderne apps, hjemmesider og digitale ydelser.',
  'Alnyron bygger gennemtænkte digitale produkter, der er enkle, hurtige og tilgængelige. Fortæl om dit projekt, så finder vi den rette løsning.',
  jsonb_build_object(
    'whatWeDo', jsonb_build_object(
      'eyebrow', 'Hvad vi laver',
      'title',   'Én samarbejdspartner, flere muligheder',
      'intro',   'Vi arbejder blandt andet med:',
      'note',    'Offentlige områder vises automatisk, når de har indhold. Tomme områder skjules, og der kan altid komme flere til.'),
    'ctaBand', jsonb_build_object(
      'title', 'Klar til at tale om dit projekt?',
      'text',  'Skriv til {email}, så vender vi hurtigt tilbage.'))
from p
union all select id, 'en'::public.locale_code, '', '', '{}'::jsonb from p;

-- Contact ------------------------------------------------------------------------------
with p as (
  insert into public.pages (system_key, status, show_in_nav, nav_order, published_at)
  values ('contact', 'published', true, 1000, now()) returning id)
insert into public.page_translations (page_id, locale, title, lead, content)
select id, 'da'::public.locale_code,
  'Lad os tale om dit projekt',
  'Skriv til os, så vender vi hurtigt tilbage. Du kan også sende en mail direkte.',
  jsonb_build_object(
    'eyebrow',      'Kontakt',
    'responseTime', 'Typisk inden for 1-2 hverdage',
    'languages',    'Dansk / English')
from p
union all select id, 'en'::public.locale_code, '', '', '{}'::jsonb from p;

-- Privacy (approved privacy mock copy; admin edits it as features are activated) --------
with p as (
  insert into public.pages (system_key, status, show_in_nav, published_at)
  values ('privacy', 'published', false, now()) returning id)
insert into public.page_translations (page_id, locale, title, body_md, content)
select id, 'da'::public.locale_code,
  'Privatlivspolitik',
  $md$Denne politik beskriver, hvordan Alnyron behandler personoplysninger. Omfanget afspejler de tjenester, der faktisk er aktiveret på siden.

## Hvilke oplysninger vi behandler

- Kontakthenvendelser: navn og e-mail, når du skriver til os.
- Nyhedsbrev: din e-mail, hvis du aktivt tilmelder dig (dobbelt-bekræftelse).

## Formål og retsgrundlag

Vi bruger oplysningerne til at besvare henvendelser og, ved samtykke, til at sende nyhedsbreve. Du kan til enhver tid afmelde dig.

## Opbevaring

Oplysninger opbevares kun så længe, det er nødvendigt for formålet.

## Dine rettigheder

- Indsigt, berigtigelse og sletning af dine data.
- Tilbagetrækning af samtykke til nyhedsbrev.
- Klage til Datatilsynet.

## Kontakt

Spørgsmål om persondata: {email}.$md$,
  jsonb_build_object('eyebrow', 'Privatliv')
from p
union all select id, 'en'::public.locale_code, '', '', '{}'::jsonb from p;

-- Catalog categories (hidden until they have a published item) ---------------------------
with c (kind, nav_order, da_title, da_description, en_title, da_slug, en_slug) as (
  values
    ('apps'::public.catalog_kind,     10, 'Apps',        'Mobil- og webapps med fokus på brugeroplevelse.', 'Apps',      'apps',        'apps'),
    ('websites'::public.catalog_kind, 20, 'Hjemmesider', 'Hurtige, tilgængelige sider der konverterer.',    'Websites',  'hjemmesider', 'websites'),
    ('services'::public.catalog_kind, 30, 'Ydelser',     'Udvikling, AI og automatisering.',                'Services',  'ydelser',     'services'),
    ('models3d'::public.catalog_kind, 40, '3D-modeller', 'Katalog med modeller og filformater.',            '3D models', '3d-modeller', '3d-models')
),
ins as (
  insert into public.categories (kind, nav_order)
  select kind, nav_order from c
  returning id, kind
),
tr as (
  insert into public.category_translations (category_id, locale, title, description)
  select ins.id, 'da'::public.locale_code, c.da_title, c.da_description from ins join c using (kind)
  union all
  select ins.id, 'en'::public.locale_code, c.en_title, '' from ins join c using (kind)
)
insert into public.routes (locale, slug, category_id)
select 'da'::public.locale_code, c.da_slug, ins.id from ins join c using (kind)
union all
select 'en'::public.locale_code, c.en_slug, ins.id from ins join c using (kind);
