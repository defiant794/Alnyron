-- Payments slice 1d: the right of withdrawal (fortrydelsesret, forbrugeraftaleloven) for the
-- Monitor subscription. L-1: the consumer's express request to start at once, given in Stripe
-- Checkout's consent checkbox, is recorded as evidence with the digest of the legal texts shown.
-- L-2: an online withdrawal function; the payments Worker (alnyron-payments, named entrypoint
-- WithdrawalService, reached from the web app over a Cloudflare service binding) records the
-- notice, cancels the subscription in Stripe and refunds the unused part with a credit note.
--
-- Schema:
-- - subscriptions.started_at: Stripe's subscription start_date, the day the contract was made.
--   Set once by the sync writer (private.payments_apply_subscription, replaced below: its
--   p_subscription gains the required key start_date); a later different value never
--   overwrites it. No backfill: production holds no subscription when this runs (no live plan
--   was ever seeded there); workers/payments/README.md (Slice 1d go-live) gives the one-off
--   recipe should that not hold.
-- - subscription_invoices: CHECK amount_refunded_ore <= amount_total_ore (refunds can never
--   exceed what an invoice took).
-- - subscription_consents: append-only evidence, one row per Checkout Session and per
--   subscription; info_sent_at stamps the order confirmation email (the durable-medium
--   withdrawal information, fl. § 19 stk. 3), which starts the 14 days.
-- - subscription_withdrawals: one withdrawal per subscription (UNIQUE), with the statement, the
--   notice time (requested_at, the database clock), the deadline it met, the Stripe cancel and
--   the refund (bigint øre: paid = retained + refund), the receipt and owner alert stamps, and the
--   Worker's lease and attempt counter. Status: received -> canceled -> completed, or
--   needs_manual (an anomaly the owner handles by hand, see workers/payments/README.md, and
--   records with payments_withdrawal_step: needs_manual -> completed once canceled_at is set).
-- Both new tables: RLS on; every privilege revoked from PUBLIC, anon and authenticated, then
-- SELECT granted to authenticated, whose policy admits a user's own rows and admins every row;
-- service_role keeps its default privileges and bypasses RLS. Nothing here is written by anon or
-- authenticated. Money is integer øre.
--
-- The window: private.withdrawal_deadline(started_at, info_sent_at) per fl. § 19 stk. 2-4, 6, in
-- Europe/Copenhagen dates. Day 0 is the later of the contract day and the day the withdrawal
-- information was sent; the last day is day 0 + 14 (without the information: start day + 14,
-- plus 12 months), moved forward past Saturdays, Sundays, public holidays, 5 June, 24 and 31
-- December (private.dk_non_working_day; Store bededag is no holiday since 2024); the deadline is
-- the start of the next Copenhagen day. The window is checked ONLY here, against now(), inside
-- payments_begin_withdrawal (atomically with the insert); the web page reads the same function
-- through public.my_withdrawal_status().
--
-- Writers (service_role only, SECURITY INVOKER, called by the payments Worker):
-- payments_record_checkout_consent, payments_mark_consent_info_sent, payments_begin_withdrawal,
-- payments_claim_withdrawal, payments_withdrawal_step, payments_pending_work (a read). Malformed
-- arguments raise 22023 invalid_payload; business refusals raise P0001 with the message named in
-- each function's comment. A withdrawal's JSON snapshot (every writer's "withdrawal") is built by
-- private.payments_withdrawal_json, the consent's mail context by private.payments_consent_mail.
-- public.my_withdrawal_status() is SECURITY DEFINER for authenticated (42501 without a signed-in
-- user): the caller's own subscription, deadline and withdrawal, nothing else.
--
-- Security: every function has an empty search_path and fully qualified names and is owned by
-- postgres. EXECUTE on the public payments functions is revoked from PUBLIC, anon and
-- authenticated and granted to service_role; my_withdrawal_status to authenticated only. The
-- writers run as their caller, service_role, which holds every privilege on the tables they
-- write; service_role gets EXECUTE on exactly the private helpers they call
-- (private.dk_easter_sunday, private.dk_non_working_day, private.withdrawal_deadline,
-- private.payments_withdrawal_json, private.payments_consent_mail, and from 20261112000100
-- private.payments_valid_timestamptz). The helpers take no user input beyond ids and dates and
-- reach no table service_role cannot read anyway.
--
-- Lock order: every consent and withdrawal writer locks the subscription row FOR UPDATE first
-- (the payments sync writers lock it first too, 20261112000100), then the withdrawal row, then
-- (the refunded step only) the invoice row. Inserting a consent or a withdrawal takes KEY SHARE
-- on the user's auth.users row (foreign key) after the subscription row. Against
-- admin_delete_monitor_user (auth.users FOR UPDATE, profile, then the cascade): a withdrawal is
-- begun only for an entitling subscription, and the delete's guard refuses an account with a
-- subscription that has not ended without waiting for its row, so the two cannot deadlock on a
-- withdrawal; a consent for such an account is written only right after its subscription synced.
--
-- Re-runnable: `create table / index if not exists`, `add column if not exists`, constraints
-- dropped before they are added, `drop policy if exists` before each `create`, `create or
-- replace function` (keeps owner and ACL), and idempotent alter owner, revoke, grant and comment.
-- No transaction control: the migration runner wraps the file.

-- Schema ----------------------------------------------------------------------------------------
alter table public.subscriptions add column if not exists started_at timestamptz;
comment on column public.subscriptions.started_at is
  'When the subscription agreement was made: Stripe''s start_date, set once by the sync writer (a later different value never overwrites it). The withdrawal period runs from its Copenhagen date (private.withdrawal_deadline).';

alter table public.subscription_invoices drop constraint if exists subscription_invoices_refund_le_total;
alter table public.subscription_invoices
  add constraint subscription_invoices_refund_le_total check (amount_refunded_ore <= amount_total_ore);

create table if not exists public.subscription_consents (
  stripe_checkout_session_id text primary key,
  stripe_subscription_id     text not null unique references public.subscriptions (stripe_subscription_id),
  user_id                    uuid references auth.users (id) on delete set null,
  text_version               text not null,
  text_sha256                text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  locale                     public.locale_code not null,
  stripe_consent             text not null check (stripe_consent = 'accepted'),
  accepted_at                timestamptz not null,
  info_sent_at               timestamptz,
  info_email_id              text,
  created_at                 timestamptz not null default now()
);
create index if not exists subscription_consents_user_idx on public.subscription_consents (user_id);
comment on table public.subscription_consents is
  'Append-only evidence of the consumer''s express request to start the subscription at once (Stripe Checkout consent checkbox, terms_of_service = accepted), one row per Checkout Session and per subscription (the first recorded wins): the legal text version and its sha256 in the shown locale, accepted_at (the checkout.session.completed event''s created), and info_sent_at/info_email_id once the order confirmation email (withdrawal information on a durable medium) was sent. user_id is set null when the account is deleted. Written by service_role only; authenticated reads its own rows, admins every row.';

create table if not exists public.subscription_withdrawals (
  id                     uuid primary key default gen_random_uuid(),
  stripe_subscription_id text not null unique references public.subscriptions (stripe_subscription_id),
  user_id                uuid references auth.users (id) on delete set null,
  consumer_name          text not null check (char_length(btrim(consumer_name)) between 1 and 200),
  ack_email              text not null,
  statement_version      text not null,
  locale                 public.locale_code not null,
  requested_at           timestamptz not null default now(),
  deadline_at            timestamptz not null,
  status                 text not null default 'received'
                         check (status in ('received', 'canceled', 'completed', 'needs_manual')),
  manual_reason          text check (manual_reason is null or manual_reason in
                           ('subscription_mismatch', 'invoice_shape', 'stripe_refused', 'retries_exhausted')),
  canceled_at            timestamptz,
  stripe_invoice_id      text,
  service_start_at       timestamptz,
  period_end_at          timestamptz,
  paid_ore               bigint check (paid_ore >= 0),
  retained_ore           bigint check (retained_ore >= 0),
  refund_ore             bigint check (refund_ore >= 0),
  refund_tax_ore         bigint check (refund_tax_ore >= 0),
  retention_basis        text check (retention_basis in ('consent', 'no_consent')),
  calc_version           text check (calc_version is null or calc_version = 'wd-refund-1'),
  stripe_credit_note_id  text unique,
  stripe_refund_id       text unique,
  refunded_at            timestamptz,
  ack_sent_at            timestamptz,
  ack_email_id           text,
  alerted_at             timestamptz,
  attempts               integer not null default 0,
  last_error             text check (last_error is null or last_error ~ '^[a-z_]{1,64}$'),
  lease_until            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (requested_at < deadline_at),
  check (paid_ore is null or paid_ore = retained_ore + refund_ore),
  check (status <> 'completed' or (canceled_at is not null and refund_ore is not null))
);
create index if not exists subscription_withdrawals_user_idx on public.subscription_withdrawals (user_id);
comment on table public.subscription_withdrawals is
  'One withdrawal (fortrydelse) per subscription: the consumer''s statement (name, statement_version, locale), the receipt address (the account email), requested_at (the database clock: the authoritative notice time) and the deadline it met, then the Worker''s progress: status received -> canceled (Stripe cancel) -> completed (credit note with refund, or nothing to refund), or needs_manual with manual_reason (owner alert + runbook). Amounts in øre: paid = retained + refund, refund_tax_ore the reversed VAT, calc_version the formula (wd-refund-1). ack_sent_at/alerted_at stamp the receipt and the owner alert; attempts/last_error (a code, never free text)/lease_until belong to the Worker. user_id is set null when the account is deleted (bookkeeping evidence). Written by service_role only; authenticated reads its own rows, admins every row.';

alter table public.subscription_consents    enable row level security;
alter table public.subscription_withdrawals enable row level security;

revoke all on table public.subscription_consents, public.subscription_withdrawals from public, anon, authenticated;
grant select on public.subscription_consents, public.subscription_withdrawals to authenticated;

drop policy if exists subscription_consents_select on public.subscription_consents;
create policy subscription_consents_select on public.subscription_consents for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists subscription_withdrawals_select on public.subscription_withdrawals;
create policy subscription_withdrawals_select on public.subscription_withdrawals for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

-- Sync writer: started_at -----------------------------------------------------------------------
-- 20261112000100's function with one more required payload key, start_date (an ISO timestamp
-- like the others, else 22023 invalid_payload), written to started_at on insert and kept on
-- update (coalesce: the first value stays). Everything else is unchanged.
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
         and not private.payments_valid_timestamptz(p_subscription ->> 'current_period_end'))
     or jsonb_typeof(p_subscription -> 'start_date') is distinct from 'string'
     or not private.payments_valid_timestamptz(p_subscription ->> 'start_date') then
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

  -- started_at is set once: the first stored start stays (coalesce), whatever a later event says.
  insert into public.subscriptions as s
    (stripe_subscription_id, user_id, stripe_customer_id, plan_id, status, current_period_end,
     cancel_at_period_end, last_event_created, started_at)
  values (v_sub_id, account_id, v_customer, v_plan_id, v_status,
          (p_subscription ->> 'current_period_end')::timestamptz,
          (p_subscription ->> 'cancel_at_period_end')::boolean, v_created,
          (p_subscription ->> 'start_date')::timestamptz)
  on conflict (stripe_subscription_id) do update
     set user_id = excluded.user_id,
         stripe_customer_id = excluded.stripe_customer_id,
         plan_id = excluded.plan_id,
         status = excluded.status,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         last_event_created = excluded.last_event_created,
         started_at = coalesce(s.started_at, excluded.started_at),
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
comment on function private.payments_apply_subscription(jsonb, jsonb) is
  'Shared by the payments functions: checks the event and subscription payloads (22023 invalid_payload; p_subscription needs start_date, an ISO timestamp), records the event in stripe_events (outcome duplicate when its id is already there: nothing else written), resolves the plan by price (22023 unknown_plan) and the user (payload, else the customer''s, else the stored subscription''s; 22023 unknown_user when there is none or it has no profile), upserts the subscription unless the stored one comes from a newer event or has ended, canceled or incomplete_expired, final whatever the event''s time (outcome stale: the stored row is left as it is and no billing_customers row is written, the event stays recorded), and only when it wrote the row (outcome applied) links the customer to the user in billing_customers. started_at takes start_date once: an upsert keeps a stored value. 22023 customer_user_mismatch when billing_customers links the customer to another user or the user to another customer (checked before the subscription is written, so for a stale outcome too, and when applied again on the row after the billing_customers insert) or when the stored subscription belongs to another user (checked on the row as written; also when it is stale or ended). Returns outcome applied or stale with the subscription row''s user (account_id; for a stale row its stored user, NULL when its account was deleted).';

