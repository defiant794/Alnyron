-- Payments foundation: Monitor subscription plans, Stripe billing records, the monitor cap a
-- subscription grants, and the service_role functions the payments Worker writes them with.
--
-- Tables (all RLS on; every privilege is first revoked from PUBLIC, anon and authenticated,
-- since Supabase's default privileges grant ALL on new public tables to both API roles, TRUNCATE
-- included, which RLS does not cover; service_role keeps its default privileges and bypasses RLS):
-- - monitor_plans / monitor_plan_translations: what a subscription buys (monitor_limit) and its
--   display price and names. anon and authenticated read the active plans and their translations.
-- - billing_customers, subscriptions, subscription_invoices: a user's Stripe customer, their
--   subscriptions and the paid invoices. authenticated reads its own rows, admins every row; anon
--   nothing. subscriptions and subscription_invoices outlive the account (user_id set null) as
--   bookkeeping; billing_customers goes with it.
-- - stripe_events: the Stripe event ids already recorded (applied or stale), for idempotency.
--   Engine-only: no policy, no privilege for anon or authenticated.
-- Money is integer øre. Nothing here is written by anon or authenticated.
--
-- Entitlement is derived, never stored: private.effective_monitor_limit(user) is the user's own
-- profiles.monitor_limit, raised to the largest monitor_limit of the plans of their subscriptions
-- in an entitling status (trialing, active, past_due; private.entitling_subscription_statuses).
-- A plan counts whether or not it is still active (a retired plan keeps its subscribers' cap).
-- NULL = unlimited: the owner role, a NULL monitor_limit, and a user without a profile. Nothing
-- here writes profiles.monitor_limit, so a cap set by hand or an older default survives a lapse.
-- public.my_monitor_limit() gives the signed-in user their own effective limit.
--
-- The cap: this file replaces private.monitors_limit_per_user() (20261106000200) with a version
-- that reads the effective limit. On INSERT (trigger monitors_limit_per_user) it counts all the
-- user's monitors. The trigger monitors_limit_on_activate fires on UPDATE OF status and refuses
-- only an activation (status set to 'active' from another status) while the user's other active
-- monitors already reach the limit; pausing and every other update pass. Both raise P0001
-- monitor_limit_reached after locking the user's profile row.
--
-- Writes from the payments Worker: public.payments_sync_subscription(p_event, p_subscription)
-- and public.payments_record_subscription_invoice(p_event, p_subscription, p_invoice). Each
-- checks its payloads before writing anything (22023 invalid_payload; a timestamp must be an
-- ISO-8601 date and time with an explicit UTC offset, Z or ±hh[:mm], which also makes it
-- finite), records the event in stripe_events (an event id seen before changes nothing: outcome
-- duplicate) and upserts the subscription unless the stored one comes from a newer event or has
-- ended (outcome stale: the stored row is left as it is, the event is recorded all the same).
-- The customer is linked to the user in billing_customers only when the subscription row is
-- written (outcome applied); a stale call writes no billing_customers row.
-- Ended means canceled or incomplete_expired, the two statuses Stripe's docs call terminal.
-- They are final: a stored subscription in either one is never changed by a later payments
-- call, whatever the time of its event (equal, newer or older), and such a call writes no
-- billing_customers row either, so an ended subscription whose account was deleted is never
-- taken over: a call for it gives the call's user neither that row nor a billing_customers link
-- to the call's customer. The user must have a profile (22023 unknown_user otherwise, also for
-- an id that names no account), and a call never moves a customer or a subscription to another
-- user (22023 customer_user_mismatch: billing_customers is checked before the subscription is
-- written, for a stale outcome too, and the rows the call writes are checked as written, so a
-- concurrent call cannot get past it; a stored subscription of another user raises it too when
-- that row is stale or ended). Then the lapse pause sets the newest active monitors of the
-- subscription row's user beyond their effective limit to paused: after an applied sync (never
-- after a stale one), and in every invoice call that is not a duplicate. It is skipped when that
-- row has no user (an orphan: user_id NULL, its account was deleted).
-- The file also replaces public.admin_delete_monitor_user (20261111000200) with a version that
-- refuses an account with a subscription that has not ended, in any status but canceled and
-- incomplete_expired (P0001 has_active_subscription). The two ended statuses are written out in
-- the two places that test them, that guard and the subscription upsert, not kept in a helper
-- like private.entitling_subscription_statuses(): the upsert runs as service_role, which would
-- need EXECUTE on such a helper, and service_role executes no private function but the four
-- named below.
--
-- Security: every function has an empty search_path and fully qualified names, and is owned by
-- postgres. EXECUTE: the two payments functions are revoked from PUBLIC, anon and authenticated
-- and granted to service_role only (Supabase's per-schema default privileges grant new public
-- functions to both API roles); my_monitor_limit to authenticated (service_role keeps the schema
-- default; without a signed-in user it raises 42501). The payments functions and their three
-- shared helpers (private.payments_valid_timestamptz, private.payments_apply_subscription,
-- private.payments_pause_over_cap) run SECURITY INVOKER: their caller, service_role, holds every
-- privilege on the tables they write. 20261101000100 grants USAGE on private to anon and
-- authenticated only, so service_role gets USAGE here plus EXECUTE on exactly the four private
-- functions it calls (those three helpers and effective_monitor_limit). That adds no data
-- access: service_role already reads and writes every table they touch, and USAGE reaches no
-- other private function (none has PUBLIC EXECUTE, 20261101000400).
-- EXCEPTIONS, SECURITY DEFINER: effective_monitor_limit, so that it sees every subscription and
-- plan of the user whichever role calls it (RLS hides inactive plans from authenticated); its
-- EXECUTE is revoked from PUBLIC, anon and authenticated, since it takes any user id.
-- my_monitor_limit, because authenticated cannot execute that helper and may only ever learn its
-- own limit. The cap trigger function and admin_delete_monitor_user, for the reasons given in
-- 20261106000200 and 20261111000200.
--
-- Lock order. A payments call takes, in this order: the subscription row, where a stored row is
-- locked FOR NO KEY UPDATE by the ON CONFLICT DO UPDATE (it sets no key column) even when it is
-- left as it is (stale, as an ended one always is, or another user's), a lock that still
-- conflicts with the delete's set null update of that row, and a new row, or one that gets its
-- user_id, also takes KEY SHARE on auth.users; only when the subscription row is written, KEY
-- SHARE on the user's auth.users row if it inserts the billing_customers row (foreign key
-- check); recording a new invoice, KEY SHARE on the subscription row and on the user's
-- auth.users row (its foreign keys); last, right before the lapse pause, the user's profile FOR
-- UPDATE, then the active monitors it pauses. An invoice recorded for a subscription row
-- without a user (an orphan) takes no lock on auth.users, and no lapse pause, profile or monitor
-- lock follows. The cap trigger locks the profile and then, for an insert, takes KEY SHARE on
-- auth.users (the monitors foreign key), which does not conflict with a KEY SHARE held here; an
-- activating monitor is not active, so the lapse pause never waits for its row.
-- admin_delete_monitor_user locks the account's auth.users row FOR UPDATE, then its profile FOR
-- UPDATE; its delete then needs the account's monitors, billing_customers, subscriptions and
-- subscription_invoices rows (cascade or set null).
-- Against that delete:
-- - A payments call that needs KEY SHARE on auth.users after the delete locked that row waits,
--   and once the delete has committed its foreign key check fails (23503). One that took it
--   before makes the delete wait; the delete then sees what the call wrote.
-- - A payments call for a subscription already stored, user unchanged, locks the subscription
--   row without any lock on auth.users; only an applied change that then inserts a missing
--   billing_customers row takes KEY SHARE on auth.users, after that row. A delete of that
--   account is allowed only once each of its stored subscriptions has ended (its guard reads
--   them after locking auth.users and the profile), and an ended subscription is never written
--   again: a sync for it is stale, takes no further lock (it writes no billing_customers row)
--   and commits, then the delete goes on. An invoice for it is still recorded, for the stored
--   user: the delete can lock auth.users and the profile meanwhile and wait for that
--   subscription row, while the payments call waits for auth.users (a new invoice's foreign
--   key) or the profile (the lapse pause). PostgreSQL detects that deadlock and aborts one of
--   the two with 40P01, either one. A sync can change a stored subscription of that account
--   only while it has not ended, and the delete's guard, which does not wait for the row, then
--   finds it not ended either (the old version, while the change is not committed): the delete
--   is refused, which lets the sync go on, also one that waits for the delete's auth.users lock
--   to insert its billing_customers row.
-- - When the delete wins (the payments call failed with 23503 or 40P01), the payments call
--   recorded nothing, its event included, and calling it again raises 22023 unknown_user: the
--   account, its profile and its billing customer are gone and its subscriptions have user_id
--   NULL. Every redelivery of that event fails the same way, so the Worker gets a lasting 22023
--   unknown_user for it, not a transient error, and ops have to look at it; the subscription
--   row and its invoices keep the state from before that event. When the delete is the one
--   aborted, nothing is deleted and Admin › Monitor-brugere reports the delete as failed; the
--   payments call commits, and a new delete is decided on the state it left.
-- - The cap trigger, two cycles with the delete. An activation holds its monitor row (the
--   UPDATE locks it before the trigger runs) and waits for the profile, while the delete holds
--   auth.users and the profile and waits for that monitor row (cascade). An insert holds the
--   profile and waits for KEY SHARE on auth.users (its foreign key check), while the delete
--   holds auth.users FOR UPDATE and waits for the profile. PostgreSQL aborts one of the two
--   with 40P01: either the user's activation or insert fails and the delete completes, or
--   nothing is deleted (reported as failed) and the activation or insert goes on.
--
-- Re-runnable: `create table / index if not exists`, `drop policy / trigger if exists` before
-- each `create`, `create or replace function` (keeps owner and ACL), and idempotent alter owner,
-- revoke, grant and comment. No transaction control: the migration runner wraps the file.

