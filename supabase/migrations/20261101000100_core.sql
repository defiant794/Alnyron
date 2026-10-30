-- F0.4 content model: schemas, enums, helpers, tables, triggers, auth hook,
-- routing registry, visibility helpers and admin RPCs (architecture.md §4).
-- RLS, grants and policies live in 20261101000200_rls.sql.

-- Schemas, types, helpers ------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;   -- policies call private.* helpers

create type public.app_role        as enum ('owner', 'admin', 'mylife_user');
create type public.locale_code     as enum ('da', 'en');
create type public.content_status  as enum ('draft', 'published');
create type public.system_page_key as enum ('home', 'contact', 'privacy');
create type public.catalog_kind    as enum ('apps', 'websites', 'services', 'models3d');
create type public.price_type      as enum ('fixed', 'from', 'contact');

create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Auth: allowlist + profiles ----------------------------------------------------
create table public.user_allowlist (
  email      text primary key
             check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role       public.app_role not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

create table public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  role       public.app_role,                 -- null = no access (not allowlisted / revoked)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();

create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, email, role)
  values (new.id, lower(new.email),
          (select a.role from public.user_allowlist a where a.email = lower(new.email)));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Before User Created hook: reject any email not on the allowlist
create function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  if exists (select 1 from public.user_allowlist a
             where a.email = lower(event -> 'user' ->> 'email')) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'Adgang kræver en invitation.'));
end;
$$;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from authenticated, anon, public;

create function private.current_role_in(roles public.app_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p
                 where p.user_id = (select auth.uid()) and p.role = any (roles));
$$;
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.current_role_in(array['owner', 'admin']::public.app_role[]);
$$;
create function private.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.current_role_in(array['owner']::public.app_role[]);
$$;

-- Pages ------------------------------------------------------------------------
create table public.pages (
  id           uuid primary key default gen_random_uuid(),
  system_key   public.system_page_key unique,          -- null = custom page
  status       public.content_status not null default 'draft',
  show_in_nav  boolean not null default false,
  nav_order    integer not null default 100,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users (id) on delete set null,
  constraint pages_system_always_published check (system_key is null or status = 'published'),
  constraint pages_published_has_date      check (status = 'draft' or published_at is not null)
);
create index pages_nav_idx on public.pages (nav_order) where status = 'published' and show_in_nav;
create trigger pages_updated_at before update on public.pages
  for each row execute function private.set_updated_at();

create table public.page_translations (
  page_id         uuid not null references public.pages (id) on delete cascade,
  locale          public.locale_code not null,
  title           text not null default '' check (char_length(title) <= 160),
  lead            text not null default '' check (char_length(lead) <= 600),
  body_md         text not null default '' check (char_length(body_md) <= 50000),
  content         jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  seo_title       text not null default '' check (char_length(seo_title) <= 70),
  seo_description text not null default '' check (char_length(seo_description) <= 160),
  updated_at      timestamptz not null default now(),
  primary key (page_id, locale),
  constraint page_translations_da_title check (locale <> 'da' or btrim(title) <> '')
);
create trigger page_translations_updated_at before update on public.page_translations
  for each row execute function private.set_updated_at();

-- Catalog foundation (editors in P2) -----------------------------------------------
create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  kind       public.catalog_kind not null,
  status     public.content_status not null default 'published', -- 'published' = may appear once it has a published item
  featured   boolean not null default false,
  nav_order  integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
create trigger categories_updated_at before update on public.categories
  for each row execute function private.set_updated_at();

create table public.category_translations (
  category_id     uuid not null references public.categories (id) on delete cascade,
  locale          public.locale_code not null,
  title           text not null default '' check (char_length(title) <= 120),
  description     text not null default '' check (char_length(description) <= 2000),
  seo_title       text not null default '' check (char_length(seo_title) <= 70),
  seo_description text not null default '' check (char_length(seo_description) <= 160),
  updated_at      timestamptz not null default now(),
  primary key (category_id, locale),
  constraint category_translations_da_title check (locale <> 'da' or btrim(title) <> '')
);
create trigger category_translations_updated_at before update on public.category_translations
  for each row execute function private.set_updated_at();