-- The withdrawal period -------------------------------------------------------------------------
-- Easter Sunday of a year (Gregorian computus, the anonymous algorithm of Meeus/Jones/Butcher).
create or replace function private.dk_easter_sunday(p_year integer) returns date
language sql immutable set search_path = '' as $$
  select make_date(p_year, (s4.h + s5.l - 7 * s6.m + 114) / 31, (s4.h + s5.l - 7 * s6.m + 114) % 31 + 1)
    from (select p_year % 19 as a, p_year / 100 as b, p_year % 100 as c) s1
   cross join lateral (select s1.b / 4 as d, s1.b % 4 as e, (s1.b + 8) / 25 as f) s2
   cross join lateral (select (s1.b - s2.f + 1) / 3 as g) s3
   cross join lateral (select (19 * s1.a + s1.b - s2.d - s3.g + 15) % 30 as h, s1.c / 4 as i, s1.c % 4 as k) s4
   cross join lateral (select (32 + 2 * s2.e + 2 * s4.i - s4.h - s4.k) % 7 as l) s5
   cross join lateral (select (s1.a + 11 * s4.h + 22 * s5.l) / 451 as m) s6;
$$;
revoke all on function private.dk_easter_sunday(integer) from public, anon, authenticated;
grant execute on function private.dk_easter_sunday(integer) to service_role;
comment on function private.dk_easter_sunday(integer) is
  'Easter Sunday of p_year (Gregorian calendar; NULL for NULL). Used by private.dk_non_working_day for the Danish movable public holidays.';

