-- Admin › Monitor-brugere: the sites each Monitor signup watches.
--
-- public.admin_list_monitor_signups() (20261111000200) gains a trailing monitors column: the
-- account's monitors as a jsonb array of {url, label, status} objects, oldest monitor first
-- (created_at, then id), '[]' for an account without monitors. user_id, email, created_at,
-- confirmed and monitor_count, the guard and the order of the rows are unchanged. A changed return
-- type cannot be replaced in place, so the function is dropped and created again with its owner,
-- privileges and comment. The new column is additive: the app deployed before this migration
-- reads the other five by name and keeps working until it is redeployed.
--
-- Security: admins only (owner or admin, private.is_admin(); any other caller gets 42501
-- 'forbidden' before anything is read), an empty search_path and fully qualified names. EXECUTE
-- is revoked from PUBLIC, anon and authenticated, then granted to authenticated: the admin panel
-- calls it with the signed-in admin's session.
-- EXCEPTION: SECURITY DEFINER, owned by postgres, as before: the signup time and the confirmation
-- live in auth.users, which authenticated cannot read (nor can service_role, see
-- 20261110000100_monitor_signup_notice.sql), while postgres can. The monitors array adds only
-- the url, label and status of the listed accounts' own monitors (public.monitors, which
-- postgres reads past RLS); nothing else of a monitor (snapshot, hash, check state) is returned.
--
-- Re-runnable: `drop function if exists` before creating it again, and idempotent alter owner /
-- revoke / grant / comment. No transaction control: the migration runner wraps the file.

-- admin_list_monitor_signups ---------------------------------------------------------------------
-- One row per monitor_user profile: the user id, the profile email, auth.users.created_at,
-- whether email_confirmed_at is set, the number of monitors the account has (0 without any) and
-- those monitors' url, label (null without one) and status ('active' or 'paused'), oldest monitor
-- first. Other roles (owner, admin, mylife_user, none) are never listed. Newest account first,
-- ties by user id.
drop function if exists public.admin_list_monitor_signups();

create function public.admin_list_monitor_signups()
returns table (
  user_id uuid,
  email text,
  created_at timestamptz,
  confirmed boolean,
  monitor_count integer,
  monitors jsonb
)
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
  select p.user_id,
         p.email,
         u.created_at,
         u.email_confirmed_at is not null,
         (select count(*) from public.monitors m where m.user_id = p.user_id)::integer,
         coalesce(
           (select jsonb_agg(jsonb_build_object('url', m.url, 'label', m.label, 'status', m.status)
                             order by m.created_at, m.id)
              from public.monitors m
             where m.user_id = p.user_id),
           '[]'::jsonb
         )
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
  'Admin › Monitor-brugere (owner and admin only, 42501 otherwise; SECURITY DEFINER because it reads auth.users, which authenticated and service_role cannot): every monitor_user account with its user_id (for admin_delete_monitor_user), profile email, created_at, confirmed (email_confirmed_at is set), monitor_count (0 without monitors) and monitors (jsonb array of {url, label, status} of the account''s monitors, oldest first by created_at then id; [] without monitors), newest account first. Returns only the signup list.';

-- PostgREST serves the new signature without waiting for its schema cache to expire.
notify pgrst, 'reload schema';
