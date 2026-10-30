-- F0.4 hardening (security re-review): profiles.email follows the login email.
-- The allowlist -> profiles sync (0500/0600) matches accounts on profiles.email, which
-- handle_new_user set only at signup. After a login-email change (auth.updateUser; GoTrue
-- writes auth.users.email once the change is confirmed) the profile kept the old address,
-- so a later allowlist insert or update for that address granted a role to an account whose
-- current login email is not allowlisted.

-- Login email -> profiles ------------------------------------------------------------------
-- On an email change the profile takes the new address, normalised like the allowlist CHECK
-- (lower(btrim())), and its role is re-resolved from the allowlist entry for that address:
-- a non-allowlisted address revokes the role, an allowlisted one gets the entry's role. The
-- allowlist stays authoritative, so a role set directly on the profile does not survive the
-- change. The last-owner guard (0500) applies to the result: a sole owner cannot move to an
-- address that is not allowlisted as owner. A null email (no email login) is skipped.
-- Security definer: GoTrue updates auth.users as supabase_auth_admin, which cannot write
-- profiles. Created by postgres, so no EXECUTE for PUBLIC or the API roles (0400).
create function private.sync_profile_email_from_auth() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles p
     set email = lower(btrim(new.email)),
         role  = (select a.role from public.user_allowlist a
                   where a.email = lower(btrim(new.email)))
   where p.user_id = new.id;
  return null;
end;
$$;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (new.email is distinct from old.email and new.email is not null)
  execute function private.sync_profile_email_from_auth();

-- One account per address ----------------------------------------------------------------
-- The allowlist sync updates every profile with the entry's email. auth.users only keeps
-- emails unique case-sensitively (and not for SSO users), so two accounts whose addresses
-- differ in case would share one normalised profiles.email and both get the entry's role.
-- A signup or email change that would collide now fails instead.
create unique index profiles_email_key on public.profiles (email);

-- Last-owner guard: isolation level ---------------------------------------------------------
comment on function private.profiles_keep_an_owner() is
  'Last-owner guard (0500). Assumes READ COMMITTED, the default: the owner check after the '
  'advisory lock must see owner removals committed while it waited. Under REPEATABLE READ it '
  'reads the transaction''s starting snapshot, so two concurrent removals of the last two '
  'owners could both pass. Data API requests cannot choose the isolation level; only a '
  'privileged direct database connection could.';
