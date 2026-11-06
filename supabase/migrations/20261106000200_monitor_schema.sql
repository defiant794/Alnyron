-- P4 monitoring: the page-change monitor's data in the shared Supabase project.
--
-- monitors holds each user's watched URLs and the cron's per-URL state (last hash and
-- snapshot, last check, error streak); monitor_events holds one row per detected change.
-- The cron Worker reads due monitors and writes both tables with the service role, which
-- bypasses RLS. profiles.monitor_limit caps how many monitors a user may hold; the owner role
-- has no cap.
--
-- Isolation: this project also holds MyLife health data and the admin, and monitor users sign
-- up publicly, so RLS is the wall. Every policy is `(select auth.uid()) = user_id` AND
-- private.is_monitor() (owner or monitor_user), both evaluated once per statement (initPlan),
-- for `authenticated` only. The monitor gate is its own helper: is_admin / is_owner /
-- is_mylife never admit monitor_user, and no monitor policy reuses them. anon has no grant and
-- no policy. Supabase's default privileges grant ALL on new public tables to anon and
-- authenticated, which includes TRUNCATE (not subject to RLS), so both are revoked before the
-- explicit grants. updated_at is kept current by private.set_updated_at() (core 0100).
--
-- Needs 'monitor_user' committed (20261106000100). Additive: a new profiles column, new
-- tables and functions; no existing policy or row changes.

-- Role helper ------------------------------------------------------------------------------
-- Security definer like is_mylife(): `authenticated` cannot execute private.current_role_in()
-- or read other profiles, so the check runs as the function owner. Created by postgres, so no
-- EXECUTE for PUBLIC (0400); policies run it as the caller, who needs the grant. anon has
-- neither a table grant nor a policy here, so it gets none.
create function private.is_monitor() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.current_role_in(array['owner', 'monitor_user']::public.app_role[]);
$$;
grant execute on function private.is_monitor() to authenticated;
comment on function private.is_monitor() is
  'True iff the caller''s profile role is owner or monitor_user: the roles allowed to use the page-change monitor (the monitors / monitor_events RLS policies).';

-- Per-user cap -----------------------------------------------------------------------------
-- Every profile, new or existing, gets the free cap of 5; NULL = unlimited. The owner role is
-- unlimited whatever this column holds (monitors_limit_per_user reads the role), so an owner
-- promoted later needs no update and a demoted one falls back to its own cap. profiles RLS is
-- unchanged: a user reads their own row, only an owner updates any row, so a user cannot raise
-- their own cap.
alter table public.profiles add column if not exists monitor_limit integer default 5
  constraint profiles_monitor_limit_nonnegative check (monitor_limit >= 0);
comment on column public.profiles.monitor_limit is
  'Most monitors this user may hold (public.monitors); NULL = unlimited, 0 = none. The owner role is unlimited regardless. Enforced by the monitors_limit_per_user trigger.';