-- A day on which a Danish withdrawal period cannot end (fl. § 19 stk. 6): Saturday, Sunday, a
-- public holiday (1 Jan; Maundy Thursday, Good Friday, Easter Sunday and Monday, Ascension Day,
-- Whit Sunday and Monday: Easter -3, -2, 0, +1, +39, +49, +50; 25 and 26 Dec), 5 June (Constitution
-- Day), 24 Dec or 31 Dec. Store bededag is no public holiday since 2024.
create or replace function private.dk_non_working_day(p_day date) returns boolean
language sql immutable set search_path = '' as $$
  select extract(isodow from p_day) in (6, 7)
      or (extract(month from p_day), extract(day from p_day)) in ((1, 1), (6, 5), (12, 24), (12, 25), (12, 26), (12, 31))
      or p_day - private.dk_easter_sunday(extract(year from p_day)::integer) in (-3, -2, 0, 1, 39, 49, 50);
$$;
revoke all on function private.dk_non_working_day(date) from public, anon, authenticated;
grant execute on function private.dk_non_working_day(date) to service_role;
comment on function private.dk_non_working_day(date) is
  'Whether a Danish withdrawal period cannot end on p_day (forbrugeraftaleloven § 19 stk. 6): Saturday, Sunday, a public holiday (1 Jan, Maundy Thursday, Good Friday, Easter Sunday and Monday, Ascension Day, Whit Sunday and Monday, 25 and 26 Dec), 5 June, 24 Dec or 31 Dec. Store bededag is not a holiday (abolished from 2024).';

-- The end of the withdrawal period (exclusive): see the header. Ten days after the 14th always
-- hold a working day (the longest run of non-working days is five).
create or replace function private.withdrawal_deadline(p_started_at timestamptz, p_info_sent_at timestamptz)
returns timestamptz
language sql stable set search_path = '' as $$
  select (min(l.last_day + n) + 1)::timestamp at time zone 'Europe/Copenhagen'
    from (select case
                   when p_info_sent_at is null
                     then ((p_started_at at time zone 'Europe/Copenhagen')::date + 14 + interval '12 months')::date
                   else greatest((p_started_at at time zone 'Europe/Copenhagen')::date,
                                 (p_info_sent_at at time zone 'Europe/Copenhagen')::date) + 14
                 end as last_day) l
   cross join generate_series(0, 10) as n
   where not private.dk_non_working_day(l.last_day + n);
