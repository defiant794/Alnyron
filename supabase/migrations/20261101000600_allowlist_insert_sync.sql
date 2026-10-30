-- F0.4 hardening (code review): an allowlist INSERT reaches an existing account too.
-- 0500 synced only UPDATE/DELETE, so re-adding a revoked user (or changing a role by
-- delete + insert) left profiles.role null and the account locked out although it is
-- allowlisted again. The new row's role now goes to the account behind its email; on an
-- account created later handle_new_user still copies the role as before. The allowlist
-- stays authoritative: an insert that differs from a role set directly on the profile wins,
-- and the last-owner guard (0500) still applies to the result.
-- create or replace keeps the function's owner and ACL (postgres only, no PUBLIC EXECUTE).
create or replace function private.sync_profile_role_from_allowlist() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.profiles p set role = new.role
     where p.email = new.email and p.role is distinct from new.role;
    return null;
  end if;
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
create or replace trigger user_allowlist_sync_profile_role
  after insert or update or delete on public.user_allowlist
  for each row execute function private.sync_profile_role_from_allowlist();