create table public.items (
  id             uuid primary key default gen_random_uuid(),
  category_id    uuid not null references public.categories (id) on delete restrict,
  status         public.content_status not null default 'draft',
  sort_order     integer not null default 100,
  featured       boolean not null default false,
  price_type     public.price_type,
  price_amount   numeric(12,2),
  price_currency char(3) not null default 'DKK' check (price_currency ~ '^[A-Z]{3}$'),
  external_links jsonb not null default '{}'::jsonb check (jsonb_typeof(external_links) = 'object'),
  published_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users (id) on delete set null,
  constraint items_price_consistent check (
       (price_type is null and price_amount is null)
    or (price_type = 'contact' and price_amount is null)
    or (price_type in ('fixed', 'from') and price_amount is not null and price_amount >= 0)),
  constraint items_published_has_date check (status = 'draft' or published_at is not null)
);
create index items_category_idx  on public.items (category_id);
create index items_published_idx on public.items (category_id, sort_order) where status = 'published';
create trigger items_updated_at before update on public.items
  for each row execute function private.set_updated_at();

create table public.item_translations (
  item_id         uuid not null references public.items (id) on delete cascade,
  locale          public.locale_code not null,
  slug            text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),
  title           text not null default '' check (char_length(title) <= 160),
  summary         text not null default '' check (char_length(summary) <= 600),
  body_md         text not null default '' check (char_length(body_md) <= 50000),
  seo_title       text not null default '' check (char_length(seo_title) <= 70),
  seo_description text not null default '' check (char_length(seo_description) <= 160),
  updated_at      timestamptz not null default now(),
  primary key (item_id, locale),
  constraint item_translations_locale_slug_key unique (locale, slug),
  constraint item_translations_da_title check (locale <> 'da' or btrim(title) <> '')
);
create trigger item_translations_updated_at before update on public.item_translations
  for each row execute function private.set_updated_at();

create table public.media (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references public.items (id) on delete cascade,
  storage_path text not null unique,
  alt_da       text not null check (btrim(alt_da) <> ''),
  alt_en       text not null default '',
  width        integer not null check (width > 0),
  height       integer not null check (height > 0),
  mime_type    text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
  sort_order   integer not null default 100,
  created_at   timestamptz not null default now()
);
create index media_item_idx on public.media (item_id, sort_order);

-- Top-level routing registry: one namespace for pages + categories --------------------
create table public.routes (
  locale      public.locale_code not null,
  slug        text not null,
  page_id     uuid references public.pages (id) on delete cascade,
  category_id uuid references public.categories (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (locale, slug),
  constraint routes_single_target check (num_nonnulls(page_id, category_id) = 1),
  constraint routes_slug_format   check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),
  constraint routes_slug_reserved check (slug <> all (array['admin', 'auth', 'api', 'da', 'en',
                                         'kontakt', 'contact', 'privatliv', 'privacy']))
);
create unique index routes_page_locale_key     on public.routes (page_id, locale)     where page_id is not null;
create unique index routes_category_locale_key on public.routes (category_id, locale) where category_id is not null;

create function private.routes_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.page_id is not null and exists (
       select 1 from public.pages p where p.id = new.page_id and p.system_key is not null) then
    raise exception 'system pages have fixed routes' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger routes_guard before insert or update on public.routes
  for each row execute function private.routes_guard();