$$;
revoke all on function private.withdrawal_deadline(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function private.withdrawal_deadline(timestamptz, timestamptz) to service_role;
comment on function private.withdrawal_deadline(timestamptz, timestamptz) is
  'The instant the withdrawal period ends (exclusive; forbrugeraftaleloven § 19 stk. 2-4, 6), NULL when p_started_at is NULL. Dates are Europe/Copenhagen dates. With the withdrawal information sent (p_info_sent_at), day 0 is the later of the start day and the information day and the last day is day 0 + 14; without it, the start day + 14 plus 12 months. The last day moves forward while private.dk_non_working_day; the result is the start of the next Copenhagen day (start 2026-11-14, information the same day: 2026-11-30T23:00:00Z).';

-- Snapshots --------------------------------------------------------------------------------------
-- A withdrawal as every withdrawal writer answers it: timestamps as ISO text, nulls as JSON null.
create or replace function private.payments_withdrawal_json(p_withdrawal_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
           'id', w.id, 'status', w.status, 'stripe_subscription_id', w.stripe_subscription_id,
           'user_id', w.user_id, 'consumer_name', w.consumer_name, 'ack_email', w.ack_email,
           'statement_version', w.statement_version, 'locale', w.locale,
           'requested_at', w.requested_at, 'deadline_at', w.deadline_at,
           'retention_basis', w.retention_basis, 'manual_reason', w.manual_reason,
           'canceled_at', w.canceled_at, 'stripe_invoice_id', w.stripe_invoice_id,
           'paid_ore', w.paid_ore, 'retained_ore', w.retained_ore, 'refund_ore', w.refund_ore,
           'refund_tax_ore', w.refund_tax_ore, 'stripe_credit_note_id', w.stripe_credit_note_id,
           'refunded_at', w.refunded_at, 'ack_sent_at', w.ack_sent_at, 'alerted_at', w.alerted_at,
           'attempts', w.attempts,
           'subscription', jsonb_build_object('stripe_customer_id', s.stripe_customer_id,
                                              'started_at', s.started_at, 'status', s.status))
    from public.subscription_withdrawals w
    join public.subscriptions s on s.stripe_subscription_id = w.stripe_subscription_id
   where w.id = p_withdrawal_id;
$$;
revoke all on function private.payments_withdrawal_json(uuid) from public, anon, authenticated;
grant execute on function private.payments_withdrawal_json(uuid) to service_role;
comment on function private.payments_withdrawal_json(uuid) is
  'The JSON snapshot of a withdrawal the withdrawal writers answer: {id, status, stripe_subscription_id, user_id, consumer_name, ack_email, statement_version, locale, requested_at, deadline_at, retention_basis, manual_reason, canceled_at, stripe_invoice_id, paid_ore, retained_ore, refund_ore, refund_tax_ore, stripe_credit_note_id, refunded_at, ack_sent_at, alerted_at, attempts, subscription: {stripe_customer_id, started_at, status}} (timestamps ISO text, nulls JSON null); NULL when there is no such withdrawal.';

-- The order confirmation email's context of a recorded consent.
create or replace function private.payments_consent_mail(p_checkout_session_id text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
           'checkout_session_id', c.stripe_checkout_session_id,
           'subscription_id', c.stripe_subscription_id,
           'user_id', c.user_id,
           'locale', c.locale,
           'text_version', c.text_version,
           'accepted_at', c.accepted_at,
           'started_at', s.started_at,
           'plan', jsonb_build_object(
             'billing_interval', p.billing_interval,
             'amount_ore', p.amount_ore,
             'name', coalesce((select t.name from public.monitor_plan_translations t
                                where t.plan_id = p.id and t.locale = c.locale),
                              (select t.name from public.monitor_plan_translations t
                                where t.plan_id = p.id and t.locale = 'da'))))
    from public.subscription_consents c
    join public.subscriptions s on s.stripe_subscription_id = c.stripe_subscription_id
    join public.monitor_plans p on p.id = s.plan_id
   where c.stripe_checkout_session_id = p_checkout_session_id;
$$;
revoke all on function private.payments_consent_mail(text) from public, anon, authenticated;
grant execute on function private.payments_consent_mail(text) to service_role;
comment on function private.payments_consent_mail(text) is
  'The order confirmation email''s context of a recorded consent (ConsentMail): {checkout_session_id, subscription_id, user_id (NULL once the account is deleted), locale, text_version, accepted_at, started_at, plan: {billing_interval, amount_ore, name (in the consent''s locale, else Danish)}}; NULL when there is no such consent.';

-- Consent writers ---------------------------------------------------------------------------------
-- p_consent = {checkout_session_id, subscription_id, text_version, text_sha256, locale,
-- stripe_consent, accepted_at}, every key required with its JSON type.
create or replace function public.payments_record_checkout_consent(p_consent jsonb) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_session text := p_consent ->> 'checkout_session_id';
  v_sub_id  text := p_consent ->> 'subscription_id';
  v_user    uuid;
  v_outcome text;
  v_stored  text;
  v_info    timestamptz;
begin
  if jsonb_typeof(p_consent -> 'checkout_session_id') is distinct from 'string'
     or v_session !~ '^cs_(test|live)_[A-Za-z0-9]+$'
     or jsonb_typeof(p_consent -> 'subscription_id') is distinct from 'string'
     or v_sub_id !~ '^sub_[A-Za-z0-9]+$'
     or jsonb_typeof(p_consent -> 'text_version') is distinct from 'string'
     or (p_consent ->> 'text_version') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{1,3}$'
     or jsonb_typeof(p_consent -> 'text_sha256') is distinct from 'string'
     or (p_consent ->> 'text_sha256') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_consent -> 'locale') is distinct from 'string'
     or (p_consent ->> 'locale') not in ('da', 'en')
     or jsonb_typeof(p_consent -> 'stripe_consent') is distinct from 'string'
     or (p_consent ->> 'stripe_consent') <> 'accepted'
     or jsonb_typeof(p_consent -> 'accepted_at') is distinct from 'string'
     or not private.payments_valid_timestamptz(p_consent ->> 'accepted_at') then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  -- Lock order: the subscription row first.
  select s.user_id into v_user from public.subscriptions s where s.stripe_subscription_id = v_sub_id for update;
  if not found then
    raise exception 'unknown_subscription' using errcode = 'P0001';
  end if;

  -- Append-only: the first record for the session or the subscription wins; a replay, also one
  -- with other values, changes nothing.
  insert into public.subscription_consents
    (stripe_checkout_session_id, stripe_subscription_id, user_id, text_version, text_sha256, locale,
     stripe_consent, accepted_at)
  values (v_session, v_sub_id, v_user, p_consent ->> 'text_version', p_consent ->> 'text_sha256',
          (p_consent ->> 'locale')::public.locale_code, 'accepted', (p_consent ->> 'accepted_at')::timestamptz)
  on conflict do nothing;
  v_outcome := case when found then 'recorded' else 'duplicate' end;

  select c.stripe_checkout_session_id, c.info_sent_at into v_stored, v_info
    from public.subscription_consents c where c.stripe_subscription_id = v_sub_id;
  return jsonb_build_object(
    'outcome', v_outcome,
    'mail', case when v_stored is not null and v_info is null then private.payments_consent_mail(v_stored) end);
end;
$$;
revoke all on function public.payments_record_checkout_consent(jsonb) from public, anon, authenticated;
grant execute on function public.payments_record_checkout_consent(jsonb) to service_role;
comment on function public.payments_record_checkout_consent(jsonb) is
  'Payments Worker (service_role only): records a Checkout Session''s accepted consent (p_consent = {checkout_session_id cs_(test|live)_…, subscription_id sub_…, text_version YYYY-MM-DD.n, text_sha256 64 hex, locale da|en, stripe_consent accepted, accepted_at ISO timestamp}; 22023 invalid_payload otherwise) for the stored subscription''s user (never one from the payload). Locks the subscription row first; P0001 unknown_subscription when there is none. Append-only: the first record for the session or the subscription wins. Returns {"outcome": "recorded" | "duplicate", "mail": ConsentMail | null}, mail (private.payments_consent_mail of the stored record) non-null while that record''s info_sent_at is null.';

create or replace function public.payments_mark_consent_info_sent(p_checkout_session_id text, p_email_id text)
returns jsonb
language plpgsql volatile set search_path = '' as $$
begin
  if p_checkout_session_id is null or p_checkout_session_id !~ '^cs_(test|live)_[A-Za-z0-9]+$'
     or p_email_id is null or char_length(p_email_id) not between 1 and 200 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  update public.subscription_consents c
     set info_sent_at = now(), info_email_id = p_email_id
   where c.stripe_checkout_session_id = p_checkout_session_id and c.info_sent_at is null;
  if found then
    return jsonb_build_object('outcome', 'stamped');
  end if;
  if not exists (select 1 from public.subscription_consents c where c.stripe_checkout_session_id = p_checkout_session_id) then
    raise exception 'unknown_consent' using errcode = 'P0001';
  end if;
  return jsonb_build_object('outcome', 'already');
end;
$$;
revoke all on function public.payments_mark_consent_info_sent(text, text) from public, anon, authenticated;
grant execute on function public.payments_mark_consent_info_sent(text, text) to service_role;
comment on function public.payments_mark_consent_info_sent(text, text) is
  'Payments Worker (service_role only): stamps a consent''s order confirmation email as sent (info_sent_at = now(), info_email_id = p_email_id, 1 to 200 characters) when it is not stamped yet: the first stamp wins. Returns {"outcome": "stamped" | "already"}; P0001 unknown_consent when the session has no consent; 22023 invalid_payload for a malformed argument.';

