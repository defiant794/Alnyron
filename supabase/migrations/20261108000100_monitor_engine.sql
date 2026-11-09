-- P4 slice B: the monitor engine's database interface.
--
-- The cron Worker `alnyron-monitor-cron` checks monitored pages with a dedicated Supabase
-- secret (service_role) key and touches the database ONLY through the five functions below.
-- Each is SECURITY INVOKER with an empty search_path and fully qualified names; its only
-- caller, service_role, bypasses RLS and holds Supabase's default table privileges. EXECUTE is
-- revoked from PUBLIC, anon and authenticated (Supabase's per-schema default privileges grant
-- new public functions to both API roles) and granted to service_role only.
--
-- Additive apart from one replaced trigger function and dropped outdated versions of this file's
-- own monitor_engine_record and monitor_engine_claim (see below): one nullable column on
-- public.monitors, one partial index on public.monitor_events, two engine-only tables
-- (public.monitor_email_log, public.monitor_engine_strikes), five functions, comments, and
-- private.monitors_reset_on_url_change (20261106000200) now also ending the error streak on a new
-- url. No policy, grant or row of an existing object changes; `authenticated` gets no privilege on
-- the new column (its monitors INSERT/UPDATE grants are column-level; SELECT is table-level, so a
-- user can read it on their own rows) and none on the new tables.
--
-- Re-runnable: `add column if not exists`, `create table / index if not exists`, `create or
-- replace function` (keeps owner and ACL), and idempotent revoke / grant / comment, so a corrected
-- version of this file can be applied again to a project that already ran it. `create or replace`
-- cannot change a function's argument list or result columns, so outdated versions are dropped
-- first, each drop a no-op on a fresh apply and on a re-apply of this version: the first (8
-- arguments, before p_daily_cap) and second (9 arguments, before p_repay) overloads of
-- monitor_engine_record, and a monitor_engine_claim whose result has no prior_strikes column (it
-- is created again below with its grants and comment).
drop function if exists public.monitor_engine_record(uuid, text, text, text, text, text, text, integer);
drop function if exists public.monitor_engine_record(uuid, text, text, text, text, text, text, integer, integer);
do $$
begin
  if exists (select 1
               from pg_catalog.pg_proc p
              where p.oid = to_regprocedure('public.monitor_engine_claim(integer, integer, integer)')
                and not ('prior_strikes' = any (p.proargnames))) then
    drop function public.monitor_engine_claim(integer, integer, integer);
  end if;
end;
$$;

-- Error notification state ----------------------------------------------------------------------
alter table public.monitors add column if not exists error_notified_at timestamptz;
comment on column public.monitors.error_notified_at is
  'When the cron claimed the current error streak''s one "Vi kan ikke hente" notification (sent, attempted, or skipped because sending had stopped, the run''s subrequest budget ran out or the account has no email); NULL while none was claimed. Set by monitor_engine_record when consecutive_errors reaches the threshold and the owner is under the daily email cap, cleared by the next successful check or a new url.';

comment on column public.monitor_events.emailed_at is
  'When the change email was handed to Resend, or permanently rejected (no retry). NULL = pending: the cron retries it (same Resend idempotency key) while detected_at is under 23 hours old and the user is under the daily email cap.';

-- A new url starts a new baseline and a new error streak -----------------------------------------
-- Replaces the trigger function of 20261106000200 (same trigger, same empty search_path, still
-- no grants: trigger functions are not EXECUTE-checked when they fire). Besides the old page's
-- last_hash / last_snapshot, a new url now also clears the old page's failure count (including a
-- claim's provisional failure) and its streak's notification stamp: otherwise a new url that
-- fails from its first check would inherit them and, with the stamp set, never send its own
-- "Vi kan ikke hente". Re-setting the same url keeps all four.
create or replace function private.monitors_reset_on_url_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.url is distinct from old.url then
    new.last_hash := null;
    new.last_snapshot := null;
    new.consecutive_errors := 0;
    new.error_notified_at := null;
  end if;
  return new;
