-- F0.4 hardening (security audit): allowlist changes reach existing accounts, and the
-- last owner cannot be demoted or deleted.

-- Allowlist -> profiles role sync ----------------------------------------------------------
-- handle_new_user copies the allowlist role into profiles only when the account is created.
-- Without this trigger, removing an allowlist row or changing its role left the existing
-- account with its old role. On DELETE (or an email change) the account behind the old
-- email loses its role; on a role change it gets the new role. Matching uses profiles.email,
-- which handle_new_user stores normalised like the allowlist CHECK (lower(btrim())).
-- An email change grants the new address before revoking the old one, so moving the last
-- owner's entry to another existing account passes the last-owner guard below.
-- Security definer: profiles RLS must not hide the affected row from the caller.
create function private.sync_profile_role_from_allowlist() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    update public.profiles p set role = null
     where p.email = old.email and p.role is not null;
    return null;
  end if;
  if new.email = old.email and new.role = old.role then
    return null;
  end if;
  update public.profiles p set role = new.role
   where p.email = new.email and p.role is distinct from new.role;
  if new.email <> old.email then
    update public.profiles p set role = null
     where p.email = old.email and p.role is not null;
  end if;
  return null;
end;
$$;
create trigger user_allowlist_sync_profile_role after update or delete on public.user_allowlist
  for each row execute function private.sync_profile_role_from_allowlist();

-- At least one owner -----------------------------------------------------------------------
-- Only an owner manages profiles and the allowlist, so demoting or deleting the last owner
-- (directly, through the allowlist sync above, or by deleting the auth.users row) would lock
-- everyone out of access management. AFTER ROW: the statement's changes are complete, so a
-- multi-row statement that removes every owner is caught as well. The advisory lock
-- serialises concurrent owner removals; the check after it reads a fresh snapshot (READ
-- COMMITTED), so two transactions demoting each other's last co-owner cannot both pass.
-- Security definer: the check must count owners the caller's RLS view no longer shows.
create function private.profiles_keep_an_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role is distinct from 'owner' then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if new.role = 'owner' then
      return null;
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtext('public.profiles:last_owner'));
  if not exists (select 1 from public.profiles p where p.role = 'owner') then
    raise exception 'cannot remove the last owner' using errcode = '23514';
  end if;
  return null;
end;
$$;
create trigger profiles_keep_an_owner after update or delete on public.profiles
  for each row execute function private.profiles_keep_an_owner();