-- Withdrawal writers ------------------------------------------------------------------------------
create or replace function public.payments_begin_withdrawal(
  p_user_id uuid, p_subscription_id text, p_consumer_name text, p_ack_email text,
  p_statement_version text, p_locale text)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_sub         public.subscriptions%rowtype;
  v_existing    public.subscription_withdrawals%rowtype;
  v_info        timestamptz;
  v_has_consent boolean;
  v_deadline    timestamptz;
  v_id          uuid;
begin
  if p_user_id is null
     or p_subscription_id is null or p_subscription_id !~ '^sub_[A-Za-z0-9]+$'
     or p_consumer_name is null or char_length(btrim(p_consumer_name)) not between 1 and 200
     or p_consumer_name ~ '[[:cntrl:]]'
     or p_ack_email is null or char_length(p_ack_email) not between 3 and 320 or position('@' in p_ack_email) = 0
     or p_statement_version is null or p_statement_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{1,3}$'
     or p_locale is null or p_locale not in ('da', 'en') then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  -- Lock order: the subscription row first, so concurrent begins for it queue up.
  select * into v_sub from public.subscriptions s where s.stripe_subscription_id = p_subscription_id for update;

  -- One withdrawal per subscription: a repeated submit of its user resumes it (no window check).
  select * into v_existing from public.subscription_withdrawals w where w.stripe_subscription_id = p_subscription_id;
  if found then
    if v_existing.user_id is not distinct from p_user_id then
      return jsonb_build_object('outcome', 'existing', 'withdrawal', private.payments_withdrawal_json(v_existing.id));
    end if;
    raise exception 'not_withdrawable' using errcode = 'P0001';
  end if;

  -- One refusal for every other reason, so nothing about another user's subscription leaks.
  if v_sub.stripe_subscription_id is null
     or v_sub.user_id is distinct from p_user_id
     or v_sub.status not in ('trialing', 'active', 'past_due')
     or v_sub.started_at is null then
    raise exception 'not_withdrawable' using errcode = 'P0001';
  end if;

  select c.info_sent_at into v_info from public.subscription_consents c where c.stripe_subscription_id = p_subscription_id;
  v_has_consent := found;
  v_deadline := private.withdrawal_deadline(v_sub.started_at, v_info);
  if now() >= v_deadline then
    raise exception 'window_expired' using errcode = 'P0001';
  end if;

  insert into public.subscription_withdrawals
    (stripe_subscription_id, user_id, consumer_name, ack_email, statement_version, locale, deadline_at, retention_basis)
  values (p_subscription_id, p_user_id, btrim(p_consumer_name), p_ack_email, p_statement_version,
          p_locale::public.locale_code, v_deadline, case when v_has_consent then 'consent' else 'no_consent' end)
  returning id into v_id;
  return jsonb_build_object('outcome', 'created', 'withdrawal', private.payments_withdrawal_json(v_id));