end;
$$;
comment on function private.monitors_reset_on_url_change() is
  'Trigger: when url changes, clears monitors.last_hash and last_snapshot (the cron takes a new baseline instead of reporting the other page as a change) and resets consecutive_errors and error_notified_at (the new page starts a new error streak).';

-- monitor_email_log ------------------------------------------------------------------------------
-- One row per monitor email the engine sent or claimed: a change email when
-- monitor_engine_mark_emailed stamps its event, an error email when monitor_engine_record claims
-- a streak's notification. The daily email cap counts these rows, not monitor_events: users may
-- delete their events (directly, or with their monitor by cascade) but have no privilege at all
-- on this table, so deleting and re-creating cannot reset the cap. Only service_role (and the
-- postgres owner) touch it: RLS on with no policy, every privilege revoked from the API roles,
-- also on the identity sequence. Rows go with the account (auth.users cascade) and are pruned by
-- the engine once older than 48 hours (the cap looks back 24).
create table if not exists public.monitor_email_log (
  id      bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind    text not null check (kind in ('change', 'error')),
  sent_at timestamptz not null default now()
);
create index if not exists monitor_email_log_user_sent_idx on public.monitor_email_log (user_id, sent_at desc);
alter table public.monitor_email_log enable row level security;
revoke all on table public.monitor_email_log from public, anon, authenticated;
revoke all on sequence public.monitor_email_log_id_seq from public, anon, authenticated;
comment on table public.monitor_email_log is
  'Engine-only send log of monitor emails (kind change | error), the basis of the per-user daily email cap. Users cannot read or delete it (RLS on, no policy, no privilege for anon/authenticated), so the cap survives deleting events or monitors. Written by monitor_engine_mark_emailed and monitor_engine_record; rows older than 48 h are pruned by them.';

