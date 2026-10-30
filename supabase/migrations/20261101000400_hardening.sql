-- F0.4 hardening (code review): no implicit EXECUTE on new functions, permanent
-- system pages, and allowlist matching normalised like the user_allowlist CHECK.

-- Default EXECUTE ------------------------------------------------------------------------
-- anon/authenticated hold USAGE on `private` (policies call private.* helpers) and
-- Postgres grants EXECUTE on every new function to PUBLIC, so a future security-definer
-- helper in `private` would be anon-callable. A schema-scoped
-- `alter default privileges ... in schema private revoke ... from public` is a no-op:
-- per-schema defaults only add to the global default, they cannot revoke it. Revoke the
-- global default for functions created by postgres instead. `public` keeps Supabase's
-- per-schema grants to anon/authenticated/service_role; only the PUBLIC grant goes away.
alter default privileges for role postgres revoke execute on functions from public;
revoke execute on all functions in schema private from public;   -- existing set (idempotent)

-- System pages are permanent ------------------------------------------------------------
-- system_key is fixed at insert: clearing it would let an admin unpublish/delete a system
-- page (pages_delete only spares system_key is not null), and setting it on a custom page
-- would create a system page that already owns routes (routes_guard only checks inserts).
-- Admins may still edit a system page's translations, nav flag and order.
create function private.pages_system_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.system_key is distinct from old.system_key then
    raise exception 'system_key is immutable' using errcode = '23514';
  end if;
  if old.system_key is not null and new.status <> 'published' then
    raise exception 'system pages are always published' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger pages_system_guard before update on public.pages
  for each row execute function private.pages_system_guard();

-- Allowlist matching: lower(btrim()) like the user_allowlist email CHECK -----------------
create or replace function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  if exists (select 1 from public.user_allowlist a
             where a.email = lower(btrim(event -> 'user' ->> 'email'))) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'Adgang kræver en invitation.'));
end;
$$;

create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, email, role)
  values (new.id, lower(btrim(new.email)),
          (select a.role from public.user_allowlist a where a.email = lower(btrim(new.email))));
  return new;
end;
$$;
