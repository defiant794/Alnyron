-- P4 monitoring (slice A): public Monitor signup without account squatting.
--
-- Monitor lets anyone sign up (enable_signup is switched on in slice C); admin and MyLife stay
-- invite-only. Until now the before-user-created hook admitted ONLY allowlisted emails. Simply
-- admitting everyone would let a stranger sign up first with an allowlisted address and get its
-- admin or MyLife role from handle_new_user. GoTrue runs the hook on /signup, /invite and
-- /admin/generate_link whenever they create a NEW user, but not on POST /admin/users
-- (admin.createUser), and generate_link(type=invite) for an EXISTING unconfirmed user creates
-- nobody; the hook payload cannot tell a signup from an invite. So:
-- 1. The hook refuses every allowlisted email on every path, whatever user_metadata or
--    app_metadata the request carries (nothing here reads them), and admits every other email.
-- 2. handle_new_user gives a new account its allowlist role, else monitor_user.
-- 3. An allowlist row never elevates a public account: inserting or updating one whose email
--    belongs to a monitor_user raises (the owner deletes that account first), and allowlist
--    changes never touch a monitor_user profile.
-- 4. A monitor_user's login-email change moves the profile email and keeps the role.
-- Admin and MyLife accounts are now created allowlist row -> admin.createUser({ email }) (no
-- hook; handle_new_user copies the allowlist role) -> generate_link({ type: 'invite', email })
-- for that unconfirmed account (docs/runbooks/area-user-onboarding.md).
-- Functions only. create or replace keeps each function's owner, ACL and grants: EXECUTE on
-- the hook for supabase_auth_admin only (core 0100), the private trigger functions postgres
-- only (20261101000400); the triggers themselves are unchanged.

-- Before User Created hook: refuse allowlisted emails ----------------------------------------
-- Matched like the user_allowlist CHECK (lower(btrim())). The message is generic: the app never
-- shows GoTrue's text anyway, and a refusal must not say that the address is allowlisted.
create or replace function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  if exists (select 1 from public.user_allowlist a
             where a.email = lower(btrim(event -> 'user' ->> 'email'))) then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'Kontoen kan ikke oprettes.'));
  end if;
  return '{}'::jsonb;
end;
$$;

-- New account: allowlist role, else a public Monitor account -------------------------------
-- Reached by an allowlisted email only through admin.createUser (the hook refuses it on every
-- other path); every other new account is a public signup. monitor_limit keeps its column
-- default (5).
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, email, role)
  values (new.id, lower(btrim(new.email)),
          coalesce((select a.role from public.user_allowlist a where a.email = lower(btrim(new.email))),
                   'monitor_user'));
  return new;
end;
$$;

-- Allowlist -> profiles: never elevate, never lock out a public account ---------------------
-- 0500/0600 behaviour for every other profile. An INSERT, or an UPDATE that changes the email
-- or role, for an email held by a monitor_user profile raises: granting it would hand a staff
-- role to an account a stranger may have created. A monitor_user profile is never changed by
-- the sync (DELETE and the old email of an email change skip it too).
create or replace function private.sync_profile_role_from_allowlist() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    update public.profiles p set role = null
     where p.email = old.email and p.role is not null and p.role <> 'monitor_user';
    return null;
  end if;
  if tg_op = 'UPDATE' and new.email = old.email and new.role = old.role then
    return null;
  end if;
  if exists (select 1 from public.profiles p where p.email = new.email and p.role = 'monitor_user') then
    raise exception 'allowlist email belongs to a public monitor_user account; delete that account first'
      using errcode = 'P0001';
  end if;
  update public.profiles p set role = new.role
   where p.email = new.email and p.role is distinct from new.role;
  if tg_op = 'UPDATE' and new.email <> old.email then
    update public.profiles p set role = null
     where p.email = old.email and p.role is not null and p.role <> 'monitor_user';
  end if;
  return null;
end;
$$;

-- Login email -> profiles: a public account keeps its role ----------------------------------
-- 0700 behaviour for every other profile (the role is re-resolved from the allowlist entry for
-- the new address). A monitor_user's role is never re-resolved: an allowlisted new address must
-- not elevate it, and any other address must not lock it out.
create or replace function private.sync_profile_email_from_auth() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles p
     set email = lower(btrim(new.email)),
         role  = case
                   when p.role = 'monitor_user' then p.role
                   else (select a.role from public.user_allowlist a
                          where a.email = lower(btrim(new.email)))
                 end
   where p.user_id = new.id;
  return null;
end;
$$;
