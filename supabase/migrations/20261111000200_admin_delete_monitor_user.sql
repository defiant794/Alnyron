-- Admin › Monitor-brugere: deleting a Monitor signup, and the user id the list needs for it.
--
-- public.admin_list_monitor_signups() (20261111000100) gains a leading user_id column; its body,
-- guard and order are unchanged. A changed return type cannot be replaced in place, so the
-- function is dropped and created again with its owner, privileges and comment. The new column
-- is additive: the app deployed before this migration reads the other four by name and keeps
-- working until it is redeployed.
--
-- New public.admin_delete_monitor_user(p_user_id uuid) deletes one monitor_user account for good
-- (Slet on the list): the auth.users row, and through the foreign keys everything the account
-- owns. Only a monitor_user can be deleted this way; owner, admin, mylife_user accounts and
-- accounts without a role are refused, so the function cannot remove staff or MyLife users.
--
-- What the delete takes along (every foreign key to auth.users, public.profiles and
-- public.monitors, checked on the e2e project with pg_constraint; nothing references profiles):
-- - on delete cascade: public.profiles (signup_notified_at included), public.monitors and through
--   them public.monitor_events (composite key to monitors), public.monitor_email_log,
--   public.monitor_engine_strikes, public.mylife_profile, public.mylife_events, and GoTrue's own
--   auth.identities, auth.sessions, auth.mfa_factors, auth.mfa_recovery_code_sets,
--   auth.one_time_tokens, auth.oauth_authorizations, auth.oauth_consents,
--   auth.webauthn_challenges and auth.webauthn_credentials.
-- - on delete set null: updated_by of public.pages, public.categories, public.items and
--   public.site_settings and public.user_allowlist.created_by (only staff write those rows, so
--   only an account that once had a staff role is named there), and GoTrue's
--   auth.scim_users.user_id. The update triggers of the public tables do not refuse that change:
--   pages_system_guard only checks system_key and status, the allowlist sync returns early when
--   email and role are unchanged, and stamp_updated_by writes the calling admin's id instead of
--   null on categories and items.
-- - triggers on the deleted rows: profiles_keep_an_owner only acts on an owner's row (never a
--   monitor_user's); the auth.users triggers fire on insert and update only.
-- So nothing blocks the delete and nothing of the account is left behind. Access tokens issued to
-- it before stay valid until they expire (its sessions are gone, so none is refreshed), but the
-- account they name no longer exists: the role helpers (private.is_admin, is_monitor, is_mylife)
-- find no profile, and any row written for it fails its foreign key to auth.users.
--
-- Locking: the auth.users row, then the profile row, are locked before the role is read, so the
-- role cannot change between the check and the delete (the allowlist sync and an owner's profile
-- update change the role without touching auth.users). auth.users first is the order in which
-- an auth.users email change (the email sync trigger updates the profile) and
-- monitor_engine_purge_unconfirmed (the cascade deletes the profile) lock the two rows, and the
-- purge skips a row locked here, so a concurrent purge or email change waits instead of
-- deadlocking.
--
-- Security: admins only (owner or admin, private.is_admin(); any other caller gets 42501
-- 'forbidden' before anything is read), an empty search_path and fully qualified names. EXECUTE
-- is revoked from PUBLIC, anon and authenticated, then granted to authenticated: the admin panel
-- calls both functions with the signed-in admin's session. P0002 'not_found' when the id names
-- no profile (null included), P0001 'not_monitor_user' for any other role (nothing deleted).
-- EXCEPTION: both are SECURITY DEFINER, owned by postgres. The list reads auth.users and the
-- delete locks and deletes there; authenticated has no privilege on auth.users (nor has
-- service_role, see 20261110000100_monitor_signup_notice.sql), while postgres holds SELECT,
-- UPDATE and DELETE and bypasses RLS (checked on the e2e project). The delete removes only the
-- one account its argument names, and only after the role check.
--
-- Re-runnable: `drop function if exists` before creating the list again, `create or replace
-- function` for the delete (keeps oid, owner and ACL), and idempotent alter owner / revoke /
-- grant / comment. No transaction control: the migration runner wraps the file.

-- admin_list_monitor_signups ---------------------------------------------------------------------
-- One row per monitor_user profile: the user id, the profile email, auth.users.created_at,
-- whether email_confirmed_at is set, and the number of monitors the account has (0 without any).
-- Other roles (owner, admin, mylife_user, none) are never listed. Newest account first, ties by
-- user id.
drop function if exists public.admin_list_monitor_signups();

create function public.admin_list_monitor_signups()
returns table (user_id uuid, email text, created_at timestamptz, confirmed boolean, monitor_count integer)
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
  'Admin › Monitor-brugere (owner and admin only, 42501 otherwise; SECURITY DEFINER because it reads auth.users, which authenticated and service_role cannot): every monitor_user account with its user_id (for admin_delete_monitor_user), profile email, created_at, confirmed (email_confirmed_at is set) and monitor_count (0 without monitors), newest first. Returns only the signup list.';

-- admin_delete_monitor_user ----------------------------------------------------------------------
-- Deletes the monitor_user account p_user_id: its auth.users row, and by cascade its profile,
-- monitors (with their events) and the other account rows listed in the header. Nothing is
-- deleted unless the caller is an admin and the account's role is monitor_user.
create or replace function public.admin_delete_monitor_user(p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role public.app_role;
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Lock order as in the header: auth.users first, then the profile whose role is checked.
  perform 1 from auth.users u where u.id = p_user_id for update;
  select p.role into v_role from public.profiles p where p.user_id = p_user_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- `is distinct from`: a profile without a role (null) is not a monitor_user either.
  if v_role is distinct from 'monitor_user' then
    raise exception 'not_monitor_user' using errcode = 'P0001';
  end if;

  delete from auth.users u where u.id = p_user_id;
end;
$$;

alter function public.admin_delete_monitor_user(uuid) owner to postgres;
revoke all on function public.admin_delete_monitor_user(uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_monitor_user(uuid) to authenticated;
comment on function public.admin_delete_monitor_user(uuid) is
  'Admin › Monitor-brugere, Slet (owner and admin only, 42501 otherwise; SECURITY DEFINER because it deletes from auth.users, which authenticated and service_role cannot): deletes the monitor_user account p_user_id for good, its profile, monitors, monitor events and other account rows going by cascade. Only monitor_user accounts: P0001 not_monitor_user for any other role or none (nothing deleted), P0002 not_found when no profile has that id (null included).';

-- PostgREST serves the new signatures without waiting for its schema cache to expire.
notify pgrst, 'reload schema';