-- monitor_engine_strikes -------------------------------------------------------------------------
-- Per account: the strikes left by checks of runs that died between claim and record (CPU limit,
-- crash, a failed record call), plus those of checks a running run has claimed and not recorded
-- yet. monitor_engine_claim adds one for every monitor it leases and returns each owner's count
-- from before it (prior_strikes): every strike present then, an overlapping run's unfinished
-- checks included (the cron Worker's Paid profile can overlap runs). monitor_engine_record takes
-- off one for every recorded check (the strike its claim added) and, for an applied unchanged,
-- baseline or changed whose owner had strikes before its claim (p_repay), one more; never below
-- 0. Per check that is +1 when it dies, 0 for an error, a stale result or a good check of an owner
-- without strikes, and -1 for a good check of an owner with strikes. A claim leases at most one
-- monitor of all owners with strikes (see below), so a good check never repays a strike added by
-- its own claim: an owner whose page kills a run keeps at least that check's strike, unless a good
-- check in an overlapping run, claimed while that page was being checked, already repaid it (which
-- can leave the owner at 0).
-- All owners with strikes share one slot per batch (see monitor_engine_claim): only the oldest due
-- monitor of all of theirs can be leased, after every monitor of the owners without strikes and
-- only when those leave room in the batch, until good checks from later claims have repaid their
-- strikes, one each. A page whose owner has strikes is therefore the last check of its batch: when
-- it kills the run again, no other monitor loses its check. A kill while its owner had no strikes
-- (the first, or one after a residual below) leaves the monitors after it in that batch
-- unchecked: each keeps the claim's provisional failure and adds a strike to its owner, who then
-- waits for the slot as well. Those monitors are never leased in one batch with the page while
-- both owners have strikes, so its further kills cost them nothing: they are only delayed, at
-- most one per batch. Each of them due with the page is checked no later than the page's second
-- lease after the kill (each lease moves the page behind them in the queue) while the page's
-- owner keeps strikes, unless another kill leaves it unchecked again. An owner hit once is back at
-- 0 after their next good check; an owner whose checks keep dying keeps gaining strikes. While
-- runs overlap, an owner with a check the other run has not recorded yet counts as having
-- strikes, so their other due monitors wait for the slot too (delayed only: no provisional
-- failure, no strike).
-- Residuals (accepted), apart from the guarantees above:
-- - Once repaid, by a later or an overlapping run, the owner's monitors are claimed in plain age
--   order again, a page that killed a run included, until it kills again; only that monitor's own
--   backoff slows it down (consecutive_errors: +1 for every claim its run never records, reset by
--   a good check, a new url or a re-created monitor). Each such kill costs every monitor checked
--   after it in that batch its check (it waits until due again, its provisional failure kept),
--   the batch's monitor of an owner with strikes included: at most one monitor per kill with the
--   Free profile's batch of 2. Nothing caps how often that repeats while overlapping runs keep
--   repaying the page's strikes.
-- - Drain rate: the slot leases one monitor of the owners with strikes per run, at most 1440 a
--   day with the Free profile (a run a minute) and 288 a day with the Paid profile (a run every 5
--   minutes). One kill on Paid leaves at most the 24 monitors of its batch unchecked (at most 24
--   owners struck, the page's included); once due again they take the slot one per run, oldest
--   first, so all of them within 24 runs (2 hours) when no older monitor of an owner with
--   strikes waits. That needs room, though: while the owners without strikes fill every batch,
--   monitors of owners with strikes wait with no bound.
-- Unlike consecutive_errors, which lives on the monitor row (a new url resets it, a deleted
-- monitor takes it along), strikes belong to the account: users have no privilege at all on this
-- table (RLS on with no policy, everything revoked from the API roles), so editing a url or
-- deleting and re-creating a monitor leaves them. Rows go with the account (auth.users cascade).
create table if not exists public.monitor_engine_strikes (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  strikes    integer not null default 0 check (strikes >= 0),
  updated_at timestamptz not null default now()
);
alter table public.monitor_engine_strikes enable row level security;
revoke all on table public.monitor_engine_strikes from public, anon, authenticated;
comment on table public.monitor_engine_strikes is
  'Engine-only per-user count of strikes of claimed checks not recorded: left by killed runs, or still running (an overlapping run''s unfinished checks count too). monitor_engine_claim adds 1 per leased monitor and returns the owner''s count from before it as prior_strikes; monitor_engine_record takes off 1 per recorded check, plus 1 more for an applied unchanged/baseline/changed when p_repay (the owner had strikes before that claim), not below 0. A good check never repays a strike of its own claim, though one in an overlapping run can repay a killing page''s strike before the kill. Users with strikes share at most one monitor per batch (the oldest due one of all of theirs, leased only when the users without strikes leave room, checked last) until good checks from later claims have repaid them (one each). Users cannot read or reset it (RLS on, no policy, no privilege for anon/authenticated); it is independent of monitor rows, so url edits and deleting or re-creating monitors leave it.';

-- monitor_engine_claim ---------------------------------------------------------------------------
-- Takes up to p_limit due monitors and leases them in one statement: last_checked_at = now(), and
-- consecutive_errors + 1 as a provisional failure that a successful record resets to 0. A run that
-- dies between claim and record (e.g. a page that exhausts the Worker's CPU limit) so still counts
-- as a failed check, and the monitor backs off instead of being retried at every interval.
-- Returns the PRE-claim consecutive_errors. Due: active, the owner's profile role is owner or
-- monitor_user, and never checked or last checked at least the effective interval (minus
-- p_grace_minutes) ago. The effective interval backs off from p_error_threshold failures on: x2,
-- x4, x8, then x16, capped at 7 days but never below the monitor's own interval. The interval is
-- capped at 7 days BEFORE the multiplication (same result, at most 10080 x 16): interval_minutes
-- is user-writable with no upper bound in the table, and an int4 overflow (22003) would fail
-- every claim for every user.
-- Order, in which the rows are also returned (the run checks them in it): users without strikes
-- first, then oldest coalesce(last_checked_at, created_at), then id. Users cannot write
-- created_at, so a deleted and re-created monitor queues behind every overdue one instead of
-- jumping the queue. Users with strikes (see monitor_engine_strikes) share one slot per batch:
-- their due monitors are ranked in that same order (striker_rank) and only the first is a
-- candidate, after those of every user without strikes, who get their normal share, so it is the
-- batch's last check. The monitors a kill of it left unchecked (their owners now have strikes
-- too) never share a batch with it while both owners have strikes, and each of its leases moves
-- it behind them in the queue. Strikes last until good checks from later claims have repaid them,
-- unless a good check in an overlapping run repaid a killing page's strike before the kill (an
-- accepted residual, see monitor_engine_strikes). If a concurrent claim holds that candidate
-- (locked, or stamped after this statement's snapshot), this batch takes no monitor of a user
-- with strikes. Every leased monitor adds one strike to its owner until its record takes it off,
-- so while runs overlap a user with a check the other run has not recorded counts as having
-- strikes.
-- Each row also returns its owner's strikes from before this claim (prior_strikes, the count the
-- ranking read, an overlapping run's unfinished checks included), which the run passes to
-- monitor_engine_record as p_repay = prior_strikes > 0.
-- (Apart from that no per-user share of a batch in v1: one person with many accounts can still
-- crowd it.)
-- The ranking (a window function, which cannot share a query level with FOR UPDATE) runs in a
-- CTE without locks; the locking select then takes the kept candidates in order with FOR UPDATE
-- SKIP LOCKED, so a concurrent claim skips rows another claim holds and two overlapping runs never
-- check the same monitor. A row that a concurrent claim stamped after this statement's snapshot is
-- rechecked on its locked version (last_checked_at unchanged, still active) and dropped. Strikes
-- are added in user_id order: overlapping claims that lease monitors of the same user wait for
-- each other's strike row (a single short statement) instead of deadlocking.
create or replace function public.monitor_engine_claim(p_limit integer, p_grace_minutes integer, p_error_threshold integer)
returns table (id uuid, user_id uuid, url text, last_hash text, consecutive_errors integer, prior_strikes integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_limit is null or p_limit not between 1 and 500
     or p_grace_minutes is null or p_grace_minutes < 0
     or p_error_threshold is null or p_error_threshold < 1 then
    raise exception 'monitor_engine_claim: invalid argument' using errcode = '22023';
  end if;

  return query
  with ranked as materialized (
    select m.id,
           m.last_checked_at,
           coalesce(s.strikes, 0) as strikes,
           case when coalesce(s.strikes, 0) > 0 then
             row_number() over (partition by coalesce(s.strikes, 0) > 0
                                order by coalesce(m.last_checked_at, m.created_at), m.id)
           end as striker_rank
      from public.monitors m
      join public.profiles p on p.user_id = m.user_id
      left join public.monitor_engine_strikes s on s.user_id = m.user_id
     where m.status = 'active'
       and p.role in ('owner', 'monitor_user')
       and (m.last_checked_at is null
            or m.last_checked_at
               <= now()
                  - make_interval(mins => greatest(
                      m.interval_minutes,
                      least(
                        least(m.interval_minutes, 10080)
                          * (1 << least(greatest(m.consecutive_errors - (p_error_threshold - 1), 0), 4)),
                        10080)))
                  + make_interval(mins => p_grace_minutes))
  ),
  due as (
    select m.id,
           m.consecutive_errors,
           r.strikes as prior_strikes,
           coalesce(m.last_checked_at, m.created_at) as queued_at
      from ranked r
      join public.monitors m on m.id = r.id
     where (r.strikes = 0 or r.striker_rank = 1)
       and m.status = 'active'
       and m.last_checked_at is not distinct from r.last_checked_at
     order by r.strikes > 0, coalesce(m.last_checked_at, m.created_at), m.id
     limit p_limit
     for update of m skip locked
  ),
  claimed as (
    update public.monitors m
       set last_checked_at = now(), consecutive_errors = m.consecutive_errors + 1
      from due
     where m.id = due.id
    returning m.id, m.user_id, m.url, m.last_hash, due.consecutive_errors, due.prior_strikes, due.queued_at
  ),
  struck as (
    insert into public.monitor_engine_strikes as s (user_id, strikes)
    select claimed.user_id, count(*)::integer
      from claimed
     group by claimed.user_id
     order by claimed.user_id
    on conflict (user_id) do update
      set strikes = s.strikes + excluded.strikes, updated_at = now()
  )
  select claimed.id, claimed.user_id, claimed.url, claimed.last_hash, claimed.consecutive_errors, claimed.prior_strikes
    from claimed
   order by claimed.prior_strikes > 0, claimed.queued_at, claimed.id;
end;
$$;

revoke execute on function public.monitor_engine_claim(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.monitor_engine_claim(integer, integer, integer) to service_role;
comment on function public.monitor_engine_claim(integer, integer, integer) is
  'Monitor cron (service_role only): leases up to p_limit due active monitors of owner/monitor_user accounts by stamping last_checked_at and adding a provisional failure to consecutive_errors (reset by a successful monitor_engine_record), skipping rows a concurrent claim holds, and adds one monitor_engine_strikes strike per leased monitor to its owner (taken off by monitor_engine_record); returns the pre-claim consecutive_errors and the owner''s strikes from before this claim (prior_strikes; the run passes prior_strikes > 0 to monitor_engine_record as p_repay). Order (also of the returned rows): owners without strikes first, then oldest coalesce(last_checked_at, created_at), then id; then all owners with strikes together get at most one monitor, the first of all their due ones in that order (none if a concurrent claim holds it). Due = never checked or checked >= effective interval - p_grace_minutes ago; effective interval = greatest(interval, least(least(interval, 7 days) * 2^least(greatest(errors - (p_error_threshold - 1), 0), 4), 7 days)) (capped before multiplying, so no interval overflows). 22023 on p_limit outside 1..500, negative grace or threshold < 1.';

-- monitor_engine_snapshot ------------------------------------------------------------------------
-- The stored text of a monitor's page (only needed when its hash changed, to build the summary).
create or replace function public.monitor_engine_snapshot(p_monitor_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select m.last_snapshot from public.monitors m where m.id = p_monitor_id;
$$;

revoke execute on function public.monitor_engine_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.monitor_engine_snapshot(uuid) to service_role;
comment on function public.monitor_engine_snapshot(uuid) is
  'Monitor cron (service_role only): monitors.last_snapshot of one monitor, or NULL (none stored, or no such monitor).';

-- monitor_engine_record --------------------------------------------------------------------------
-- Stores the outcome of one check. Every write to the monitor is guarded by the URL the run
-- claimed, so a user editing the URL (which also clears hash, snapshot, failure count and
-- notification stamp, see monitors_reset_on_url_change above), or deleting the monitor mid-run,
-- makes the result stale: applied = false and the monitor is not written. A change additionally
-- needs the monitor still active and its stored hash still the one the run compared against; only
-- then is the monitor_events row inserted (its id is returned).
-- unchanged / baseline / changed reset consecutive_errors to 0. An error does not add to it again
-- (the claim already counted the failure): it only claims the streak's one notification, in the
-- same transaction (row locked first), when the stored count reached p_error_threshold, none was
-- claimed yet, the monitor is active and the owner's monitor_email_log holds fewer than
-- p_daily_cap rows from the last 24 hours. A claimed notification is logged at once (kind
-- 'error'), sent or not; at the cap error_notified_at stays NULL, so a later failure of the
-- streak can still notify once the window frees. At most one error email per streak, and a failed
-- send is not retried.
-- Every call, applied or not and whatever the outcome, then takes strikes off the monitor's owner
-- (monitor_engine_strikes, never below 0): one, the strike its claim added (the run survived this
-- check; a run that dies before recording leaves it), and for an applied unchanged, baseline or
-- changed with p_repay true one more, repaying a strike its owner had at claim time: one left by
-- a check that never recorded, or one of an overlapping run's checks still unrecorded. The run
-- passes p_repay = the claim's prior_strikes > 0, so a good check repays only strikes its owner
-- had before its claim, never one added by the same claim: the claim leases at most one monitor
-- of all owners with strikes, so the flag cannot cover a sibling's strike, and an owner without
-- strikes whose page kills the run after a good check of theirs in that run keeps that page's
-- strike, unless a good check in an overlapping run, claimed while that page was being checked,
-- already repaid it (an accepted residual, see monitor_engine_strikes). A monitor deleted
-- mid-check has no owner left to find, so that strike stays until a good check from a later claim
-- repays it. The strike row is locked after the monitor row, in the same order as in
-- monitor_engine_claim. Always returns exactly one row.
-- The hash, snapshot and summary parameters are optional (default NULL) because not every outcome
-- uses them, which lets PostgREST callers simply omit them. p_error_threshold, p_daily_cap and
-- p_repay follow them, so PostgreSQL requires defaults for them too, but NULL is refused like a
-- threshold below 1 or a negative cap.
create or replace function public.monitor_engine_record(
  p_monitor_id uuid,
  p_claimed_url text,
  p_outcome text,
  p_expected_hash text default null,
  p_new_hash text default null,
  p_snapshot text default null,
  p_summary text default null,
  p_error_threshold integer default null,
  p_daily_cap integer default null,
  p_repay boolean default null)
returns table (
  applied boolean,
  event_id uuid,
  notify_error boolean,
  notified_at timestamptz,
  email text,
  url text,
  label text,
  consecutive_errors integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user_id  uuid;
  v_url      text;
  v_label    text;
  v_status   text;
  v_notified timestamptz;
  v_errors   integer;
  v_applied  boolean;
  v_notify   boolean := false;
  v_now      timestamptz := now();
  v_event_id uuid;
  v_email    text;
begin
  if p_outcome is null or p_outcome not in ('unchanged', 'baseline', 'changed', 'error')
     or p_error_threshold is null or p_error_threshold < 1
     or p_daily_cap is null or p_daily_cap < 0
     or p_repay is null
     or (p_outcome in ('baseline', 'changed') and p_new_hash is null) then
    raise exception 'monitor_engine_record: invalid argument' using errcode = '22023';
  end if;

  if p_outcome = 'unchanged' then
    update public.monitors m
       set consecutive_errors = 0, error_notified_at = null
     where m.id = p_monitor_id and m.url = p_claimed_url
    returning m.consecutive_errors into v_errors;
    v_applied := found;
  elsif p_outcome = 'baseline' then
    update public.monitors m
       set last_hash = p_new_hash, last_snapshot = p_snapshot, consecutive_errors = 0, error_notified_at = null
     where m.id = p_monitor_id and m.url = p_claimed_url
    returning m.consecutive_errors into v_errors;
    v_applied := found;
  elsif p_outcome = 'changed' then
    update public.monitors m
       set last_hash = p_new_hash, last_snapshot = p_snapshot, consecutive_errors = 0, error_notified_at = null
     where m.id = p_monitor_id and m.url = p_claimed_url
       and m.status = 'active' and m.last_hash is not distinct from p_expected_hash
    returning m.user_id, m.consecutive_errors into v_user_id, v_errors;
    v_applied := found;
    if v_applied then
      insert into public.monitor_events (monitor_id, user_id, old_hash, new_hash, summary)
      values (p_monitor_id, v_user_id, p_expected_hash, p_new_hash, p_summary)
      returning id into v_event_id;
    end if;
  else
    select m.user_id, m.url, m.label, m.status, m.error_notified_at, m.consecutive_errors
      into v_user_id, v_url, v_label, v_status, v_notified, v_errors
      from public.monitors m
     where m.id = p_monitor_id and m.url = p_claimed_url
       for update;
    v_applied := found;
    if v_applied and v_errors >= p_error_threshold and v_notified is null and v_status = 'active' then
      delete from public.monitor_email_log l
       where l.user_id = v_user_id and l.sent_at < v_now - interval '48 hours';
      v_notify := (select count(*)
                     from public.monitor_email_log l
                    where l.user_id = v_user_id and l.sent_at > v_now - interval '24 hours') < p_daily_cap;
      if v_notify then
        update public.monitors m set error_notified_at = v_now where m.id = p_monitor_id;
        insert into public.monitor_email_log (user_id, kind) values (v_user_id, 'error');
        select p.email into v_email from public.profiles p where p.user_id = v_user_id;
      end if;
    end if;
  end if;

  update public.monitor_engine_strikes s
     set strikes = greatest(s.strikes - case when p_repay and v_applied and p_outcome <> 'error' then 2 else 1 end, 0),
         updated_at = v_now
    from public.monitors m
   where m.id = p_monitor_id and s.user_id = m.user_id and s.strikes > 0;

  if not v_applied then
    return query select false, null::uuid, false, null::timestamptz, null::text, null::text, null::text, null::integer;
    return;
  end if;

  return query
  select true,
         v_event_id,
         v_notify,
         case when v_notify then v_now end,
         case when v_notify then v_email end,
         case when v_notify then v_url end,
         case when v_notify then v_label end,
         v_errors;
end;
$$;

revoke execute on function public.monitor_engine_record(uuid, text, text, text, text, text, text, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.monitor_engine_record(uuid, text, text, text, text, text, text, integer, integer, boolean) to service_role;
comment on function public.monitor_engine_record(uuid, text, text, text, text, text, text, integer, integer, boolean) is
  'Monitor cron (service_role only): records one check (p_outcome unchanged | baseline | changed | error) for the monitor if its url is still p_claimed_url; else applied = false and the monitor is not written. unchanged/baseline/changed reset consecutive_errors and error_notified_at; baseline/changed store p_new_hash and p_snapshot (already capped by the caller). changed also needs status active and last_hash = p_expected_hash, then inserts monitor_events and returns event_id. error leaves consecutive_errors as the claim counted it and, at >= p_error_threshold with no notification yet on an active monitor whose owner has fewer than p_daily_cap monitor_email_log rows in the last 24 h, stamps error_notified_at, logs an error email and returns notify_error with the owner''s email, url and label (at most once per streak); also prunes the owner''s log rows older than 48 h. Every call takes monitor_engine_strikes off the monitor''s owner, not below 0: 2 after an applied unchanged/baseline/changed with p_repay true (its own claim''s strike and one the owner had before that claim; the run passes the claim''s prior_strikes > 0), else 1 (an error, a result that was not applied, or p_repay false); none for a deleted monitor. 22023 on an unknown outcome, a threshold < 1, a NULL or negative cap, a NULL p_repay, or a missing hash.';

-- monitor_engine_pending_emails ------------------------------------------------------------------
-- Change events still to be emailed, oldest first: not yet emailed, detected under 23 hours ago
-- (inside Resend's 24 h idempotency window, so a retry with the same key cannot send twice), of
-- an owner/monitor_user account with an email. Per user at most p_daily_cap minus the user's
-- monitor_email_log rows (change and error emails) of the last 24 hours; the rest wait (and show
-- in the panel only once they age out of the 23 h window).
--
-- The partial index serves the pending filter (emailed_at is null, detected_at in the last
-- 23 hours): it holds only unemailed events, ordered by detected_at, so each run's lookups read
-- just the last 23 hours of them instead of scanning the whole, ever-growing table.
create index if not exists monitor_events_pending_idx
  on public.monitor_events (detected_at)
  where emailed_at is null;

create or replace function public.monitor_engine_pending_emails(p_limit integer, p_daily_cap integer)
returns table (
  event_id uuid,
  monitor_id uuid,
  user_id uuid,
  email text,
  url text,
  label text,
  detected_at timestamptz,
  summary text)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_limit is null or p_limit not between 1 and 500 or p_daily_cap is null or p_daily_cap < 0 then
    raise exception 'monitor_engine_pending_emails: invalid argument' using errcode = '22023';
  end if;

  return query
  with pending as (
    select e.id, e.monitor_id, e.user_id, p.email, m.url, m.label, e.detected_at, e.summary,
           row_number() over (partition by e.user_id order by e.detected_at, e.id) as user_seq
      from public.monitor_events e
      join public.monitors m on m.id = e.monitor_id and m.user_id = e.user_id
      join public.profiles p on p.user_id = e.user_id
     where e.emailed_at is null
       and e.detected_at > now() - interval '23 hours'
       and p.email is not null
       and p.role in ('owner', 'monitor_user')
  ),
  sent as (
    select l.user_id, count(*) as emails
      from public.monitor_email_log l
     where l.sent_at > now() - interval '24 hours'
       and l.user_id in (select pending.user_id from pending)
     group by l.user_id
  )
  select pending.id, pending.monitor_id, pending.user_id, pending.email, pending.url, pending.label,
         pending.detected_at, pending.summary
    from pending
    left join sent on sent.user_id = pending.user_id
   where pending.user_seq <= p_daily_cap - coalesce(sent.emails, 0)
   order by pending.detected_at, pending.id
   limit p_limit;
end;
$$;

revoke execute on function public.monitor_engine_pending_emails(integer, integer) from public, anon, authenticated;
grant execute on function public.monitor_engine_pending_emails(integer, integer) to service_role;
comment on function public.monitor_engine_pending_emails(integer, integer) is
  'Monitor cron (service_role only): up to p_limit unemailed change events detected under 23 h ago (Resend idempotency window) of owner/monitor_user accounts with an email, oldest first, each user capped at p_daily_cap minus their monitor_email_log rows (change and error emails) of the last 24 h. 22023 on p_limit outside 1..500 or a NULL or negative cap.';

-- monitor_engine_mark_emailed --------------------------------------------------------------------
-- Stamps an event emailed once and logs that change email for the daily cap (pruning the owner's
-- log rows older than 48 hours); a second call finds it stamped and writes nothing.
create or replace function public.monitor_engine_mark_emailed(p_event_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  update public.monitor_events e set emailed_at = now() where e.id = p_event_id and e.emailed_at is null
  returning e.user_id into v_user_id;
  if not found then
    return false;
  end if;
  delete from public.monitor_email_log l where l.user_id = v_user_id and l.sent_at < now() - interval '48 hours';
  insert into public.monitor_email_log (user_id, kind) values (v_user_id, 'change');
  return true;
end;
$$;

revoke execute on function public.monitor_engine_mark_emailed(uuid) from public, anon, authenticated;
grant execute on function public.monitor_engine_mark_emailed(uuid) to service_role;
comment on function public.monitor_engine_mark_emailed(uuid) is
  'Monitor cron (service_role only): stamps monitor_events.emailed_at once (email handed to Resend, or permanently rejected) and logs a change email in monitor_email_log (pruning the owner''s rows older than 48 h). True when it stamped, false when already stamped or no such event (nothing written).';

-- PostgREST serves the new functions without waiting for its schema cache to expire.
notify pgrst, 'reload schema';