end;
$$;
revoke all on function public.payments_begin_withdrawal(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.payments_begin_withdrawal(uuid, text, text, text, text, text) to service_role;
comment on function public.payments_begin_withdrawal(uuid, text, text, text, text, text) is
  'Payments Worker (service_role only): records a withdrawal notice for p_user_id (verified by the Worker from the access token) on p_subscription_id, with the consumer''s name (1 to 200 characters trimmed, no control character), the receipt address (the account email, 3 to 320 characters with @), the statement''s text version and locale (da|en); 22023 invalid_payload otherwise. Locks the subscription row first. A withdrawal already recorded for it: the same user gets {"outcome": "existing", "withdrawal": W} (resumed, no window check), another user P0001 not_withdrawable. Else P0001 not_withdrawable unless the subscription exists, is the user''s, is trialing/active/past_due and has started_at; P0001 window_expired when now() is at or past private.withdrawal_deadline(started_at, the consent''s info_sent_at). Inserts the withdrawal (requested_at = now(), deadline_at, retention_basis consent when a consent is recorded, else no_consent) and returns {"outcome": "created", "withdrawal": W} (W = private.payments_withdrawal_json).';

create or replace function public.payments_claim_withdrawal(p_withdrawal_id uuid, p_lease_seconds integer)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_sub_id  text;
  v_w       public.subscription_withdrawals%rowtype;
  v_outcome text;
begin
  if p_withdrawal_id is null or p_lease_seconds is null or p_lease_seconds not between 1 and 600 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  select w.stripe_subscription_id into v_sub_id from public.subscription_withdrawals w where w.id = p_withdrawal_id;
  if not found then
    raise exception 'unknown_withdrawal' using errcode = 'P0001';
  end if;
  perform 1 from public.subscriptions s where s.stripe_subscription_id = v_sub_id for update;
  select * into v_w from public.subscription_withdrawals w where w.id = p_withdrawal_id for update;

  if not (v_w.status in ('received', 'canceled') or v_w.ack_sent_at is null
          or (v_w.status = 'needs_manual' and v_w.alerted_at is null)) then
    v_outcome := 'done';
  elsif v_w.lease_until is not null and v_w.lease_until > now() then
    v_outcome := 'busy';
  else
    update public.subscription_withdrawals w
       set lease_until = now() + make_interval(secs => p_lease_seconds), attempts = w.attempts + 1, updated_at = now()
     where w.id = p_withdrawal_id;
    v_outcome := 'claimed';
  end if;
  return jsonb_build_object('outcome', v_outcome, 'withdrawal', private.payments_withdrawal_json(p_withdrawal_id));
end;
$$;
revoke all on function public.payments_claim_withdrawal(uuid, integer) from public, anon, authenticated;
grant execute on function public.payments_claim_withdrawal(uuid, integer) to service_role;
comment on function public.payments_claim_withdrawal(uuid, integer) is
  'Payments Worker (service_role only): leases a withdrawal for p_lease_seconds (1 to 600; 22023 invalid_payload otherwise). Locks the subscription row, then the withdrawal row. With work left (status received or canceled, no receipt stamped, or needs_manual without the owner alert) and no live lease: sets lease_until = now() + lease, attempts + 1, {"outcome": "claimed", "withdrawal": W}; leased: {"outcome": "busy", "withdrawal": W}; nothing left: {"outcome": "done", "withdrawal": W}. P0001 unknown_withdrawal.';

create or replace function public.payments_withdrawal_step(p_withdrawal_id uuid, p_step text, p_data jsonb)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_sub_id   text;
  v_w        public.subscription_withdrawals%rowtype;
  v_applied  boolean := false;
  v_invoice  text;
  v_start    timestamptz;
  v_end      timestamptz;
  v_paid     bigint;
  v_retained bigint;
  v_refund   bigint;
  v_tax      bigint;
  v_total    bigint;
begin
  if p_withdrawal_id is null or p_step is null
     or p_step not in ('canceled', 'refunded', 'no_refund_due', 'needs_manual', 'ack_sent', 'alerted', 'failed')
     or jsonb_typeof(p_data) is distinct from 'object' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  select w.stripe_subscription_id into v_sub_id from public.subscription_withdrawals w where w.id = p_withdrawal_id;
  if not found then
    raise exception 'unknown_withdrawal' using errcode = 'P0001';
  end if;
  -- Lock order: the subscription row, then the withdrawal row (then, when refunded, the invoice row).
  perform 1 from public.subscriptions s where s.stripe_subscription_id = v_sub_id for update;
  select * into v_w from public.subscription_withdrawals w where w.id = p_withdrawal_id for update;

  case p_step
  when 'canceled' then
    if jsonb_typeof(p_data -> 'canceled_at') is distinct from 'string'
       or not private.payments_valid_timestamptz(p_data ->> 'canceled_at') then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
    if v_w.status = 'received' or (v_w.status = 'needs_manual' and v_w.canceled_at is null) then
      -- needs_manual keeps its status; it only records that the subscription is stopped.
      update public.subscription_withdrawals w
         set status = case when w.status = 'received' then 'canceled' else w.status end,
             canceled_at = (p_data ->> 'canceled_at')::timestamptz, updated_at = now()
       where w.id = p_withdrawal_id;
      v_applied := true;
    end if;

  when 'refunded' then
    if jsonb_typeof(p_data -> 'stripe_invoice_id') is distinct from 'string'
       or (p_data ->> 'stripe_invoice_id') !~ '^in_[A-Za-z0-9]+$'
       or jsonb_typeof(p_data -> 'service_start_at') is distinct from 'string'
       or not private.payments_valid_timestamptz(p_data ->> 'service_start_at')
       or jsonb_typeof(p_data -> 'period_end_at') is distinct from 'string'
       or not private.payments_valid_timestamptz(p_data ->> 'period_end_at')
       or jsonb_typeof(p_data -> 'paid_ore') is distinct from 'number'
       or jsonb_typeof(p_data -> 'retained_ore') is distinct from 'number'
       or jsonb_typeof(p_data -> 'refund_ore') is distinct from 'number'
       or jsonb_typeof(p_data -> 'refund_tax_ore') is distinct from 'number'
       or (p_data ->> 'calc_version') is distinct from 'wd-refund-1'
       or jsonb_typeof(p_data -> 'stripe_credit_note_id') is distinct from 'string'
       or (p_data ->> 'stripe_credit_note_id') !~ '^cn_[A-Za-z0-9]+$'
       or jsonb_typeof(p_data -> 'stripe_refund_id') is distinct from 'string'
       or (p_data ->> 'stripe_refund_id') !~ '^re_[A-Za-z0-9]+$' then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
    -- The four amounts are JSON numbers here: whole, not negative, within bigint.
    if (p_data -> 'paid_ore')::numeric not between 0 and 9223372036854775807
       or (p_data -> 'paid_ore')::numeric <> trunc((p_data -> 'paid_ore')::numeric)
       or (p_data -> 'retained_ore')::numeric not between 0 and 9223372036854775807
       or (p_data -> 'retained_ore')::numeric <> trunc((p_data -> 'retained_ore')::numeric)
       or (p_data -> 'refund_ore')::numeric not between 0 and 9223372036854775807
       or (p_data -> 'refund_ore')::numeric <> trunc((p_data -> 'refund_ore')::numeric)
       or (p_data -> 'refund_tax_ore')::numeric not between 0 and 9223372036854775807
       or (p_data -> 'refund_tax_ore')::numeric <> trunc((p_data -> 'refund_tax_ore')::numeric) then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
    v_invoice  := p_data ->> 'stripe_invoice_id';
    v_start    := (p_data ->> 'service_start_at')::timestamptz;
    v_end      := (p_data ->> 'period_end_at')::timestamptz;
    v_paid     := (p_data -> 'paid_ore')::numeric::bigint;
    v_retained := (p_data -> 'retained_ore')::numeric::bigint;
    v_refund   := (p_data -> 'refund_ore')::numeric::bigint;
    v_tax      := (p_data -> 'refund_tax_ore')::numeric::bigint;
    -- Only a consent lets part of the payment be retained (a NULL basis counts as none).
    if v_refund <= 0 or v_paid <> v_retained + v_refund or v_tax > v_refund or v_end <= v_start
       or (v_w.retention_basis is distinct from 'consent' and v_retained <> 0) then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
    if v_w.status = 'completed' then
      -- A replay of the same refund is done already (the invoice is not counted twice); any other is refused.
      if v_w.stripe_invoice_id is distinct from v_invoice or v_w.service_start_at is distinct from v_start
         or v_w.period_end_at is distinct from v_end or v_w.paid_ore is distinct from v_paid
         or v_w.retained_ore is distinct from v_retained or v_w.refund_ore is distinct from v_refund
         or v_w.refund_tax_ore is distinct from v_tax or v_w.calc_version is distinct from 'wd-refund-1'
         or v_w.stripe_credit_note_id is distinct from (p_data ->> 'stripe_credit_note_id')
         or v_w.stripe_refund_id is distinct from (p_data ->> 'stripe_refund_id') then
        raise exception 'invalid_transition' using errcode = 'P0001';
      end if;
    elsif not (v_w.status = 'canceled' or (v_w.status = 'needs_manual' and v_w.canceled_at is not null)) then
      -- From canceled (the Worker), or needs_manual once the subscription is stopped (the owner
      -- records a refund made by hand, workers/payments/README.md runbook).
      raise exception 'invalid_transition' using errcode = 'P0001';
    else
      select i.amount_total_ore into v_total
        from public.subscription_invoices i
       where i.stripe_invoice_id = v_invoice and i.stripe_subscription_id = v_sub_id
         for update;
      if not found or v_paid > v_total then
        raise exception 'invoice_not_recorded' using errcode = 'P0001';
      end if;
      -- subscription_invoices_refund_le_total (23514) refuses a refund beyond what the invoice took.
      update public.subscription_invoices i
         set amount_refunded_ore = i.amount_refunded_ore + v_refund
       where i.stripe_invoice_id = v_invoice;
      update public.subscription_withdrawals w
         set status = 'completed', stripe_invoice_id = v_invoice, service_start_at = v_start, period_end_at = v_end,
             paid_ore = v_paid, retained_ore = v_retained, refund_ore = v_refund, refund_tax_ore = v_tax,
             calc_version = 'wd-refund-1', stripe_credit_note_id = p_data ->> 'stripe_credit_note_id',
             stripe_refund_id = p_data ->> 'stripe_refund_id', refunded_at = now(), updated_at = now()
       where w.id = p_withdrawal_id;
      v_applied := true;
    end if;

  when 'no_refund_due' then
    if coalesce(jsonb_typeof(p_data -> 'stripe_invoice_id'), 'missing') not in ('null', 'string')
       or (jsonb_typeof(p_data -> 'stripe_invoice_id') = 'string'
           and (p_data ->> 'stripe_invoice_id') !~ '^in_[A-Za-z0-9]+$')
       or jsonb_typeof(p_data -> 'paid_ore') is distinct from 'number'
       or (p_data ->> 'calc_version') is distinct from 'wd-refund-1' then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
    -- paid_ore: 0 without a paid invoice; else the paid amount, kept in full (nothing to refund).
    if (p_data -> 'paid_ore')::numeric not between 0 and 9223372036854775807
       or (p_data -> 'paid_ore')::numeric <> trunc((p_data -> 'paid_ore')::numeric) then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
    v_invoice := p_data ->> 'stripe_invoice_id';
    v_paid    := (p_data -> 'paid_ore')::numeric::bigint;
    -- Keeping a paid amount needs the consent to start at once (fl. § 25 stk. 1: without it
    -- everything is refunded); with no_consent only paid 0 completes without a refund.
    if v_paid > 0 and v_w.retention_basis is distinct from 'consent' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    if v_w.status = 'completed' then
      if v_w.stripe_invoice_id is distinct from v_invoice or v_w.paid_ore is distinct from v_paid
         or v_w.refund_ore is distinct from 0::bigint then
        raise exception 'invalid_transition' using errcode = 'P0001';
      end if;
    elsif not (v_w.status = 'canceled' or (v_w.status = 'needs_manual' and v_w.canceled_at is not null)) then
      raise exception 'invalid_transition' using errcode = 'P0001';
    else
      update public.subscription_withdrawals w
         set status = 'completed', stripe_invoice_id = v_invoice, paid_ore = v_paid, retained_ore = v_paid,
             refund_ore = 0, refund_tax_ore = 0, calc_version = 'wd-refund-1', updated_at = now()
       where w.id = p_withdrawal_id;
      v_applied := true;
    end if;

  when 'needs_manual' then
    if (p_data ->> 'reason') is null
       or (p_data ->> 'reason') not in ('subscription_mismatch', 'invoice_shape', 'stripe_refused', 'retries_exhausted')
       or jsonb_typeof(p_data -> 'reason') is distinct from 'string' then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
    if v_w.status in ('received', 'canceled') then
      update public.subscription_withdrawals w
         set status = 'needs_manual', manual_reason = p_data ->> 'reason', updated_at = now()
       where w.id = p_withdrawal_id;
      v_applied := true;
    elsif v_w.status <> 'needs_manual' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;

  when 'ack_sent' then
    if jsonb_typeof(p_data -> 'email_id') is distinct from 'string'
       or char_length(p_data ->> 'email_id') not between 1 and 200 then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
    if v_w.ack_sent_at is null then
      update public.subscription_withdrawals w
         set ack_sent_at = now(), ack_email_id = p_data ->> 'email_id', updated_at = now()
       where w.id = p_withdrawal_id;
      v_applied := true;
    end if;

  when 'alerted' then
    if v_w.status <> 'needs_manual' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    if v_w.alerted_at is null then
      update public.subscription_withdrawals w set alerted_at = now(), updated_at = now() where w.id = p_withdrawal_id;
      v_applied := true;
    end if;

  when 'failed' then
    if jsonb_typeof(p_data -> 'code') is distinct from 'string' or (p_data ->> 'code') !~ '^[a-z_]{1,64}$' then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
    update public.subscription_withdrawals w
       set last_error = p_data ->> 'code', lease_until = null, updated_at = now()
     where w.id = p_withdrawal_id;
    v_applied := true;
  end case;

  -- An applied step that leaves no work releases the lease.
  if v_applied then
    update public.subscription_withdrawals w
       set lease_until = null
     where w.id = p_withdrawal_id and w.lease_until is not null
       and not (w.status in ('received', 'canceled') or w.ack_sent_at is null
                or (w.status = 'needs_manual' and w.alerted_at is null));
  end if;
  return jsonb_build_object('outcome', case when v_applied then 'applied' else 'already' end,
                            'withdrawal', private.payments_withdrawal_json(p_withdrawal_id));
end;
$$;
revoke all on function public.payments_withdrawal_step(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.payments_withdrawal_step(uuid, text, jsonb) to service_role;
comment on function public.payments_withdrawal_step(uuid, text, jsonb) is
  'Payments Worker (service_role only): records one step of a withdrawal and returns {"outcome": "applied" | "already", "withdrawal": W}. Locks the subscription row, then the withdrawal row. Steps (p_data): canceled {canceled_at}: received -> canceled; needs_manual gets canceled_at once and keeps its status; otherwise already. refunded {stripe_invoice_id, service_start_at, period_end_at, paid_ore, retained_ore, refund_ore, refund_tax_ore, calc_version wd-refund-1, stripe_credit_note_id, stripe_refund_id}: from canceled, or from needs_manual once canceled_at is set (the owner recording a refund made by hand, workers/payments/README.md), needs refund_ore > 0, paid = retained + refund, refund_tax <= refund, retained 0 for retention_basis no_consent (22023 otherwise); the invoice must be recorded for the subscription with paid <= amount_total_ore (P0001 invoice_not_recorded); adds refund_ore to its amount_refunded_ore (23514 subscription_invoices_refund_le_total beyond the total) and completes the withdrawal; a replay with identical data on a completed row is already (no second increment), different data P0001 invalid_transition. no_refund_due {stripe_invoice_id or null, paid_ore, calc_version}: from canceled, or from needs_manual once canceled_at is set; completed with nothing refunded (retained = paid, refund 0); paid_ore > 0 only for retention_basis consent (else P0001 invalid_transition), 0 without a paid invoice. needs_manual {reason subscription_mismatch|invoice_shape|stripe_refused|retries_exhausted}: from received or canceled; already when needs_manual. ack_sent {email_id, 1 to 200 characters}: stamps the receipt once, any status. alerted {}: stamps the owner alert once, needs_manual only. failed {code ^[a-z_]{1,64}$}: last_error = code (never free text), lease released. Any other transition P0001 invalid_transition; P0001 unknown_withdrawal; 22023 invalid_payload for a malformed argument. An applied step that leaves no work releases the lease.';

create or replace function public.payments_pending_work(p_limit integer, p_max_mail_attempts integer) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 50
     or p_max_mail_attempts is null or p_max_mail_attempts not between 1 and 1000 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'withdrawals', coalesce((
      select jsonb_agg(q.id order by q.updated_at, q.id)
        from (select w.id, w.updated_at
                from public.subscription_withdrawals w
               -- A cancel or refund left: always. Only an email left (the receipt, or the owner
               -- alert): while fewer than p_max_mail_attempts passes were made, so an email the
               -- mail service keeps refusing is given up.
               where (w.status in ('received', 'canceled')
                      or ((w.ack_sent_at is null or (w.status = 'needs_manual' and w.alerted_at is null))
                          and w.attempts < p_max_mail_attempts))
                 and (w.lease_until is null or w.lease_until <= now())
               -- The least recently touched first: a claim and every step move a withdrawal to
               -- the back, so one that keeps failing never holds the front of the list.
               order by w.updated_at, w.id
               limit p_limit) q), '[]'::jsonb),
    'consents', coalesce((
      select jsonb_agg(private.payments_consent_mail(q.stripe_checkout_session_id)
                       order by q.accepted_at, q.stripe_checkout_session_id)
        from (select c.stripe_checkout_session_id, c.accepted_at
                from public.subscription_consents c
                join public.subscriptions s on s.stripe_subscription_id = c.stripe_subscription_id
               where c.info_sent_at is null
                 and c.user_id is not null
                 and c.accepted_at > now() - interval '30 days'
                 -- An ended contract needs no withdrawal information (a canceled duplicate included).
                 and s.status not in ('canceled', 'incomplete_expired')
               order by c.accepted_at, c.stripe_checkout_session_id
               limit p_limit) q), '[]'::jsonb));
end;
$$;
revoke all on function public.payments_pending_work(integer, integer) from public, anon, authenticated;
grant execute on function public.payments_pending_work(integer, integer) to service_role;
comment on function public.payments_pending_work(integer, integer) is
  'Payments Worker sweep (service_role only): {"withdrawals": [id, …], "consents": [ConsentMail, …]}, at most p_limit (1 to 50) of each; 22023 invalid_payload for a p_limit or a p_max_mail_attempts (1 to 1000) out of range. Withdrawals with no live lease and work left: received or canceled, or (no receipt stamped, or needs_manual without the owner alert) with fewer than p_max_mail_attempts passes (attempts); the least recently updated first (updated_at, id), so a claimed or failed one goes to the back. Consents whose order confirmation is not stamped, with a user, accepted in the last 30 days, of a subscription that has not ended (canceled and incomplete_expired are skipped), oldest first (private.payments_consent_mail).';

-- The signed-in user's withdrawal status ---------------------------------------------------------
create or replace function public.my_withdrawal_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user        uuid := auth.uid();
  v_sub         public.subscriptions%rowtype;
  v_info        timestamptz;
  v_has_consent boolean;
  v_deadline    timestamptz;
  v_w           public.subscription_withdrawals%rowtype;
  v_invoice     jsonb;
begin
  if v_user is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- The newest subscription that entitles or has a withdrawal.
  select * into v_sub
    from public.subscriptions s
   where s.user_id = v_user
     and (s.status in ('trialing', 'active', 'past_due')
          or exists (select 1 from public.subscription_withdrawals w where w.stripe_subscription_id = s.stripe_subscription_id))
   order by s.started_at desc nulls last, s.created_at desc
   limit 1;
  if not found then
    return null;
  end if;

  select c.info_sent_at into v_info from public.subscription_consents c where c.stripe_subscription_id = v_sub.stripe_subscription_id;
  v_has_consent := found;
  v_deadline := private.withdrawal_deadline(v_sub.started_at, v_info);
  select * into v_w from public.subscription_withdrawals w where w.stripe_subscription_id = v_sub.stripe_subscription_id;
  select jsonb_build_object('stripe_invoice_id', i.stripe_invoice_id, 'amount_total_ore', i.amount_total_ore,
                            'period_start', i.period_start, 'period_end', i.period_end)
    into v_invoice
    from public.subscription_invoices i
   where i.stripe_subscription_id = v_sub.stripe_subscription_id
   order by i.paid_at desc, i.stripe_invoice_id desc
   limit 1;

  return jsonb_build_object(
    'subscription_id', v_sub.stripe_subscription_id,
    'status', v_sub.status,
    'started_at', v_sub.started_at,
    'deadline_at', v_deadline,
    'window_open', coalesce(v_w.id is null and v_sub.status in ('trialing', 'active', 'past_due')
                            and v_deadline is not null and now() < v_deadline, false),
    'has_consent', v_has_consent,
    'withdrawal', case when v_w.id is not null then jsonb_build_object(
                    'id', v_w.id, 'status', v_w.status, 'requested_at', v_w.requested_at,
                    'paid_ore', v_w.paid_ore, 'retained_ore', v_w.retained_ore, 'refund_ore', v_w.refund_ore,
                    'refunded_at', v_w.refunded_at) end,
    'invoice', v_invoice);
end;
$$;
alter function public.my_withdrawal_status() owner to postgres;
revoke all on function public.my_withdrawal_status() from public, anon, authenticated;
grant execute on function public.my_withdrawal_status() to authenticated;
comment on function public.my_withdrawal_status() is
  'The signed-in user''s withdrawal status (authenticated only; 42501 forbidden without a signed-in user): of their subscriptions that entitle (trialing, active, past_due) or have a withdrawal, the newest (started_at desc nulls last, created_at desc), as {subscription_id, status, started_at, deadline_at (private.withdrawal_deadline), window_open (no withdrawal, entitling, now() before the deadline), has_consent, withdrawal: null | {id, status, requested_at, paid_ore, retained_ore, refund_ore, refunded_at}, invoice: null | {stripe_invoice_id, amount_total_ore, period_start, period_end} (its newest paid invoice)}; NULL when there is none. SECURITY DEFINER: reads the deadline helper and every row it needs for the caller only.';

-- PostgREST serves the new tables and functions without waiting for its schema cache to expire.
notify pgrst, 'reload schema';
