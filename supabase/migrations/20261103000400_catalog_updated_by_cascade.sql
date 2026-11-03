-- F2.1 catalog-model (security review follow-up): the updated_by trigger leaves the foreign
-- key's own cascade alone. 20261103000300 stamps items/categories.updated_by with auth.uid() on
-- every insert and update. Deleting an auth.users row runs the `on delete set null` action of
-- items_updated_by_fkey / categories_updated_by_fkey as an UPDATE nested inside the auth.users
-- trigger, and that UPDATE fired the stamp too: in a transaction carrying a user JWT the column
-- got that uid instead of null (wrong attribution) or, when the uid was the user being deleted,
-- 23503 blocked the delete. A write nested in another trigger is never a client write (clients
-- reach these tables only through statements of their own, directly or in an RPC), so only
-- top-level writes (pg_trigger_depth() = 1 inside this function) are stamped.
-- Same signature as 20261103000300: `create or replace` keeps the owner and the (absent) grants;
-- trigger functions are not EXECUTE-checked when they fire.
create or replace function private.stamp_updated_by() returns trigger
language plpgsql set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then
    return new;   -- e.g. the foreign key's on-delete-set-null action: keep its null
  end if;
  new.updated_by := (select auth.uid());
  return new;
end;
$$;
comment on function private.stamp_updated_by() is
  'Trigger: sets updated_by to auth.uid() (null without a user JWT) on every top-level insert and update, overriding any written value; writes nested in another trigger (the foreign key''s on-delete-set-null action when an auth user is deleted) keep their value. Authoritative for categories.updated_by and items.updated_by.';