-- Site settings (singleton) ---------------------------------------------------------
create table public.site_settings (
  id            boolean primary key default true check (id),
  company_name  text not null check (btrim(company_name) <> ''),
  contact_email text not null check (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  cvr           text check (cvr is null or cvr ~ '^[0-9]{8}$'),
  social_links  jsonb not null default '{}'::jsonb check (jsonb_typeof(social_links) = 'object'),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users (id) on delete set null
);
create trigger site_settings_updated_at before update on public.site_settings
  for each row execute function private.set_updated_at();

-- Visibility helpers (security definer: no RLS recursion between categories <-> items)
create function private.page_is_public(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.pages p where p.id = p_id and p.status = 'published');
$$;
create function private.category_is_public(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.categories c
    where c.id = p_id and c.status = 'published'
      and exists (select 1 from public.items i where i.category_id = c.id and i.status = 'published'));
$$;
create function private.item_is_public(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.items i join public.categories c on c.id = i.category_id
    where i.id = p_id and i.status = 'published' and c.status = 'published');
$$;

-- Admin RPCs (security invoker: RLS still applies; transactional multi-table writes) ---

-- Create/update a page + translations + slugs in one transaction.
-- payload: {id?, show_in_nav?, nav_order?, translations: {da: {title, lead, body_md, content, seo_title, seo_description, slug?}, en: {...}}}
create function public.admin_save_page(payload jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_id     uuid := nullif(payload ->> 'id', '')::uuid;
  v_locale public.locale_code;
  v_tr     jsonb;
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_id is null then
    insert into public.pages (show_in_nav, nav_order, updated_by)
    values (coalesce((payload ->> 'show_in_nav')::boolean, false),
            coalesce((payload ->> 'nav_order')::integer, 100),
            (select auth.uid()))
    returning id into v_id;
  else
    update public.pages
       set show_in_nav = coalesce((payload ->> 'show_in_nav')::boolean, show_in_nav),
           nav_order   = coalesce((payload ->> 'nav_order')::integer, nav_order),
           updated_by  = (select auth.uid())
     where id = v_id;
    if not found then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  end if;

  for v_locale, v_tr in
    select key::public.locale_code, value from jsonb_each(coalesce(payload -> 'translations', '{}'::jsonb))
  loop
    insert into public.page_translations
      (page_id, locale, title, lead, body_md, content, seo_title, seo_description)
    values (v_id, v_locale,
            coalesce(v_tr ->> 'title', ''), coalesce(v_tr ->> 'lead', ''), coalesce(v_tr ->> 'body_md', ''),
            coalesce(v_tr -> 'content', '{}'::jsonb),
            coalesce(v_tr ->> 'seo_title', ''), coalesce(v_tr ->> 'seo_description', ''))
    on conflict (page_id, locale) do update
      set title = excluded.title, lead = excluded.lead, body_md = excluded.body_md,
          content = excluded.content, seo_title = excluded.seo_title,
          seo_description = excluded.seo_description;

    if v_tr ? 'slug' then   -- custom pages only; routes_guard rejects system pages
      insert into public.routes (locale, slug, page_id) values (v_locale, v_tr ->> 'slug', v_id)
      on conflict (page_id, locale) where page_id is not null do update set slug = excluded.slug;
    end if;
  end loop;

  return v_id;   -- 23505 on routes = slug taken (map to field error in TS)
end;
$$;

create function public.admin_set_page_status(p_page_id uuid, p_status public.content_status) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status = 'published'
     and exists (select 1 from public.pages p where p.id = p_page_id and p.system_key is null)
     and (select count(*) from public.routes r where r.page_id = p_page_id) < 2 then
    raise exception 'missing_slugs' using errcode = 'P0001';
  end if;
  update public.pages
     set status = p_status,
         published_at = case when p_status = 'published' then coalesce(published_at, now()) else published_at end,
         updated_by = (select auth.uid())
   where id = p_page_id;
  if not found then raise exception 'page_not_found' using errcode = 'P0002'; end if;
end;
$$;

create function public.admin_reorder_nav(p_page_ids uuid[]) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.pages p
     set nav_order = (o.ord * 10)::integer, updated_by = (select auth.uid())
    from unnest(p_page_ids) with ordinality as o (id, ord)
   where p.id = o.id;
end;
$$;

revoke execute on function public.admin_save_page(jsonb),
                           public.admin_set_page_status(uuid, public.content_status),
                           public.admin_reorder_nav(uuid[]) from public, anon;
grant  execute on function public.admin_save_page(jsonb),
                           public.admin_set_page_status(uuid, public.content_status),
                           public.admin_reorder_nav(uuid[]) to authenticated;