-- Tables ----------------------------------------------------------------------------------------
-- monitor_plans: one Stripe price per row (monthly or yearly). amount_ore is for display; Stripe
-- charges the price. Inactive plans are hidden from the API roles but keep their subscribers.
create table if not exists public.monitor_plans (
  id               uuid primary key default gen_random_uuid(),
  stripe_price_id  text not null unique,
  monitor_limit    integer not null check (monitor_limit > 0),
  billing_interval text not null check (billing_interval in ('month', 'year')),
  amount_ore       bigint not null check (amount_ore > 0),
  active           boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
drop trigger if exists monitor_plans_updated_at on public.monitor_plans;
create trigger monitor_plans_updated_at before update on public.monitor_plans
  for each row execute function private.set_updated_at();
comment on table public.monitor_plans is
  'Monitor subscription plans, one per Stripe price: the monitor_limit an entitling subscription grants (private.effective_monitor_limit), the billing interval and the display price in øre. anon and authenticated read active plans only; an inactive plan still counts for its subscribers.';

create table if not exists public.monitor_plan_translations (
  plan_id     uuid not null references public.monitor_plans (id) on delete cascade,
  locale      public.locale_code not null,
  name        text not null constraint monitor_plan_translations_name_nonblank check (btrim(name) <> ''),
  description text,
  primary key (plan_id, locale)
);

-- billing_customers: the user's Stripe customer (one each way). The payments functions write it
-- only together with a subscription row of that customer for that user (outcome applied).
create table if not exists public.billing_customers (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at         timestamptz not null default now()
);

-- subscriptions: the latest state of each Stripe subscription. last_event_created is the
-- creation time of the Stripe event it was last written from; an older event leaves it as it is.
-- A subscription that has ended (canceled or incomplete_expired) is final: no event changes it.
create table if not exists public.subscriptions (
  stripe_subscription_id text primary key,
  user_id                uuid references auth.users (id) on delete set null,
  stripe_customer_id     text not null,
  plan_id                uuid not null references public.monitor_plans (id) on delete restrict,
  status                 text not null check (status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  last_event_created     timestamptz not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
-- One index on user_id serves every lookup by user: the entitlement
-- (private.effective_monitor_limit), the guard of admin_delete_monitor_user, the policy and the
-- set null when an account is deleted. A user has few subscription rows (one per Stripe
-- subscription they ever had), so a partial index on the entitling statuses would hardly speed
-- up the entitlement lookup and would repeat the list of private.entitling_subscription_statuses.
create index if not exists subscriptions_user_idx on public.subscriptions (user_id);
comment on table public.subscriptions is
  'Monitor subscriptions as Stripe last reported them (written only by payments_sync_subscription and payments_record_subscription_invoice). trialing, active and past_due entitle the user to the plan''s monitor_limit. canceled and incomplete_expired are final: no later event changes a row in either status. user_id is set null when the account is deleted; the row stays for bookkeeping.';

create table if not exists public.subscription_invoices (
  stripe_invoice_id      text primary key,
  stripe_subscription_id text not null references public.subscriptions (stripe_subscription_id),
  user_id                uuid references auth.users (id) on delete set null,
  email                  text not null,
  amount_total_ore       bigint not null check (amount_total_ore >= 0),
  amount_tax_ore         bigint not null check (amount_tax_ore >= 0),
  amount_refunded_ore    bigint not null default 0 check (amount_refunded_ore >= 0),
  period_start           timestamptz,
  period_end             timestamptz,
  paid_at                timestamptz not null,
  created_at             timestamptz not null default now()
);
-- Indexed by user_id for the policy and for the set null when an account is deleted.
create index if not exists subscription_invoices_user_idx on public.subscription_invoices (user_id);

create table if not exists public.stripe_events (
  id           text primary key,
  type         text not null,
  livemode     boolean not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);
comment on table public.stripe_events is
  'Engine-only: the Stripe events the payments functions recorded (applied or stale), by event id, so a redelivered event changes nothing. No policy and no privilege for anon or authenticated.';

alter table public.monitor_plans             enable row level security;
alter table public.monitor_plan_translations enable row level security;
alter table public.billing_customers         enable row level security;
alter table public.subscriptions             enable row level security;
alter table public.subscription_invoices     enable row level security;
alter table public.stripe_events             enable row level security;

-- Grants and policies ---------------------------------------------------------------------------
revoke all on table public.monitor_plans, public.monitor_plan_translations, public.billing_customers,
  public.subscriptions, public.subscription_invoices, public.stripe_events
  from public, anon, authenticated;
grant select on public.monitor_plans, public.monitor_plan_translations to anon, authenticated;
grant select on public.billing_customers, public.subscriptions, public.subscription_invoices to authenticated;

drop policy if exists monitor_plans_select on public.monitor_plans;
create policy monitor_plans_select on public.monitor_plans for select to anon, authenticated
  using (active);
drop policy if exists monitor_plan_translations_select on public.monitor_plan_translations;
create policy monitor_plan_translations_select on public.monitor_plan_translations for select to anon, authenticated
  using (exists (select 1 from public.monitor_plans p where p.id = plan_id and p.active));

drop policy if exists billing_customers_select on public.billing_customers;
create policy billing_customers_select on public.billing_customers for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists subscription_invoices_select on public.subscription_invoices;
create policy subscription_invoices_select on public.subscription_invoices for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

-- Entitlement -----------------------------------------------------------------------------------
-- The subscription statuses that entitle, in one place. Immutable, so a call (it takes no
-- arguments) is folded into its value when a query is planned. Called only from SECURITY
-- DEFINER functions: no grants.
create or replace function private.entitling_subscription_statuses() returns text[]
language sql immutable set search_path = '' as $$
  select array['trialing', 'active', 'past_due'];
$$;
revoke all on function private.entitling_subscription_statuses() from public, anon, authenticated;
comment on function private.entitling_subscription_statuses() is
  'The subscription statuses that entitle the user to their plan''s monitor_limit: trialing, active, past_due.';

create or replace function private.effective_monitor_limit(p_user_id uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select case
           when p.role = 'owner' or p.monitor_limit is null then null
           else greatest(p.monitor_limit,
                         (select max(pl.monitor_limit)
                            from public.subscriptions s
                            join public.monitor_plans pl on pl.id = s.plan_id
                           where s.user_id = p.user_id
                             and s.status = any (private.entitling_subscription_statuses())))
         end
    from public.profiles p
   where p.user_id = p_user_id;
$$;
alter function private.effective_monitor_limit(uuid) owner to postgres;
revoke all on function private.effective_monitor_limit(uuid) from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.effective_monitor_limit(uuid) to service_role;
comment on function private.effective_monitor_limit(uuid) is
  'Most monitors p_user_id may hold, NULL = unlimited (the owner role, a NULL profiles.monitor_limit, or no profile). Otherwise profiles.monitor_limit, raised to the largest monitor_limit among the plans of the user''s trialing, active or past_due subscriptions (active plan or not). SECURITY DEFINER: reads every subscription and plan of the user; not executable by anon or authenticated (any user id).';

create or replace function public.my_monitor_limit() returns integer
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return private.effective_monitor_limit(v_user);
end;
$$;
alter function public.my_monitor_limit() owner to postgres;
revoke all on function public.my_monitor_limit() from public, anon, authenticated;
grant execute on function public.my_monitor_limit() to authenticated;
comment on function public.my_monitor_limit() is
  'The signed-in user''s effective monitor limit (private.effective_monitor_limit), NULL = unlimited. 42501 forbidden without a signed-in user, so no caller ever reads NULL for "nobody". SECURITY DEFINER: authenticated cannot execute the helper, which takes any user id.';

comment on column public.profiles.monitor_limit is
  'The user''s own monitor cap (public.monitors); NULL = unlimited, 0 = none. The owner role is unlimited regardless, and a trialing, active or past_due subscription raises it to its plan''s monitor_limit (private.effective_monitor_limit). Enforced by the monitors_limit_per_user trigger on insert and monitors_limit_on_activate on resume.';

-- The cap ---------------------------------------------------------------------------------------
-- As in 20261106000200: the user's profile row is locked before anything is counted, so
-- concurrent inserts and activations for one user queue up and each counts the rows committed
-- before it (READ COMMITTED), and a signed-in session's insert for another user is not counted
-- (monitors_insert refuses it, 42501; counting it would lock the other user's profile and reveal
-- their cap). The limit is read after that lock. An UPDATE that does not set status to 'active'
-- from another status returns before the function locks anything: pausing is never refused. A
-- signed-in session's UPDATE reaches only its own rows (monitors_update), so updates have no such
-- skip. Trigger functions are not EXECUTE-checked when they fire, so it has no grants.
create or replace function private.monitors_limit_per_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_caller uuid := auth.uid();
  v_limit  integer;
begin
  if tg_op = 'INSERT' then
    if v_caller is not null and new.user_id is distinct from v_caller then
      return new;
    end if;
  elsif new.status is distinct from 'active' or old.status is not distinct from 'active' then
    return new;
  end if;
  perform 1 from public.profiles p where p.user_id = new.user_id for update;
  v_limit := private.effective_monitor_limit(new.user_id);
  if v_limit is null then
    return new;
  end if;
  -- An insert counts all the user's monitors; an activation the user's other active ones.
  if (select count(*) from public.monitors m
       where m.user_id = new.user_id
         and (tg_op = 'INSERT' or (m.status = 'active' and m.id <> new.id))) >= v_limit then
    raise exception 'monitor_limit_reached' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
comment on function private.monitors_limit_per_user() is
  'Trigger (monitors_limit_per_user on INSERT, monitors_limit_on_activate on UPDATE OF status): raises P0001 monitor_limit_reached for an insert when the user already holds private.effective_monitor_limit monitors, and for an activation (status set to active from another status) when the user''s other active monitors already reach it; NULL is unlimited, pausing is never refused. Locks the user''s profile row before counting, so concurrent inserts and activations cannot both pass. Skips a signed-in session''s insert for another user, which monitors_insert refuses (42501).';

drop trigger if exists monitors_limit_on_activate on public.monitors;
create trigger monitors_limit_on_activate before update of status on public.monitors
  for each row execute function private.monitors_limit_per_user();

-- Payments: shared helpers ----------------------------------------------------------------------
-- A payload timestamp: an ISO-8601 date and time with an explicit UTC offset,
-- YYYY-MM-DDThh:mm[:ss[.fraction]] then Z, ±hh or ±hh:mm, that PostgreSQL accepts as
-- timestamptz. That shape makes it finite (no infinity, now or other special value) and its
-- instant independent of the session's time zone. NULL is not a timestamp.
create or replace function private.payments_valid_timestamptz(p_value text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(p_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}(:[0-9]{2})?)$'
                  and pg_input_is_valid(p_value, 'timestamptz'), false);
$$;
revoke all on function private.payments_valid_timestamptz(text) from public, anon, authenticated;
grant execute on function private.payments_valid_timestamptz(text) to service_role;
comment on function private.payments_valid_timestamptz(text) is
  'Whether p_value is a timestamp the payments functions accept: an ISO-8601 date and time with an explicit UTC offset (YYYY-MM-DDThh:mm[:ss[.fraction]] then Z, ±hh or ±hh:mm) that PostgreSQL accepts as timestamptz, so finite and independent of the session''s time zone. False for NULL, infinity, now and other special values, and a time without an offset.';

-- Checks both payloads, records the event, resolves the plan and the user, checks the customer,
-- upserts the subscription and, only when that wrote the row, links the customer to the user in
-- billing_customers. outcome: 'duplicate' (the event id was recorded before; nothing else is
-- written), 'stale' (the stored subscription is left as it is because it comes from a newer
-- event or has ended, canceled or incomplete_expired, which no later event changes whatever its
-- time; the event stays recorded, no billing_customers row is written) or 'applied'. account_id:
-- the subscription row's user (for a stale row its stored user, NULL when its account was
-- deleted). customer_user_mismatch: billing_customers must not link the customer to another
-- user or the user to another customer, checked before the subscription is written (so a stale
-- outcome raises it too) and, when applied, again on the row after the billing_customers insert;
-- the subscription is checked on its row as written. So a concurrent call cannot slip a
-- different user past the checks into what this call writes; another user's stored
-- subscription is customer_user_mismatch, never stale. Any exception rolls back the event row
-- with everything else: a failed call leaves nothing behind, and a retry runs it from the start.
create or replace function private.payments_apply_subscription(
  p_event jsonb, p_subscription jsonb, out outcome text, out account_id uuid)
language plpgsql volatile set search_path = '' as $$
declare
  v_created     timestamptz;
  v_sub_id      text := p_subscription ->> 'id';
  v_customer    text := p_subscription ->> 'customer';
  v_status      text := p_subscription ->> 'status';
  v_plan_id     uuid;
  v_stored_user uuid;
begin
  -- Every key must be present with its JSON type; user_id and current_period_end may be null.
  if jsonb_typeof(p_event -> 'id') is distinct from 'string'
     or jsonb_typeof(p_event -> 'type') is distinct from 'string'
     or jsonb_typeof(p_event -> 'livemode') is distinct from 'boolean'
     or jsonb_typeof(p_event -> 'created') is distinct from 'string'
     or not private.payments_valid_timestamptz(p_event ->> 'created')
     or jsonb_typeof(p_subscription -> 'id') is distinct from 'string'
     or jsonb_typeof(p_subscription -> 'customer') is distinct from 'string'
     or jsonb_typeof(p_subscription -> 'price_id') is distinct from 'string'
     or jsonb_typeof(p_subscription -> 'status') is distinct from 'string'
     or v_status not in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')
     or jsonb_typeof(p_subscription -> 'cancel_at_period_end') is distinct from 'boolean'
     or coalesce(jsonb_typeof(p_subscription -> 'user_id'), 'missing') not in ('null', 'string')
     or (jsonb_typeof(p_subscription -> 'user_id') = 'string'
         and not pg_input_is_valid(p_subscription ->> 'user_id', 'uuid'))
     or coalesce(jsonb_typeof(p_subscription -> 'current_period_end'), 'missing') not in ('null', 'string')
     or (jsonb_typeof(p_subscription -> 'current_period_end') = 'string'
         and not private.payments_valid_timestamptz(p_subscription ->> 'current_period_end')) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  v_created := (p_event ->> 'created')::timestamptz;

  insert into public.stripe_events (id, type, livemode, processed_at)
  values (p_event ->> 'id', p_event ->> 'type', (p_event ->> 'livemode')::boolean, now())
  on conflict (id) do nothing;
  if not found then
    outcome := 'duplicate';
    return;
  end if;

  select pl.id into v_plan_id from public.monitor_plans pl where pl.stripe_price_id = p_subscription ->> 'price_id';
  if not found then
    raise exception 'unknown_plan' using errcode = '22023';
  end if;

  -- The user: the payload's, else the customer's, else the stored subscription's. It must have a
  -- profile: an id that names no account, or a deleted one, is no user to write for. The
  -- subscription row and the billing customer are written for this user only when the
  -- subscription is applied; a stale call leaves the stored row with its stored user (NULL
  -- included) and writes no billing_customers row, so an ended subscription whose account was
  -- deleted is never taken over: a call for it gives this user neither that row nor a
  -- billing_customers link to the call's customer.
  select s.user_id into v_stored_user from public.subscriptions s where s.stripe_subscription_id = v_sub_id;
  account_id := coalesce((p_subscription ->> 'user_id')::uuid,
                         (select b.user_id from public.billing_customers b where b.stripe_customer_id = v_customer),
                         v_stored_user);
  if account_id is null
     or not exists (select 1 from public.profiles p where p.user_id = account_id) then
    raise exception 'unknown_user' using errcode = '22023';
  end if;

  -- The customer is the user's and nobody else's: no billing_customers row may link the customer
  -- to another user or the user to another customer. Checked before the subscription is written,
  -- so a mismatch raises (and writes nothing) whether the subscription would be applied or stale;
  -- the billing_customers row itself is written below, only when the subscription is applied.
  if exists (select 1 from public.billing_customers b
              where (b.stripe_customer_id = v_customer and b.user_id <> account_id)
                 or (b.user_id = account_id and b.stripe_customer_id <> v_customer)) then
    raise exception 'customer_user_mismatch' using errcode = '22023';
  end if;

  insert into public.subscriptions as s
    (stripe_subscription_id, user_id, stripe_customer_id, plan_id, status, current_period_end,
     cancel_at_period_end, last_event_created)
  values (v_sub_id, account_id, v_customer, v_plan_id, v_status,
          (p_subscription ->> 'current_period_end')::timestamptz,
          (p_subscription ->> 'cancel_at_period_end')::boolean, v_created)
  on conflict (stripe_subscription_id) do update
     set user_id = excluded.user_id,
         stripe_customer_id = excluded.stripe_customer_id,
         plan_id = excluded.plan_id,
         status = excluded.status,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         last_event_created = excluded.last_event_created,
         updated_at = now()
   where s.last_event_created <= excluded.last_event_created
     -- Ended is final (the same two statuses as admin_delete_monitor_user's guard).
     and s.status not in ('canceled', 'incomplete_expired')
     and (s.user_id is null or s.user_id = excluded.user_id);
  if not found then
    -- Left as it is, though the ON CONFLICT DO UPDATE locked it: another user's (whatever its
    -- event time or status) is a mismatch; else stale (from a newer event, or ended), with the
    -- stored user (NULL or account_id) and no billing_customers row written.
    select s.user_id into v_stored_user from public.subscriptions s where s.stripe_subscription_id = v_sub_id;
    if v_stored_user is not null and v_stored_user <> account_id then
      raise exception 'customer_user_mismatch' using errcode = '22023';
    end if;
    outcome := 'stale';
    account_id := v_stored_user;
    return;
  end if;

  -- Applied: link the customer to the user. The row must be there after the insert (it does
  -- nothing when the customer or the user already has a row, committed or one it waited for), so
  -- a concurrent call that linked either one to someone else since the check above is caught too.
  insert into public.billing_customers (user_id, stripe_customer_id)
  values (account_id, v_customer)
  on conflict do nothing;
  if not exists (select 1 from public.billing_customers b
                  where b.user_id = account_id and b.stripe_customer_id = v_customer) then
    raise exception 'customer_user_mismatch' using errcode = '22023';
  end if;
  outcome := 'applied';
end;
$$;
revoke all on function private.payments_apply_subscription(jsonb, jsonb) from public, anon, authenticated;
grant execute on function private.payments_apply_subscription(jsonb, jsonb) to service_role;
comment on function private.payments_apply_subscription(jsonb, jsonb) is
  'Shared by the payments functions: checks the event and subscription payloads (22023 invalid_payload), records the event in stripe_events (outcome duplicate when its id is already there: nothing else written), resolves the plan by price (22023 unknown_plan) and the user (payload, else the customer''s, else the stored subscription''s; 22023 unknown_user when there is none or it has no profile), upserts the subscription unless the stored one comes from a newer event or has ended, canceled or incomplete_expired, final whatever the event''s time (outcome stale: the stored row is left as it is and no billing_customers row is written, the event stays recorded), and only when it wrote the row (outcome applied) links the customer to the user in billing_customers. 22023 customer_user_mismatch when billing_customers links the customer to another user or the user to another customer (checked before the subscription is written, so for a stale outcome too, and when applied again on the row after the billing_customers insert) or when the stored subscription belongs to another user (checked on the row as written; also when it is stale or ended). Returns outcome applied or stale with the subscription row''s user (account_id; for a stale row its stored user, NULL when its account was deleted).';

-- The lapse pause: under the user's profile lock (the cap trigger's lock), keeps the oldest
-- active monitors up to the effective limit and pauses the newer rest (by created_at, then id).
-- Changes status only and never touches another user's monitors. Returns how many it paused.
create or replace function private.payments_pause_over_cap(p_user_id uuid) returns integer
language plpgsql volatile set search_path = '' as $$
declare
  v_limit  integer;
  v_paused integer;
begin
  perform 1 from public.profiles p where p.user_id = p_user_id for update;
  v_limit := private.effective_monitor_limit(p_user_id);
  if v_limit is null then
    return 0;
  end if;
  update public.monitors m
     set status = 'paused'
   where m.status = 'active'
     and m.id in (select a.id
                    from public.monitors a
                   where a.user_id = p_user_id and a.status = 'active'
                   order by a.created_at, a.id
                  offset v_limit);
  get diagnostics v_paused = row_count;
  return v_paused;
end;
$$;
revoke all on function private.payments_pause_over_cap(uuid) from public, anon, authenticated;
grant execute on function private.payments_pause_over_cap(uuid) to service_role;
comment on function private.payments_pause_over_cap(uuid) is
  'The lapse pause: locks the user''s profile row, then pauses the user''s newest active monitors (created_at, then id) beyond private.effective_monitor_limit, so at most that many stay active; returns how many it paused (0 within the limit or when unlimited). Never deletes and never touches other users'' monitors.';

-- Payments: the Worker's functions --------------------------------------------------------------
-- p_event = {id, type, created (timestamptz text), livemode}; p_subscription = {id, customer,
-- user_id (uuid text or null), price_id, status, current_period_end (timestamptz text or null),
-- cancel_at_period_end}. A timestamptz text is ISO-8601 with an explicit UTC offset
-- (private.payments_valid_timestamptz). Returns {"outcome": "applied" | "duplicate" | "stale",
-- "paused": n}; stale when the stored subscription comes from a newer event or has ended
-- (canceled or incomplete_expired: final, whatever the event's time). The billing_customers link
-- and the lapse pause come only with an applied change, never with a stale one.
create or replace function public.payments_sync_subscription(p_event jsonb, p_subscription jsonb)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_applied record;
  v_paused  integer := 0;
begin
  select * into v_applied from private.payments_apply_subscription(p_event, p_subscription);
  if v_applied.outcome = 'applied' then
    v_paused := private.payments_pause_over_cap(v_applied.account_id);
  end if;
  return jsonb_build_object('outcome', v_applied.outcome, 'paused', v_paused);
end;
$$;
revoke all on function public.payments_sync_subscription(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.payments_sync_subscription(jsonb, jsonb) to service_role;
comment on function public.payments_sync_subscription(jsonb, jsonb) is
  'Payments Worker (service_role only): applies a Stripe subscription as normalized JSON (see private.payments_apply_subscription for the checks, the errors and the billing_customers link) and, when it changed, pauses the user''s newest active monitors beyond their effective limit. Outcome stale (event recorded, row left as it is, no billing_customers row written, no pause) when the stored subscription comes from a newer event or has ended: canceled and incomplete_expired are final, whatever the event''s time. Returns {"outcome": "applied" | "duplicate" | "stale", "paused": n}.';

-- p_invoice = {id, subscription_id (= p_subscription.id), email, amount_total_ore,
-- amount_tax_ore (non-negative integers), period_start, period_end (timestamptz text or null),
-- paid_at (timestamptz text)}. The subscription is upserted first, so an invoice may arrive
-- before any subscription event; a stale subscription payload (older than the stored row, or for
-- a stored subscription that has ended) leaves the stored row as it is and writes no
-- billing_customers row, and the invoice is recorded all the same. The invoice goes to the
-- subscription row's user (an invoice id seen before is kept) and the lapse pause then runs for
-- that user; when the row has no user (an orphan: user_id NULL, its account was deleted), the
-- invoice is recorded with user_id NULL and the pause is skipped (paused 0). Returns
-- {"outcome": "applied" | "duplicate", "paused": n}.
create or replace function public.payments_record_subscription_invoice(p_event jsonb, p_subscription jsonb, p_invoice jsonb)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_applied record;
  v_paused  integer := 0;
begin
  if jsonb_typeof(p_invoice -> 'id') is distinct from 'string'
     or jsonb_typeof(p_invoice -> 'subscription_id') is distinct from 'string'
     or (p_invoice ->> 'subscription_id') is distinct from (p_subscription ->> 'id')
     or jsonb_typeof(p_invoice -> 'email') is distinct from 'string'
     or jsonb_typeof(p_invoice -> 'amount_total_ore') is distinct from 'number'
     or jsonb_typeof(p_invoice -> 'amount_tax_ore') is distinct from 'number'
     or jsonb_typeof(p_invoice -> 'paid_at') is distinct from 'string'
     or not private.payments_valid_timestamptz(p_invoice ->> 'paid_at')
     or coalesce(jsonb_typeof(p_invoice -> 'period_start'), 'missing') not in ('null', 'string')
     or (jsonb_typeof(p_invoice -> 'period_start') = 'string'
         and not private.payments_valid_timestamptz(p_invoice ->> 'period_start'))
     or coalesce(jsonb_typeof(p_invoice -> 'period_end'), 'missing') not in ('null', 'string')
     or (jsonb_typeof(p_invoice -> 'period_end') = 'string'
         and not private.payments_valid_timestamptz(p_invoice ->> 'period_end')) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  -- Both amounts are JSON numbers here: whole, not negative, within bigint.
  if (p_invoice -> 'amount_total_ore')::numeric not between 0 and 9223372036854775807
     or (p_invoice -> 'amount_total_ore')::numeric <> trunc((p_invoice -> 'amount_total_ore')::numeric)
     or (p_invoice -> 'amount_tax_ore')::numeric not between 0 and 9223372036854775807
     or (p_invoice -> 'amount_tax_ore')::numeric <> trunc((p_invoice -> 'amount_tax_ore')::numeric) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  select * into v_applied from private.payments_apply_subscription(p_event, p_subscription);
  if v_applied.outcome = 'duplicate' then
    return jsonb_build_object('outcome', 'duplicate', 'paused', 0);
  end if;

  insert into public.subscription_invoices
    (stripe_invoice_id, stripe_subscription_id, user_id, email, amount_total_ore, amount_tax_ore,
     period_start, period_end, paid_at)
  values (p_invoice ->> 'id', p_invoice ->> 'subscription_id', v_applied.account_id, p_invoice ->> 'email',
          (p_invoice -> 'amount_total_ore')::numeric::bigint, (p_invoice -> 'amount_tax_ore')::numeric::bigint,
          (p_invoice ->> 'period_start')::timestamptz, (p_invoice ->> 'period_end')::timestamptz,
          (p_invoice ->> 'paid_at')::timestamptz)
  on conflict (stripe_invoice_id) do nothing;

  if v_applied.account_id is not null then
    v_paused := private.payments_pause_over_cap(v_applied.account_id);
  end if;
  return jsonb_build_object('outcome', 'applied', 'paused', v_paused);
end;
$$;
revoke all on function public.payments_record_subscription_invoice(jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.payments_record_subscription_invoice(jsonb, jsonb, jsonb) to service_role;
comment on function public.payments_record_subscription_invoice(jsonb, jsonb, jsonb) is
  'Payments Worker (service_role only): records a paid subscription invoice. Checks the invoice (22023 invalid_payload, also when subscription_id differs from p_subscription.id), applies the subscription like payments_sync_subscription (a stale one, from an older event than the stored row or for a stored subscription that has ended, canceled or incomplete_expired, stays as stored and writes no billing_customers row), inserts the invoice for the subscription row''s user (an invoice id seen before is kept) and pauses that user''s newest active monitors beyond their effective limit. When the row has no user (an orphan: user_id NULL, its account was deleted), the invoice gets user_id NULL and nothing is paused (paused 0). Returns {"outcome": "applied" | "duplicate", "paused": n}.';

-- Admin delete guard ----------------------------------------------------------------------------
-- 20261111000200's function with one more refusal, after the role check: an account with a
-- subscription that has not ended, in any status but canceled and incomplete_expired (the two
-- statuses Stripe's docs call terminal, final for the payments functions too, which never change
-- a stored subscription in either), is not deleted (P0001 has_active_subscription). Its ended
-- subscriptions stay after the delete with user_id NULL, their invoices too; billing_customers
-- goes by cascade. The guard reads the subscriptions after the account's auth.users row and
-- profile are locked; the header's lock order covers a payments call that runs at the same time.
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
  -- Ended: the same two statuses as the upsert in private.payments_apply_subscription.
  if exists (select 1 from public.subscriptions s
              where s.user_id = p_user_id
                and s.status not in ('canceled', 'incomplete_expired')) then
    raise exception 'has_active_subscription' using errcode = 'P0001';
  end if;

  delete from auth.users u where u.id = p_user_id;
end;
$$;

alter function public.admin_delete_monitor_user(uuid) owner to postgres;
revoke all on function public.admin_delete_monitor_user(uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_monitor_user(uuid) to authenticated;
comment on function public.admin_delete_monitor_user(uuid) is
  'Admin › Monitor-brugere, Slet (owner and admin only, 42501 otherwise; SECURITY DEFINER because it deletes from auth.users, which authenticated and service_role cannot): deletes the monitor_user account p_user_id for good, its profile, monitors, monitor events, billing customer and other account rows going by cascade (its subscriptions and invoices stay with user_id NULL). Only monitor_user accounts: P0001 not_monitor_user for any other role or none, P0001 has_active_subscription while a subscription of the account has not ended (any status but canceled and incomplete_expired, the two final statuses the payments functions never change; nothing deleted either way), P0002 not_found when no profile has that id (null included).';

-- PostgREST serves the new tables and functions without waiting for its schema cache to expire.
notify pgrst, 'reload schema';
