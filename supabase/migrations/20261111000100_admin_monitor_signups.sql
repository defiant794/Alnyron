-- Admin › Monitor-brugere: the list of public Monitor signups for the site owner and admins.
--
-- One read-only function, public.admin_list_monitor_signups(): every monitor_user profile with
-- its address, when the account was created, whether the address is confirmed and how many
-- monitors it has, newest account first. No table, policy, row or other grant changes.
--
-- Security: admins only (owner or admin, private.is_admin(); any other caller gets 42501
-- 'forbidden' before anything is read), an empty search_path and fully qualified names. EXECUTE
-- is revoked from PUBLIC, anon and authenticated, then granted to authenticated: the admin panel
-- calls it with the signed-in admin's session.
-- EXCEPTION: SECURITY DEFINER, owned by postgres. The signup time and the confirmation live in
-- auth.users, which authenticated cannot read (nor can service_role, see
-- 20261110000100_monitor_signup_notice.sql), while postgres can. The function returns only the
-- four columns of the signup list.
--
-- Re-runnable: `create or replace function` (keeps oid, owner and ACL) and idempotent alter
-- owner / revoke / grant / comment. No transaction control: the migration runner wraps the file.

-- admin_list_monitor_signups ---------------------------------------------------------------------
-- One row per monitor_user profile: the profile email, auth.users.created_at, whether
-- email_confirmed_at is set, and the number of monitors the account has (0 without any). Other
-- roles (owner, admin, mylife_user, none) are never listed. Newest account first, ties by user id.
create or replace function public.admin_list_monitor_signups()
returns table (email text, created_at timestamptz, confirmed boolean, monitor_count integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select p.email,
         u.created_at,
         u.email_confirmed_at is not null,
         (select count(*) from public.monitors m where m.user_id = p.user_id)::integer
    from public.profiles p
    join auth.users u on u.id = p.user_id
   where p.role = 'monitor_user'
   order by u.created_at desc, p.user_id;
end;
$$;

alter function public.admin_list_monitor_signups() owner to postgres;
revoke all on function public.admin_list_monitor_signups() from public, anon, authenticated;
grant execute on function public.admin_list_monitor_signups() to authenticated;
comment on function public.admin_list_monitor_signups() is
  'Admin › Monitor-brugere (owner and admin only, 42501 otherwise; SECURITY DEFINER because it reads auth.users, which authenticated and service_role cannot): every monitor_user account with its profile email, created_at, confirmed (email_confirmed_at is set) and monitor_count (0 without monitors), newest first. Returns only the signup list.';

-- PostgREST serves the new function without waiting for its schema cache to expire.
notify pgrst, 'reload schema';
