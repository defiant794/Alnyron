-- P4 slice C: the owner's notice of new public Monitor signups, the purge of stale
-- unconfirmed Monitor accounts, and the wipe of a pre-registered password.
--
-- The cron Worker `alnyron-monitor-cron` (service_role key) emails the site owner once per new
-- CONFIRMED public `monitor_user` account (Resend key `monitor-signup/<user_id>`), and deletes
-- `monitor_user` accounts that stayed unconfirmed for 24 hours.
--
-- Pre-registration: a stranger signs up with someone else's address and a password of their own,
-- hoping the owner of the address confirms that account later. What GoTrue does when an
-- unconfirmed address signs up again depends on its version (read in the supabase/auth source at
-- v2.197.0, the version the e2e project reports, and on master; the version the hosted project
-- runs is not verified): v2.197.0 keeps the first signup's password and only sends the
-- confirmation again; supabase/auth master (#2868 of 2026-11-03, reverted by #2912, re-landed by
-- #2918 on 2026-11-09) runs the before-user-created hook, then overwrites the password with the
-- latest signup's (User.UpdatePassword) and sends the confirmation again. So the stranger either
-- signs up before the owner (keep-first) or again between the owner's signup and confirmation
-- (last-wins). A password reset is a way in too, also depending on the version: at v2.197.0 the
-- reset link (recoverVerify) confirms an unconfirmed account and keeps its password, so the
-- owner's own reset would confirm the account with the stranger's password still on it; master
-- clears an unconfirmed account's password (ClearUnconfirmedPassword) before confirming it.
-- The trigger monitor_wipe_password_on_resignup handles all of these: it empties the password of
-- an unconfirmed monitor_user account whenever confirmation_sent_at changes from a non-NULL value
-- (the confirmation branch) or recovery_sent_at changes to a new non-NULL value (the recovery
-- branch). In the same source reading GoTrue does that notably in these cases (not exhaustive):
--   - a confirmation is recorded again: the keep-first re-signup and a resend (both email it), an
--     admin generate_link of type signup for the existing account (ignores the submitted password,
--     writes confirmation_token and confirmation_sent_at, returns the link, emails nothing);
--   - User.UpdatePassword writes the new password, confirmation_token and
--     confirmation_sent_at = NULL in ONE UPDATE: the last-wins re-signup (its following send goes
--     NULL -> now, wipes nothing and leaves the password empty) and an admin password change;
--   - User.ClearAllPendingTokens sets confirmation_sent_at = NULL with the other pending tokens:
--     an admin email or phone change without email_confirm, and UpdateUserEmailFromIdentities (an
--     identity link or unlink that replaces the account's address);
--   - a password reset is recorded (the recovery branch): a reset asked with the address (it
--     emails the link) and an admin generate_link of type recovery or magiclink for the existing
--     account (writes recovery_token and recovery_sent_at, returns the link, emails nothing). The
--     password is emptied when the reset is sent, before its link can confirm the account.
-- UpdatePassword and ClearAllPendingTokens also set recovery_sent_at = NULL; the recovery branch
-- wipes nothing on that, and the confirmation_sent_at change decides.
-- So no re-signup's password survives, except on an account never sent a confirmation (master
-- only, e.g. an admin createUser without a send: the second residual below, bounded by a password
-- reset sent for the account and by the 24 h purge). Once a password is emptied, only the mailbox
-- owner can set one, through a password reset. The purge additionally frees addresses stuck on an
-- unconfirmed account and bounds how long a stale pre-registration (and the confirmation link it
-- sent) lasts.
-- Accepted costs: an admin password, email or phone change on an unconfirmed monitor_user account
-- that already had a confirmation sent empties the password in the same UPDATE (an admin update
-- that also sets email_confirm confirms the address first, so it wipes nothing). A stranger can do
-- the same to a pending account by signing up, asking for the confirmation, or asking for a
-- password reset with its address. Recovery is unchanged (the newest link signs in, then "Glemt
-- adgangskode?"); those sends count against the project's email rate limit.
-- Accepted residuals (workers/monitor-cron/README.md, "Accepted residuals"): someone who clicks a
-- stranger's first confirmation without signing up themselves (no later send changes
-- confirmation_sent_at or recovery_sent_at, so nothing is wiped) confirms the stranger's password;
-- and, under master only, an unconfirmed monitor_user account that never had a confirmation sent
-- (confirmation_sent_at NULL, e.g. an admin createUser without a send) keeps a stranger's signup
-- password: the overwrite goes NULL -> NULL and the send NULL -> now. Either password works until
-- it is reset; a password reset sent while the account is still unconfirmed empties it (the
-- recovery branch), and the purge bounds both to confirmations clicked before it deletes the
-- unconfirmed account.
--
-- Additive: one nullable column on public.profiles, one partial index, four functions, one
-- trigger on auth.users, comments. No policy, grant or existing row changes, apart from the
-- one-time backfill below; the trigger only acts on a later UPDATE of an unconfirmed monitor_user
-- account that changes confirmation_sent_at from a non-NULL value or recovery_sent_at to a new
-- non-NULL value. The profiles UPDATE privilege of `authenticated` is table-level, so it covers
-- the new column, but RLS lets only the site owner update profiles: a monitor_user cannot stamp
-- (or clear) their own notice.
--
-- Security: like the engine functions of 20261108000100, every function has an empty search_path,
-- fully qualified names and EXECUTE revoked from PUBLIC, anon and authenticated. The three cron
-- functions grant EXECUTE to service_role only; the trigger function grants it to no role, and
-- service_role holds no EXECUTE on it (checked on the e2e project; go-live runbook step 2 checks
-- it again). monitor_engine_mark_signup_notified is SECURITY INVOKER (service_role holds
-- Supabase's default privileges on public.profiles and bypasses RLS).
-- EXCEPTION: monitor_engine_pending_signups and monitor_engine_purge_unconfirmed are SECURITY
-- DEFINER, owned by postgres. They read (and the purge locks and deletes) auth.users, on which
-- service_role has no privilege at all (checked on the e2e project: has_table_privilege(
-- 'service_role', 'auth.users', 'select' | 'update' | 'delete') = false; the table belongs to
-- supabase_auth_admin and has RLS on), while postgres holds SELECT, UPDATE and DELETE there and
-- bypasses RLS. Granting service_role privileges on auth.users would open the whole table to
-- every holder of the secret key; the two definer functions expose only what the cron needs:
-- the pending notices' addresses and the deletion of accounts their own predicate selects. Their
-- arguments are validated, and only service_role may call them. The trigger function
-- private.monitor_wipe_password_on_resignup is SECURITY DEFINER too, owned by postgres: GoTrue
-- updates auth.users as supabase_auth_admin, and the function reads public.profiles.
--
-- Re-runnable: the column and its backfill sit in one guarded block that does nothing once the
-- column exists, `create index if not exists`, `create or replace function` (keeps oid, owner and
-- ACL), `drop trigger if exists` before `create trigger`, and idempotent alter owner / revoke /
-- grant / comment. No transaction control: the migration runner wraps the file.

-- signup_notified_at -----------------------------------------------------------------------------
-- When the column is first added, every existing monitor_user row is stamped with its own
-- created_at: those accounts existed before the notice, so none of them is emailed, and the
-- historic stamps (not now()) keep them out of the rolling 24 h notice cap, except accounts
-- created under 24 hours before this migration: their stamps count against the cap until they
-- are 24 hours old. A re-apply finds the column and touches nothing, so it can never swallow
-- real signups.
do $$
begin
  if not exists (select 1
                   from pg_catalog.pg_attribute a
                  where a.attrelid = 'public.profiles'::regclass
                    and a.attname = 'signup_notified_at'
                    and not a.attisdropped) then
    alter table public.profiles add column signup_notified_at timestamptz;
    update public.profiles p set signup_notified_at = p.created_at where p.role = 'monitor_user';
  end if;
end;
$$;

comment on column public.profiles.signup_notified_at is
  'monitor_user accounts only: when the cron emailed the site owner about this new confirmed signup (or the provider rejected that notice for good). NULL = not notified: pending while the address was confirmed under 23 h ago and the daily notice cap leaves room, else never notified (still visible here). Accounts that existed when the column was added carry their created_at.';

-- The pending-notice lookup reads only monitor_user rows not yet notified.
create index if not exists profiles_signup_pending_idx
  on public.profiles (user_id)
  where role = 'monitor_user' and signup_notified_at is null;

-- monitor_engine_pending_signups -----------------------------------------------------------------
-- The next new signups to tell the owner about, oldest confirmation first: monitor_user accounts
-- not yet notified whose address was confirmed under 23 hours ago (inside Resend's 24 h
-- idempotency window, so a retry with the same key cannot send twice). At most p_limit rows, and
-- no more than p_daily_cap minus the monitor_user accounts stamped in the last 24 hours. Each row
-- carries `waiting` (the candidates not returned by this call) and `owner_emails` (the email of
-- every role 'owner' profile, oldest profile first; empty when there is none). An unconfirmed
-- account is never returned; one confirmed longer ago, or held back by the cap until it aged out
-- of the 23 h window, stays NULL and is never emailed. SECURITY DEFINER: see the header.
create or replace function public.monitor_engine_pending_signups(p_limit integer, p_daily_cap integer)
returns table (user_id uuid, email text, confirmed_at timestamptz, waiting integer, owner_emails text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_take   integer;
  v_owners text[];
begin
  if p_limit is null or p_limit not between 1 and 100 or p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'monitor_engine_pending_signups: invalid argument' using errcode = '22023';
  end if;

  select least(p_limit, greatest(0, p_daily_cap - count(*)))::integer
    into v_take
    from public.profiles p
   where p.role = 'monitor_user'
     and p.signup_notified_at > now() - interval '24 hours';

  select coalesce(array_agg(p.email order by p.created_at, p.user_id), '{}'::text[])
    into v_owners
    from public.profiles p
   where p.role = 'owner';

  return query
  with candidates as (
    select p.user_id, p.email, u.email_confirmed_at
      from public.profiles p
      join auth.users u on u.id = p.user_id
     where p.role = 'monitor_user'
       and p.signup_notified_at is null
       and u.email_confirmed_at > now() - interval '23 hours'
  ),
  picked as (
    select c.user_id, c.email, c.email_confirmed_at
      from candidates c
     order by c.email_confirmed_at, c.user_id
     limit v_take
  )
  select picked.user_id, picked.email, picked.email_confirmed_at,
         ((select count(*) from candidates) - (select count(*) from picked))::integer,
         v_owners
    from picked
   order by picked.email_confirmed_at, picked.user_id;
end;
$$;

alter function public.monitor_engine_pending_signups(integer, integer) owner to postgres;
revoke all on function public.monitor_engine_pending_signups(integer, integer) from public, anon, authenticated;
grant execute on function public.monitor_engine_pending_signups(integer, integer) to service_role;
comment on function public.monitor_engine_pending_signups(integer, integer) is
  'Monitor cron (service_role only; SECURITY DEFINER because it reads auth.users): up to p_limit monitor_user accounts with signup_notified_at NULL whose address was confirmed under 23 h ago (Resend idempotency window), oldest confirmation first, no more than p_daily_cap minus the monitor_user accounts stamped in the last 24 h. Each row: user_id, the profile email, confirmed_at, waiting (candidates not returned) and owner_emails (role owner profile emails, oldest profile first; empty without an owner). 22023 on p_limit outside 1..100 or a NULL or negative cap.';

-- monitor_engine_mark_signup_notified ------------------------------------------------------------
-- Stamps a monitor_user account notified, once: true when it stamped, false when the row was
-- already stamped, has another role or does not exist (nothing written).
create or replace function public.monitor_engine_mark_signup_notified(p_user_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'monitor_engine_mark_signup_notified: invalid argument' using errcode = '22023';
  end if;
  update public.profiles p
     set signup_notified_at = now()
   where p.user_id = p_user_id
     and p.role = 'monitor_user'
     and p.signup_notified_at is null;
  return found;
end;
$$;

revoke all on function public.monitor_engine_mark_signup_notified(uuid) from public, anon, authenticated;
grant execute on function public.monitor_engine_mark_signup_notified(uuid) to service_role;
comment on function public.monitor_engine_mark_signup_notified(uuid) is
  'Monitor cron (service_role only): stamps profiles.signup_notified_at = now() once, only on a monitor_user row not yet stamped (the owner notice was sent, or permanently rejected). True when it stamped, false otherwise (nothing written). 22023 on a NULL id.';

-- monitor_engine_purge_unconfirmed ---------------------------------------------------------------
-- Deletes up to p_limit monitor_user accounts (auth.users; profile, monitors and the other
-- account rows go by cascade) whose address is still unconfirmed 24 hours after the account was
-- created, oldest first. Rows another transaction holds are skipped (left for a later run). The
-- DELETE re-checks the whole predicate, so an account confirmed concurrently is never deleted.
-- Other roles (owner, admin, mylife_user: allowlisted accounts waiting for their invite) are
-- never touched. Returns the number of accounts deleted. SECURITY DEFINER: see the header.
-- Why: it frees addresses stuck on an unconfirmed account and bounds how long a stale
-- pre-registration lasts; the pre-registered password itself is removed by the
-- monitor_wipe_password_on_resignup trigger below when confirmation_sent_at changes from a
-- non-NULL value or recovery_sent_at to a new non-NULL value, e.g. once the address signs up
-- again, a confirmation is resent or a password reset is sent.
create or replace function public.monitor_engine_purge_unconfirmed(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception 'monitor_engine_purge_unconfirmed: invalid argument' using errcode = '22023';
  end if;

  with doomed as (
    select u.id
      from auth.users u
     where u.email_confirmed_at is null
       and u.created_at < now() - interval '24 hours'
       and exists (select 1 from public.profiles p where p.user_id = u.id and p.role = 'monitor_user')
     order by u.created_at, u.id
     limit p_limit
       for update of u skip locked
  )
  delete from auth.users u
   using doomed d
   where u.id = d.id
     and u.email_confirmed_at is null
     and u.created_at < now() - interval '24 hours'
     and exists (select 1 from public.profiles p where p.user_id = u.id and p.role = 'monitor_user');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

alter function public.monitor_engine_purge_unconfirmed(integer) owner to postgres;
revoke all on function public.monitor_engine_purge_unconfirmed(integer) from public, anon, authenticated;
grant execute on function public.monitor_engine_purge_unconfirmed(integer) to service_role;
comment on function public.monitor_engine_purge_unconfirmed(integer) is
  'Monitor cron (service_role only; SECURITY DEFINER because it deletes from auth.users): deletes up to p_limit monitor_user accounts still unconfirmed 24 h after creation (oldest first, rows locked elsewhere skipped, predicate re-checked in the DELETE). Frees addresses stuck on an unconfirmed account and bounds how long a stale pre-registration lasts (the trigger monitor_wipe_password_on_resignup removes a pre-registered password when confirmation_sent_at changes from a non-NULL value or recovery_sent_at to a new non-NULL value, e.g. once the address signs up again, a confirmation is resent or a password reset is sent). Other roles are never deleted. Returns the number of accounts deleted. 22023 on p_limit outside 1..50.';

-- monitor_wipe_password_on_resignup --------------------------------------------------------------
-- Empties encrypted_password of an unconfirmed monitor_user account, in an UPDATE that leaves the
-- address unconfirmed, when confirmation_sent_at changes from a non-NULL value (the confirmation
-- branch) or recovery_sent_at changes to a new non-NULL value (the recovery branch). The trigger
-- fires on every UPDATE whose SET list names either column; its condition picks out those
-- changes. In the source reading of the header, GoTrue makes them notably (not exhaustive):
-- for the confirmation branch, when it records a confirmation again (a keep-first re-signup or a
-- resend, both emailing it; an admin generate_link of type signup for the existing account, which
-- ignores the submitted password, writes confirmation_token and confirmation_sent_at, returns the
-- link and emails nothing), in User.UpdatePassword, which sets the new password and
-- confirmation_sent_at = NULL in the same UPDATE (a last-wins re-signup, an admin password
-- change), and in User.ClearAllPendingTokens, which sets confirmation_sent_at = NULL with the
-- other pending tokens (an admin email or phone change without email_confirm,
-- UpdateUserEmailFromIdentities); for the recovery branch, when it records a password reset (a
-- reset asked with the address, which emails the link; an admin generate_link of type recovery or
-- magiclink for the existing account, which writes recovery_token and recovery_sent_at, returns
-- the link and emails nothing). Why the recovery branch: at v2.197.0 the reset link confirms an
-- unconfirmed account and keeps its password (master clears that password first), so the send
-- empties it before the link can confirm the account. UpdatePassword and ClearAllPendingTokens
-- also set recovery_sent_at = NULL: the recovery branch's condition is false there, and the
-- confirmation_sent_at change decides. A BEFORE trigger, so the wipe lands in that UPDATE
-- (replacing UpdatePassword's new password); the send that follows an UpdatePassword goes
-- NULL -> now, wipes nothing and leaves the password empty. The confirmation branch's condition is
-- false on a change from NULL (the first send, and both UPDATEs on an account never sent a
-- confirmation: the master-only residual in the header, which a later password reset send does
-- wipe through the recovery branch). Untouched: the confirmation (GoTrue's confirming UPDATE
-- writes confirmation_token and email_confirmed_at, and the reset link's User.Recover before it
-- only recovery_token, so neither names the trigger's columns; an UPDATE that sets
-- email_confirmed_at together with either column is not wiped either), confirmed accounts and
-- other roles (allowlisted accounts are created without a password anyone knows and confirmed by
-- their invite). The confirmation link still signs its owner in; for later sign-ins they set a
-- password through a password reset. SECURITY DEFINER, owned by postgres: see the header. A
-- trigger function is not EXECUTE-checked when it fires, so EXECUTE is granted to no role.
create or replace function private.monitor_wipe_password_on_resignup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.email_confirmed_at is null
     and new.email_confirmed_at is null
     and (   (old.confirmation_sent_at is not null
              and new.confirmation_sent_at is distinct from old.confirmation_sent_at)
          or (new.recovery_sent_at is not null
              and new.recovery_sent_at is distinct from old.recovery_sent_at))
     and exists (select 1 from public.profiles p where p.user_id = new.id and p.role = 'monitor_user') then
    new.encrypted_password := '';
  end if;
  return new;
end;
$$;

alter function private.monitor_wipe_password_on_resignup() owner to postgres;
revoke all on function private.monitor_wipe_password_on_resignup() from public, anon, authenticated;
comment on function private.monitor_wipe_password_on_resignup() is
  'Trigger on auth.users (BEFORE UPDATE OF confirmation_sent_at, recovery_sent_at): empties encrypted_password of an unconfirmed monitor_user account, while email_confirmed_at stays NULL, whenever confirmation_sent_at changes from a non-NULL value (confirmation branch) or recovery_sent_at changes to a new non-NULL value (recovery branch). Per the supabase/auth source (v2.197.0 and master; the hosted version is not verified), GoTrue does that notably (not exhaustive): for the confirmation branch, when it records a confirmation again (a re-signup that keeps the first password or a resend, both emailing it; an admin generate_link of type signup for the existing account, which ignores the submitted password and emails nothing), in User.UpdatePassword, which sets the new password and confirmation_sent_at = NULL in one UPDATE (a re-signup that overwrites the password; an admin password change), and in User.ClearAllPendingTokens, which sets confirmation_sent_at = NULL with the other pending tokens (an admin email or phone change without email_confirm; UpdateUserEmailFromIdentities); for the recovery branch, when it records a password reset (a reset asked with the address, which emails the link; an admin generate_link of type recovery or magiclink for the existing account, which emails nothing), because at v2.197.0 the reset link confirms an unconfirmed account and keeps its password (master clears it first). UpdatePassword and ClearAllPendingTokens also set recovery_sent_at = NULL, on which the recovery branch wipes nothing. So no re-signup''s password survives, except on an account never sent a confirmation (master only, e.g. an admin createUser without a send: both UPDATEs go from NULL; bounded by a password reset sent for the account and by the 24 h purge of unconfirmed accounts). Accepted cost: an admin password, email or phone change on an unconfirmed monitor_user account that already had a confirmation sent empties the password. A stranger can do the same to a pending account by signing up, asking for the confirmation, or asking for a password reset with its address. Recovery is unchanged (the newest link signs in, then "Glemt adgangskode?"); those sends count against the project''s email rate limit. Once a password is emptied, the mailbox owner sets one through a password reset. Untouched: a confirmation_sent_at change from NULL without a new recovery_sent_at (the first send, and the exception above), the confirmation, confirmed accounts and other roles. SECURITY DEFINER (owner postgres): GoTrue updates auth.users as supabase_auth_admin. EXECUTE granted to no role.';

drop trigger if exists monitor_wipe_password_on_resignup on auth.users;
create trigger monitor_wipe_password_on_resignup
  before update of confirmation_sent_at, recovery_sent_at on auth.users
  for each row execute function private.monitor_wipe_password_on_resignup();

-- PostgREST serves the new functions without waiting for its schema cache to expire.
notify pgrst, 'reload schema';
