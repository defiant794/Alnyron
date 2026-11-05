-- P3 mylife-app (security review): MyLife health data needs the MyLife role, not only ownership.
-- The Flutter app reads and writes mylife_profile / mylife_events through PostgREST with the
-- user's own session, and the Next.js requireMyLife() gateway, which also checked the role, is
-- being retired, so RLS is the only gate left. 0300's policies check ownership only: any
-- signed-in account (an admin, a profile with role = NULL, an account without a profile row)
-- could store and read its own rows in these tables. Every policy now also requires
-- private.is_mylife(): the caller's profile role is owner or mylife_user, the two roles the
-- gateway let in (config/auth-areas.ts). Both checks keep the initPlan form, evaluated once per
-- statement. No table, grant or data changes; the two MyLife users see no difference.

-- Role helper ------------------------------------------------------------------------------
-- Security definer like is_admin() / is_owner(): `authenticated` cannot execute
-- private.current_role_in() or read other profiles, so the check runs as the function owner.
-- Created by postgres, so no EXECUTE for PUBLIC (0400); policies run it as the caller, who
-- needs the grant. anon has neither a table grant nor a policy here, so it gets none.
create function private.is_mylife() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.current_role_in(array['owner', 'mylife_user']::public.app_role[]);
$$;
grant execute on function private.is_mylife() to authenticated;
comment on function private.is_mylife() is
  'True iff the caller''s profile role is owner or mylife_user: the roles allowed to use MyLife (the mylife_* RLS policies).';

-- Policies: own rows AND a MyLife role -------------------------------------------------------
alter policy mylife_profile_select on public.mylife_profile
  using ((select auth.uid()) = user_id and (select private.is_mylife()));
alter policy mylife_profile_insert on public.mylife_profile
  with check ((select auth.uid()) = user_id and (select private.is_mylife()));
alter policy mylife_profile_update on public.mylife_profile
  using ((select auth.uid()) = user_id and (select private.is_mylife()))
  with check ((select auth.uid()) = user_id and (select private.is_mylife()));
alter policy mylife_profile_delete on public.mylife_profile
  using ((select auth.uid()) = user_id and (select private.is_mylife()));

alter policy mylife_events_select on public.mylife_events
  using ((select auth.uid()) = user_id and (select private.is_mylife()));
alter policy mylife_events_insert on public.mylife_events
  with check ((select auth.uid()) = user_id and (select private.is_mylife()));
alter policy mylife_events_update on public.mylife_events
  using ((select auth.uid()) = user_id and (select private.is_mylife()))
  with check ((select auth.uid()) = user_id and (select private.is_mylife()));
alter policy mylife_events_delete on public.mylife_events
  using ((select auth.uid()) = user_id and (select private.is_mylife()));