-- Tables ------------------------------------------------------------------------------------
-- monitors: one watched URL. The url is fetched by the cron and shown back to its user, so only
-- http(s) URLs without whitespace or markup characters (<>") are stored, at most 2048
-- characters like the catalog's external links (private.external_links_valid); the label is
-- at most 200 characters. interval_minutes is the user's check interval; the cron selects
-- active monitors whose last_checked_at + interval has passed, hence the partial index.
-- (id, user_id) is unique so monitor_events can pin each event to its monitor's owner.
create table if not exists public.monitors (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  url                text not null
                     constraint monitors_url_valid
                     check (char_length(url) <= 2048 and url ~ '^https?://[^[:space:]<>"]+$'),
  label              text constraint monitors_label_length check (char_length(label) <= 200),
  interval_minutes   integer not null check (interval_minutes >= 30),
  status             text not null default 'active' check (status in ('active', 'paused')),
  last_hash          text,
  last_snapshot      text,
  last_checked_at    timestamptz,
  consecutive_errors integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint monitors_id_user_id_key unique (id, user_id)
);
create index if not exists monitors_active_checked_idx on public.monitors (last_checked_at) where status = 'active';
create index if not exists monitors_user_idx on public.monitors (user_id);
create trigger monitors_updated_at before update on public.monitors
  for each row execute function private.set_updated_at();

-- monitor_events: one detected change. Written by the cron (service role); emailed_at is set
-- once the change email has gone out. The composite foreign key ties each event to its monitor
-- AND that monitor's owner, so an event can never carry another user's user_id (the user_id
-- the select / delete policies match on); the owner's account deletion cascades through
-- monitors. The monitor_id index serves that cascade and a monitor's change history.
create table if not exists public.monitor_events (
  id          uuid primary key default gen_random_uuid(),
  monitor_id  uuid not null,
  user_id     uuid not null,
  detected_at timestamptz not null default now(),
  old_hash    text,
  new_hash    text,
  summary     text,
  emailed_at  timestamptz,
  constraint monitor_events_monitor_owner_fkey foreign key (monitor_id, user_id)
    references public.monitors (id, user_id) on delete cascade
);
create index if not exists monitor_events_user_detected_idx on public.monitor_events (user_id, detected_at desc);
create index if not exists monitor_events_monitor_detected_idx on public.monitor_events (monitor_id, detected_at desc);

alter table public.monitors       enable row level security;
alter table public.monitor_events enable row level security;

-- Grants ------------------------------------------------------------------------------------
-- monitors: INSERT and UPDATE are column-level, so a user writes only what they set (url,
-- label, interval_minutes, status; on insert also their own user_id, which the policy checks).
-- The cron's state (last_hash, last_snapshot, last_checked_at, consecutive_errors), id and
-- created_at are written only by the service role or their defaults, so a user can neither
-- forge the cron's state nor name a monitor id (no upsert onto any row). updated_at is set by
-- its default and the monitors_updated_at trigger, which column privileges do not gate. The
-- policies still decide WHICH rows. monitor_events: users read and delete their own; inserts
-- and updates come only from the cron's service role, so `authenticated` holds neither
-- privilege nor policy for them.
revoke all on table public.monitors, public.monitor_events from anon, authenticated;
grant select, delete on public.monitors to authenticated;
grant insert (user_id, url, label, interval_minutes, status) on public.monitors to authenticated;
grant update (url, label, interval_minutes, status) on public.monitors to authenticated;
grant select, delete on public.monitor_events to authenticated;

-- Policies: own rows AND a monitor role -------------------------------------------------------
create policy monitors_select on public.monitors for select to authenticated
  using ((select auth.uid()) = user_id and (select private.is_monitor()));
create policy monitors_insert on public.monitors for insert to authenticated
  with check ((select auth.uid()) = user_id and (select private.is_monitor()));
create policy monitors_update on public.monitors for update to authenticated
  using ((select auth.uid()) = user_id and (select private.is_monitor()))
  with check ((select auth.uid()) = user_id and (select private.is_monitor()));
create policy monitors_delete on public.monitors for delete to authenticated
  using ((select auth.uid()) = user_id and (select private.is_monitor()));

create policy monitor_events_select on public.monitor_events for select to authenticated
  using ((select auth.uid()) = user_id and (select private.is_monitor()));
create policy monitor_events_delete on public.monitor_events for delete to authenticated
  using ((select auth.uid()) = user_id and (select private.is_monitor()));

-- A new url starts a new baseline -------------------------------------------------------------
-- The cron compares each fetch with last_hash / last_snapshot; after the user points a monitor
-- at another url those belong to the old page, so they are cleared and the next check records
-- the new page without reporting a change. Re-setting the same url keeps them. Trigger
-- functions are not EXECUTE-checked when they fire, so it has no grants.
create function private.monitors_reset_on_url_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.url is distinct from old.url then
    new.last_hash := null;
    new.last_snapshot := null;
  end if;
  return new;
end;
$$;
comment on function private.monitors_reset_on_url_change() is
  'Trigger: clears monitors.last_hash and last_snapshot when url changes, so the cron takes a new baseline instead of reporting the other page as a change.';

create trigger monitors_reset_on_url_change before update of url on public.monitors
  for each row execute function private.monitors_reset_on_url_change();

-- Limit: at most profiles.monitor_limit monitors per user ------------------------------------
-- The single source of the cap for every insert (a user's session or the service role). The
-- user's profile row is locked first, so concurrent inserts for one user queue up and each
-- counts the rows committed before it (READ COMMITTED: every statement of the function takes a
-- new snapshot), like media_limit_per_item. Security definer: the caller may not lock its
-- profile row (profiles UPDATE is owner-only) and the count must see every row of the user.
-- A signed-in session inserting for another user is not counted: the monitors_insert policy,
-- checked after this BEFORE trigger, refuses that row anyway (42501), and counting it would
-- lock the other user's profile and reveal whether they are at their cap (P0001). The service
-- role (the cron) and postgres carry no JWT `sub`, so their inserts are always counted.
-- Unlimited: the owner role, whatever monitor_limit holds, and a NULL monitor_limit.
-- No profile row: the insert is not counted. For `authenticated` the monitors_insert policy
-- refuses it anyway (is_monitor() needs a profile role, 42501); only a privileged writer
-- passes. `authenticated` holds no UPDATE privilege on user_id, so a user cannot move a monitor
-- to another account; the trigger covers inserts only. Trigger functions are not EXECUTE-checked
-- when they fire, so it has no grants.
create function private.monitors_limit_per_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_caller uuid := auth.uid();
  v_role   public.app_role;
  v_limit  integer;
begin
  if v_caller is not null and new.user_id is distinct from v_caller then
    return new;
  end if;
  select p.role, p.monitor_limit into v_role, v_limit
    from public.profiles p where p.user_id = new.user_id for update;
  if not found or v_role = 'owner' or v_limit is null then
    return new;
  end if;
  if (select count(*) from public.monitors m where m.user_id = new.user_id) >= v_limit then
    raise exception 'monitor_limit_reached' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
comment on function private.monitors_limit_per_user() is
  'Trigger: refuses a monitors insert when the user already holds profiles.monitor_limit monitors (P0001 monitor_limit_reached); the owner role and a NULL limit are unlimited. Locks the user''s profile row first so concurrent inserts cannot both pass. Skips a signed-in session''s insert for another user, which monitors_insert refuses (42501).';

create trigger monitors_limit_per_user before insert on public.monitors
  for each row execute function private.monitors_limit_per_user();
