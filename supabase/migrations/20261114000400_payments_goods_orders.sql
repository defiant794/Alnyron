-- Payments slice S2: one-time purchase of a physical 3D figure (Denmark only). An admin sets an
-- item's offer (price incl. 25 % moms and delivery) in the item editor; the payments Worker
-- (alnyron-payments, named entrypoint OrderService, reached from the web app over a Cloudflare
-- service binding) opens a Stripe Checkout for it. Charge on dispatch (amendment A1): Checkout
-- only authorizes the payment (capture_method=manual, no Stripe invoice); the webhook records the
-- authorized order and emails the buyer (the order confirmation, which is the invoice) and the
-- owner; "Markér afsendt" captures the payment and marks the order shipped; a withdrawal before
-- dispatch releases the authorization (nothing is charged), a withdrawal after dispatch is
-- refunded with a Stripe refund once the owner approves it. Separate from the subscription
-- tables and writers (20261112000100, 20261114000300): own tables, own writers, own states.
--
-- Schema:
-- - item_offers: how an item is sold, one row per kind (physical | digital), price_ore 250 to
--   5 000 000 (bigint øre; OFFER_PRICE_MIN_ORE / OFFER_PRICE_MAX_ORE in src/config/payments.ts),
--   active; a digital offer cannot be live yet (item_offers_digital_not_live). Written by
--   admin_save_item (replaced below: its payload gains the optional key offers), which runs as
--   the admin (SECURITY INVOKER); anon and authenticated read only active offers of public items.
-- - routes_slug_reserved gains 'order' (the /order pages).
-- - orders: one goods Checkout Session (unique session and payment intent ids), the buyer
--   (user_id NULL for a guest), the delivery address, the amounts in øre, the goods text version
--   and its digest the buyer was shown, the Stripe consent, a comma list of anomalies the owner
--   should look at, the mail stamps, the payment (authorized at paid_at, the authorization's
--   expiry, captured_at) and the shipping. Status authorized -> shipped (captured at dispatch)
--   -> refunded, or authorized -> canceled (the authorization released or expired, nothing
--   charged; cancel_reason). order_number is a gapless-enough identity from 1001 shown to the
--   buyer and used as the invoice number.
-- - order_items: the item snapshot of each order line (title, unit price, tax), kept when the
--   item is deleted (item_id set null).
-- - order_withdrawals: one withdrawal per order (UNIQUE): the statement, requested_at (the
--   database clock), the deadline it is checked against (NULL while the goods are not shipped),
--   late (generated: the notice came after the deadline; accepted and recorded, never refused),
--   refund_due_at (requested_at + 14 days), then the owner's approval (goods returned or never
--   shipped, action cancel_authorization or refund, deduction for diminished value with a
--   reason, refund_ore) and the Worker's progress (Stripe refund or released authorization, mail
--   stamps, lease and attempts). Status received -> approved -> completed, or needs_manual (the
--   owner handles it by hand, workers/payments/README.md).
-- The three order tables: RLS on; every privilege revoked from PUBLIC, anon and authenticated
-- (anon then has no SELECT at all: 42501), SELECT granted to authenticated, whose policies admit
-- a user's own orders (and their lines and withdrawal) and admins every row. Nothing is written
-- by anon or authenticated. service_role keeps its default privileges and bypasses RLS. The
-- identity sequence of order_number is revoked from the API roles too (no nextval by anon).
--
-- The goods withdrawal period: private.order_withdrawal_deadline(shipped_at,
-- confirmation_sent_at) = 20261114000300's private.withdrawal_deadline (Danish non-working days,
-- the start of the next Copenhagen day, plus 12 months when the information was never sent)
-- from shipped_at + private.goods_transit_allowance() (7 days, GOODS_TRANSIT_ALLOWANCE_DAYS):
-- the period runs from the day the buyer receives the goods, which the shop does not record.
--
-- Writers (service_role only, SECURITY INVOKER, called by the payments Worker; all return jsonb):
-- payments_goods_offer (a read), payments_record_order, payments_order_mail_sent,
-- payments_order_begin_ship, payments_order_captured, payments_order_capture_failed,
-- payments_find_order (a read), payments_begin_order_withdrawal, payments_approve_order_refund,
-- payments_claim_order_withdrawal, payments_order_withdrawal_step, payments_pending_order_work
-- (a read), payments_sync_order_refund, payments_order_authorization_canceled. Malformed
-- arguments raise 22023 invalid_payload; refusals raise the code and message named in each
-- function's comment. Order and withdrawal snapshots in their answers come from
-- private.payments_order_json and private.payments_order_withdrawal_json. begin_ship, captured
-- and approve_order_refund take the acting user (verified by the Worker from the access token)
-- and check their profiles.role (owner or admin, else 42501 forbidden).
--
-- Security: every function has an empty search_path and fully qualified names and is owned by
-- postgres. EXECUTE on the public payments functions is revoked from PUBLIC, anon and
-- authenticated and granted to service_role. The writers run as their caller, service_role,
-- which holds every privilege on the tables they read and write; service_role gets EXECUTE on
-- exactly the private helpers they call (new here: private.goods_transit_allowance,
-- private.order_withdrawal_deadline, private.payments_order_json,
-- private.payments_order_withdrawal_json, and the existing visibility helper
-- private.item_is_public; from earlier files private.withdrawal_deadline, private.dk_easter_sunday,
-- private.dk_non_working_day and private.payments_valid_timestamptz). The helpers take no user
-- input beyond ids and dates and reach no table service_role cannot read anyway.
--
-- Lock order: every order writer locks the order row FOR UPDATE first, then (withdrawal writers)
-- the withdrawal row. Inserting an order or a withdrawal takes KEY SHARE on the user's auth.users
-- row (foreign key) after that; record_order inserts the event, then the order (the conflict
-- check on its session id), then its lines (KEY SHARE on the item row). Against an account
-- delete (auth.users FOR UPDATE, then the FK set-null on orders/order_withdrawals rows): the
-- writers never wait for a row the delete holds before taking theirs, so the two only queue.
--
-- Re-runnable: `create table / index if not exists`, constraints and triggers dropped before they
-- are added, `drop policy if exists` before each `create`, `create or replace function` (keeps
-- owner and ACL), and idempotent revoke, grant and comment. No transaction control: the migration
-- runner wraps the file.

-- item_offers --------------------------------------------------------------------------------------
create table if not exists public.item_offers (
  item_id    uuid not null references public.items (id) on delete cascade,
  kind       text not null check (kind in ('physical', 'digital')),
  price_ore  bigint not null check (price_ore between 250 and 5000000),
  active     boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  primary key (item_id, kind),
  constraint item_offers_digital_not_live check (kind <> 'digital' or not active)
);
comment on table public.item_offers is
  'How a catalog item is sold, one row per kind: physical (a 3D print, shipped in Denmark) or digital (not live yet: item_offers_digital_not_live). price_ore is the price incl. 25 % moms and delivery in øre (250 to 5 000 000). Only models3d items have offers (admin_save_item). anon and authenticated read the active offers of public items; admins read and write every row (through admin_save_item).';

drop trigger if exists item_offers_updated_at on public.item_offers;
create trigger item_offers_updated_at before update on public.item_offers
  for each row execute function private.set_updated_at();
drop trigger if exists item_offers_updated_by on public.item_offers;
create trigger item_offers_updated_by before insert or update on public.item_offers
  for each row execute function private.stamp_updated_by();

alter table public.item_offers enable row level security;
revoke all on table public.item_offers from public, anon, authenticated;
grant select on public.item_offers to anon, authenticated;
grant insert, update, delete on public.item_offers to authenticated;

drop policy if exists item_offers_select on public.item_offers;
create policy item_offers_select on public.item_offers for select to anon, authenticated
  using ((select private.is_admin()) or (active and private.item_is_public(item_id)));
drop policy if exists item_offers_insert on public.item_offers;
create policy item_offers_insert on public.item_offers for insert to authenticated
  with check ((select private.is_admin()));
drop policy if exists item_offers_update on public.item_offers;
create policy item_offers_update on public.item_offers for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
drop policy if exists item_offers_delete on public.item_offers;
create policy item_offers_delete on public.item_offers for delete to authenticated
  using ((select private.is_admin()));

-- Reserved slug ------------------------------------------------------------------------------------
alter table public.routes drop constraint if exists routes_slug_reserved;
alter table public.routes
  add constraint routes_slug_reserved check (slug <> all (array['admin', 'auth', 'api', 'da', 'en',
    'kontakt', 'contact', 'privatliv', 'privacy', 'mylife', 'terms', 'order']));

-- admin_save_item ----------------------------------------------------------------------------------
-- 20261105000100's function plus the optional payload key offers: [{kind, price_ore, active}],
-- each kind at most once. Checked before anything is written (22023 offers_invalid: not an
-- array, an element that is not an object with exactly those three keys, an unknown kind, a
-- duplicate kind, a price that is not a whole number from 250 to 5 000 000, a live digital
-- offer). After the item row is written: offers present and non-empty on an item whose section
-- is not models3d -> P0001 offers_not_allowed; present -> the item's offer set is replaced
-- (kinds not listed deleted, listed ones upserted); then an item outside models3d that still has
-- offers (moved there without offers: []) -> P0001 item_has_offers. Absent offers: untouched.
-- Everything else is unchanged.
--
-- payload: {id?, category_id (insert: required; update: moves the item when it differs),
--           featured?, price_type?, price_amount?, price_currency?, external_links?,
--           translations: {da: {slug, title, summary, body_md, seo_title, seo_description}, en: {...}},
--           media?: [{id, alt_da, alt_en, sort_order}], offers?: [{kind, price_ore, active}]}
create or replace function public.admin_save_item(payload jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_id         uuid;
  v_category   uuid;
  v_current    uuid;
  v_locale     public.locale_code;
  v_tr         jsonb;
  v_media      jsonb;
  v_constraint text;
  v_offers     jsonb := payload -> 'offers';
  v_offer      jsonb;
  v_kind       public.catalog_kind;
begin
  if not (select private.is_admin()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- An item holds at most 8 images, so a longer media list cannot name only its own.
  if jsonb_array_length(coalesce(payload -> 'media', '[]'::jsonb)) > 8 then
    raise exception 'too_many_media' using errcode = 'P0001';
  end if;

  -- Offers are checked before anything is written. Type checks first, numeric casts after them.
  if payload ? 'offers' then
    if jsonb_typeof(v_offers) is distinct from 'array' then
      raise exception 'offers_invalid' using errcode = '22023';
    end if;
    for v_offer in select value from jsonb_array_elements(v_offers)
    loop
      if jsonb_typeof(v_offer) is distinct from 'object' then
        raise exception 'offers_invalid' using errcode = '22023';
      end if;
      if (select count(*) from jsonb_object_keys(v_offer)) <> 3
         or jsonb_typeof(v_offer -> 'kind') is distinct from 'string'
         or jsonb_typeof(v_offer -> 'price_ore') is distinct from 'number'
         or jsonb_typeof(v_offer -> 'active') is distinct from 'boolean' then
        raise exception 'offers_invalid' using errcode = '22023';
      end if;
      if (v_offer ->> 'kind') not in ('physical', 'digital')
         or (v_offer -> 'price_ore')::numeric <> trunc((v_offer -> 'price_ore')::numeric)
         or (v_offer -> 'price_ore')::numeric not between 250 and 5000000
         or ((v_offer ->> 'kind') = 'digital' and (v_offer -> 'active')::boolean) then
        raise exception 'offers_invalid' using errcode = '22023';
      end if;
    end loop;
    if (select count(distinct e.value ->> 'kind') from jsonb_array_elements(v_offers) e) <> jsonb_array_length(v_offers) then
      raise exception 'offers_invalid' using errcode = '22023';
    end if;
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  v_category := nullif(payload ->> 'category_id', '')::uuid;
  if v_id is null then
    if v_category is null then
      raise exception 'category_required' using errcode = '22023';
    end if;
    insert into public.items
      (category_id, status, sort_order, featured, price_type, price_amount, price_currency, external_links)
    values (v_category, 'draft',
            coalesce((select max(i.sort_order) from public.items i where i.category_id = v_category), 0) + 10,
            coalesce((payload ->> 'featured')::boolean, false),
            (payload ->> 'price_type')::public.price_type,
            (payload ->> 'price_amount')::numeric,
            coalesce(payload ->> 'price_currency', 'DKK'),
            coalesce(nullif(payload -> 'external_links', 'null'::jsonb), '{}'::jsonb))
    returning id into v_id;   -- 23503 when category_id names no category
  else
    -- Locked before the section is read, so a concurrent save of this item cannot interleave.
    select i.category_id into v_current from public.items i where i.id = v_id for update;
    if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
    -- Only another section moves the item; absent, null or its own section keeps it in place.
    if v_category = v_current then
      v_category := null;
    end if;

    -- A price/link key present in the payload replaces the column (JSON null clears it:
    -- SQL null for the price, the column default for currency and links); absent keeps it.
    update public.items i
       set category_id    = coalesce(v_category, i.category_id),
           sort_order     = case when v_category is null then i.sort_order
                                 else coalesce((select max(o.sort_order) from public.items o
                                                 where o.category_id = v_category), 0) + 10 end,
           featured       = coalesce((payload ->> 'featured')::boolean, i.featured),
           price_type     = case when payload ? 'price_type'
                                 then (payload ->> 'price_type')::public.price_type else i.price_type end,
           price_amount   = case when payload ? 'price_amount'
                                 then (payload ->> 'price_amount')::numeric else i.price_amount end,
           price_currency = case when payload ? 'price_currency'
                                 then coalesce(payload ->> 'price_currency', 'DKK') else i.price_currency end,
           external_links = case when payload ? 'external_links'
                                 then coalesce(nullif(payload -> 'external_links', 'null'::jsonb), '{}'::jsonb)
                                 else i.external_links end
     where i.id = v_id;   -- 23503 when category_id names no category
  end if;

  -- Offers: only an item in a models3d section is sold. The section is read after the item row
  -- is written, so a move in this same save counts.
  select c.kind into v_kind from public.items i join public.categories c on c.id = i.category_id where i.id = v_id;
  if payload ? 'offers' then
    if jsonb_array_length(v_offers) > 0 and v_kind <> 'models3d' then
      raise exception 'offers_not_allowed' using errcode = 'P0001';
    end if;
    delete from public.item_offers f
     where f.item_id = v_id
       and f.kind not in (select e.value ->> 'kind' from jsonb_array_elements(v_offers) e);
    insert into public.item_offers (item_id, kind, price_ore, active)
    select v_id, e.value ->> 'kind', (e.value -> 'price_ore')::numeric::bigint, (e.value -> 'active')::boolean
      from jsonb_array_elements(v_offers) e
    on conflict (item_id, kind) do update
      set price_ore = excluded.price_ore, active = excluded.active;
  end if;
  if v_kind <> 'models3d' and exists (select 1 from public.item_offers f where f.item_id = v_id) then
    raise exception 'item_has_offers' using errcode = 'P0001';
  end if;

  for v_locale, v_tr in
    select key::public.locale_code, value from jsonb_each(coalesce(payload -> 'translations', '{}'::jsonb))
  loop
    begin
      insert into public.item_translations
        (item_id, locale, slug, title, summary, body_md, seo_title, seo_description)
      values (v_id, v_locale, v_tr ->> 'slug',
              coalesce(v_tr ->> 'title', ''), coalesce(v_tr ->> 'summary', ''), coalesce(v_tr ->> 'body_md', ''),
              coalesce(v_tr ->> 'seo_title', ''), coalesce(v_tr ->> 'seo_description', ''))
      on conflict (item_id, locale) do update
        set slug = excluded.slug, title = excluded.title, summary = excluded.summary,
            body_md = excluded.body_md, seo_title = excluded.seo_title,
            seo_description = excluded.seo_description;
    exception when unique_violation then
      -- The constraint name survives RLS (only the key DETAIL is dropped).
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'item_translations_locale_slug_key' then
        raise exception 'slug_taken'
          using errcode = '23505', constraint = v_constraint, hint = v_locale::text;
      end if;
      raise;
    end;
  end loop;

  for v_media in select value from jsonb_array_elements(coalesce(payload -> 'media', '[]'::jsonb))
  loop
    update public.media m
       set alt_da     = coalesce(v_media ->> 'alt_da', m.alt_da),
           alt_en     = coalesce(v_media ->> 'alt_en', m.alt_en),
           sort_order = coalesce((v_media ->> 'sort_order')::integer, m.sort_order)
     where m.id = (v_media ->> 'id')::uuid and m.item_id = v_id;
    if not found then raise exception 'media_not_found' using errcode = 'P0002'; end if;
  end loop;

  return v_id;
end;
$$;

revoke execute on function public.admin_save_item(jsonb) from public, anon;
grant  execute on function public.admin_save_item(jsonb) to authenticated;

comment on function public.admin_save_item(jsonb) is
  'Creates (no id: draft, sort_order = category max + 10, category_id required -> 22023 category_required, unknown -> 23503) or updates an item: price/link keys present in the payload replace the column, absent keys keep it; a category_id naming another section moves the item to the end of it (sort_order = target max + 10, status and published_at kept; unknown -> 23503), an absent, null or unchanged one keeps section and order (the item row is locked while its section is read). offers (optional, [{kind physical|digital, price_ore whole 250..5000000, active boolean}], each kind once, no live digital offer; 22023 offers_invalid otherwise, checked before anything is written) replaces the item''s whole offer set when present (absent keeps it): P0001 offers_not_allowed for a non-empty list on an item whose section is not models3d, and P0001 item_has_offers when an item outside models3d still has offers after the save (moved without offers: []). Upserts each given locale''s translation and updates alt/sort_order of the listed media of this item (at most 8 entries -> P0001 too_many_media; P0002 media_not_found otherwise). P0002 item_not_found; 23505 slug_taken (constraint item_translations_locale_slug_key) with the clashing translation''s locale as HINT, since RLS drops the key DETAIL; 23514 by constraint name. updated_by is set by the items_updated_by and item_offers_updated_by triggers.';

-- orders -------------------------------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity (start with 1001) unique,
  user_id uuid references auth.users (id) on delete set null,
  email text not null check (char_length(email) between 3 and 320 and position('@' in email) > 1),
  customer_name text check (char_length(customer_name) <= 200),
  phone text check (char_length(phone) <= 40),
  shipping_name text check (char_length(shipping_name) <= 200),
  shipping_address jsonb check (shipping_address is null or (jsonb_typeof(shipping_address) = 'object'
        and shipping_address ? 'line1' and shipping_address ? 'postal_code' and shipping_address ? 'city'
        and shipping_address ? 'country')),
  locale public.locale_code not null,
  currency char(3) not null check (currency ~ '^[a-z]{3}$'),
  amount_subtotal_ore bigint not null check (amount_subtotal_ore >= 0),
  amount_tax_ore bigint not null check (amount_tax_ore >= 0),
  amount_total_ore bigint not null check (amount_total_ore > 0),
  amount_refunded_ore bigint not null default 0
    check (amount_refunded_ore >= 0 and amount_refunded_ore <= amount_total_ore),
  status text not null default 'authorized' check (status in ('authorized', 'shipped', 'refunded', 'canceled')),
  stripe_checkout_session_id text not null unique check (stripe_checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]+$'),
  stripe_payment_intent_id text not null unique check (stripe_payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  stripe_customer_id text check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  stripe_invoice_id text unique check (stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  terms_version text not null check (char_length(terms_version) between 1 and 64),
  terms_sha256 text check (terms_sha256 ~ '^[0-9a-f]{64}$'),
  stripe_consent text check (stripe_consent in ('accepted')),
  anomaly text check (anomaly ~ '^[a-z_]{1,64}(,[a-z_]{1,64})*$'),
  paid_at timestamptz not null,
  authorization_expires_at timestamptz,
  captured_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text check (cancel_reason in ('withdrawn', 'authorization_expired', 'owner')),
  confirmation_sent_at timestamptz,
  confirmation_email_id text,
  owner_notified_at timestamptz,
  owner_email_id text,
  capture_warning_sent_at timestamptz,
  capture_warning_email_id text,
  expired_alert_sent_at timestamptz,
  expired_alert_email_id text,
  shipped_at timestamptz,
  shipped_by uuid references auth.users (id) on delete set null,
  tracking_ref text check (char_length(tracking_ref) <= 200),
  shipped_email_sent_at timestamptz,
  shipped_email_id text,
  mail_attempts int not null default 0 check (mail_attempts >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_shipped_stamped check (status <> 'shipped' or shipped_at is not null),
  -- Money moves only once captured: shipped and refunded orders were captured, and only a
  -- captured amount can be refunded.
  constraint orders_captured check ((status not in ('shipped', 'refunded') or captured_at is not null)
                                    and (amount_refunded_ore = 0 or captured_at is not null)),
  -- A canceled order released its authorization before dispatch: never captured, never shipped.
  constraint orders_canceled check ((status = 'canceled') = (canceled_at is not null)
                                    and (canceled_at is null) = (cancel_reason is null)
                                    and (status <> 'canceled' or (captured_at is null and shipped_at is null))),
  check (shipping_address is not null or anomaly is not null)
);
create index if not exists orders_user_idx on public.orders (user_id);
create index if not exists orders_email_idx on public.orders (lower(email));
create index if not exists orders_status_paid_idx on public.orders (status, paid_at desc);
comment on table public.orders is
  'One goods order (slice S2), one per Stripe Checkout Session and payment intent: the buyer (user_id NULL for a guest or once the account is deleted), email, name, phone and Danish delivery address, locale, amounts in øre (total incl. moms and delivery, tax, refunded so far: never more than was captured), the goods text version and digest shown (terms_sha256 NULL for an unknown version), Stripe''s consent (NULL = not accepted), anomaly (comma list of codes the owner should check, NULL = none). The payment (charge on dispatch): authorized at Checkout (paid_at; authorization_expires_at = the card''s capture_before, NULL for other methods), captured at dispatch (captured_at). Status authorized -> shipped (captured, shipped_at, shipped_by, tracking_ref) -> refunded (captured money refunded, fully or after a deduction), or authorized -> canceled (canceled_at, cancel_reason withdrawn | authorization_expired | owner: the authorization was released or lapsed, nothing was charged). The mail stamps: confirmation (the order confirmation, which is the invoice), owner, capture_warning (to the owner before the authorization lapses), expired_alert (to the owner once it lapsed: do not send the goods), shipped (the shipped email); mail_attempts counts failed sends. order_number (from 1001) is what the buyer sees and the invoice number. Written by service_role only; authenticated reads its own orders, admins every order.';

-- No caller but the writers takes order numbers.
revoke all on sequence public.orders_order_number_seq from public, anon, authenticated;

-- order_items --------------------------------------------------------------------------------------
create table if not exists public.order_items (
  order_id uuid not null references public.orders (id) on delete restrict,
  line_no smallint not null check (line_no >= 1),
  item_id uuid references public.items (id) on delete set null,
  offer_kind text not null check (offer_kind in ('physical', 'digital')),
  title text not null check (btrim(title) <> '' and char_length(title) <= 160),
  quantity int not null check (quantity between 1 and 10),
  unit_amount_ore bigint not null check (unit_amount_ore > 0),
  amount_total_ore bigint not null check (amount_total_ore >= 0),
  amount_tax_ore bigint not null check (amount_tax_ore >= 0),
  vat_rate_bp int not null default 2500 check (vat_rate_bp = 2500),
  primary key (order_id, line_no)
);
create index if not exists order_items_item_idx on public.order_items (item_id);
comment on table public.order_items is
  'The lines of an order as bought: the item (set null when the item is deleted), offer kind, title, quantity, unit price and line totals in øre incl. 25 % moms (vat_rate_bp 2500). No CHECK that the total equals unit × quantity: a mismatching paid order is recorded with the amount_mismatch anomaly. Written by service_role only; readable with the order.';

-- order_withdrawals --------------------------------------------------------------------------------
create table if not exists public.order_withdrawals (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders (id) on delete restrict,
  user_id uuid references auth.users (id) on delete set null,
  consumer_name text not null check (btrim(consumer_name) <> '' and char_length(consumer_name) <= 200),
  channel text not null check (channel in ('link', 'form', 'admin')),
  statement_version text not null check (char_length(statement_version) between 1 and 64),
  locale public.locale_code not null,
  requested_at timestamptz not null default now(),
  shipped_before_notice boolean not null,
  deadline_at timestamptz,
  late boolean generated always as (deadline_at is not null and requested_at > deadline_at) stored,
  refund_due_at timestamptz not null,
  status text not null default 'received' check (status in ('received', 'approved', 'completed', 'needs_manual')),
  goods_state text check (goods_state in ('returned', 'not_shipped')),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  deduction_ore bigint not null default 0 check (deduction_ore >= 0),
  deduction_reason text check (char_length(deduction_reason) <= 500),
  action text check (action in ('cancel_authorization', 'refund')),
  refund_ore bigint check (refund_ore > 0),
  refund_tax_ore bigint check (refund_tax_ore >= 0),
  stripe_refund_id text unique check (stripe_refund_id ~ '^re_[A-Za-z0-9]+$'),
  refunded_at timestamptz,
  authorization_canceled_at timestamptz,
  manual_reason text check (manual_reason ~ '^[a-z_]{1,64}$'),
  ack_sent_at timestamptz,
  ack_email_id text,
  owner_alerted_at timestamptz,
  owner_alert_email_id text,
  receipt_sent_at timestamptz,
  receipt_email_id text,
  reminder_sent_at timestamptz,
  manual_alert_sent_at timestamptz,
  manual_alert_email_id text,
  attempts int not null default 0,
  mail_attempts int not null default 0,
  last_error text check (char_length(last_error) <= 200),
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- approved_by is not required: the approving account may be deleted later (FK set null).
  constraint order_withdrawals_approved check (status in ('received', 'needs_manual')
         or (approved_at is not null and goods_state is not null and action is not null)),
  -- A refund has an amount; releasing the authorization refunds nothing and deducts nothing.
  constraint order_withdrawals_action check ((action is null and refund_ore is null)
         or (action = 'refund' and refund_ore is not null)
         or (action = 'cancel_authorization' and refund_ore is null and deduction_ore = 0)),
  constraint order_withdrawals_completed check (status <> 'completed'
         or (action = 'refund' and refunded_at is not null)
         or (action = 'cancel_authorization' and authorization_canceled_at is not null))
);
create index if not exists order_withdrawals_user_idx on public.order_withdrawals (user_id);
comment on table public.order_withdrawals is
  'One withdrawal (fortrydelse) per goods order: the consumer''s statement (name, channel link|form|admin, statement_version, locale), requested_at (the database clock: the authoritative notice time), whether the goods were shipped at that time, the deadline it is checked against (private.order_withdrawal_deadline; NULL when not shipped), late (generated: requested after the deadline, accepted and recorded, never refused) and refund_due_at (requested_at + 14 days). Then the owner''s approval (goods_state returned|not_shipped, deduction_ore and reason for diminished value) and its action: cancel_authorization (goods never shipped and nothing captured: the authorization is released, no refund_ore, no deduction) or refund (refund_ore = what is left after earlier refunds and the deduction). The Worker''s progress: status received -> approved -> completed (refund: stripe_refund_id, refunded_at, refund_tax_ore the reversed VAT; cancel_authorization: authorization_canceled_at), or needs_manual with manual_reason; ack/owner alert/receipt/reminder/manual alert mail stamps (a channel admin notice the owner recorded gets no ack and no owner alert), attempts, mail_attempts, last_error and lease_until belong to the Worker. Written by service_role only; readable with the order.';

alter table public.orders            enable row level security;
alter table public.order_items       enable row level security;
alter table public.order_withdrawals enable row level security;

revoke all on table public.orders, public.order_items, public.order_withdrawals from public, anon, authenticated;
grant select on public.orders, public.order_items, public.order_withdrawals to authenticated;

drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
-- A line and a withdrawal are visible iff their order is (the subquery applies orders_select).
drop policy if exists order_items_select on public.order_items;
create policy order_items_select on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_items.order_id));
drop policy if exists order_withdrawals_select on public.order_withdrawals;
create policy order_withdrawals_select on public.order_withdrawals for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_withdrawals.order_id));

-- The goods withdrawal period ----------------------------------------------------------------------
create or replace function private.goods_transit_allowance() returns interval
language sql immutable set search_path = '' as $$
  select interval '7 days';
$$;
revoke all on function private.goods_transit_allowance() from public, anon, authenticated;
grant execute on function private.goods_transit_allowance() to service_role;
comment on function private.goods_transit_allowance() is
  'The days added to an order''s shipped_at as its presumed delivery day (7 days; GOODS_TRANSIT_ALLOWANCE_DAYS in src/config/payments.ts): the goods withdrawal period runs from receipt, which the shop does not record.';

create or replace function private.order_withdrawal_deadline(p_shipped_at timestamptz, p_confirmation_sent_at timestamptz)
returns timestamptz
language sql stable set search_path = '' as $$
  select case when p_shipped_at is null then null
              else private.withdrawal_deadline(p_shipped_at + private.goods_transit_allowance(), p_confirmation_sent_at)
         end;
$$;
revoke all on function private.order_withdrawal_deadline(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function private.order_withdrawal_deadline(timestamptz, timestamptz) to service_role;
comment on function private.order_withdrawal_deadline(timestamptz, timestamptz) is
  'The instant a goods order''s withdrawal period ends (exclusive): NULL while p_shipped_at is NULL (not shipped), else private.withdrawal_deadline(p_shipped_at + private.goods_transit_allowance(), p_confirmation_sent_at): Danish non-working days, the start of the next Copenhagen day, plus 12 months when the order confirmation (the withdrawal information) was never sent.';

-- Snapshots ----------------------------------------------------------------------------------------
-- Every column of the order row (timestamps ISO text, øre as JSON numbers) plus its lines.
create or replace function private.payments_order_json(p_order_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select to_jsonb(o) || jsonb_build_object(
           'lines', coalesce((select jsonb_agg(to_jsonb(l) - 'order_id' order by l.line_no)
                                from public.order_items l where l.order_id = o.id), '[]'::jsonb))
    from public.orders o
   where o.id = p_order_id;
$$;
revoke all on function private.payments_order_json(uuid) from public, anon, authenticated;
grant execute on function private.payments_order_json(uuid) to service_role;
comment on function private.payments_order_json(uuid) is
  'The JSON snapshot of a goods order the order writers answer: every column of public.orders (timestamps ISO text, øre JSON numbers, nulls JSON null) plus lines: [order_items rows without order_id, by line_no]; NULL when there is no such order.';

create or replace function private.payments_order_withdrawal_json(p_withdrawal_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select to_jsonb(w) from public.order_withdrawals w where w.id = p_withdrawal_id;
$$;
revoke all on function private.payments_order_withdrawal_json(uuid) from public, anon, authenticated;
grant execute on function private.payments_order_withdrawal_json(uuid) to service_role;
comment on function private.payments_order_withdrawal_json(uuid) is
  'The JSON snapshot of a goods withdrawal the order writers answer: every column of public.order_withdrawals, late included (timestamps ISO text, øre JSON numbers, nulls JSON null); NULL when there is no such withdrawal.';

-- The writers call the public-item visibility helper too (anon and authenticated already may).
grant execute on function private.item_is_public(uuid) to service_role;

-- payments_goods_offer -----------------------------------------------------------------------------
-- The item's title in p_locale (else Danish); the URL slugs in the URL slug locale, English
-- (URL_SLUG_LOCALE in src/config/catalog.ts: the English route and item slugs are the address on
-- every locale), else Danish.
create or replace function public.payments_goods_offer(p_item_id uuid, p_locale text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_price   bigint;
  v_cat     uuid;
  v_title   text;
  v_section text;
  v_slug    text;
begin
  if p_item_id is null or p_locale is null or p_locale not in ('da', 'en') then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  select f.price_ore, i.category_id into v_price, v_cat
    from public.items i
    join public.categories c on c.id = i.category_id
    join public.item_offers f on f.item_id = i.id and f.kind = 'physical' and f.active
   where i.id = p_item_id
     and i.status = 'published'
     and c.status = 'published'
     and c.kind = 'models3d'
     and private.item_is_public(i.id);
  if not found then
    return null;
  end if;
  v_title := coalesce(
    (select nullif(btrim(t.title), '') from public.item_translations t where t.item_id = p_item_id and t.locale = p_locale::public.locale_code),
    (select nullif(btrim(t.title), '') from public.item_translations t where t.item_id = p_item_id and t.locale = 'da'));
  v_section := coalesce(
    (select r.slug from public.routes r where r.category_id = v_cat and r.locale = 'en'),
    (select r.slug from public.routes r where r.category_id = v_cat and r.locale = 'da'));
  v_slug := coalesce(
    (select t.slug from public.item_translations t where t.item_id = p_item_id and t.locale = 'en'),
    (select t.slug from public.item_translations t where t.item_id = p_item_id and t.locale = 'da'));
  -- Without a title or an address there is nothing Checkout can show or return to.
  if v_title is null or v_section is null or v_slug is null then
    return null;
  end if;
  return jsonb_build_object('item_id', p_item_id, 'price_ore', v_price, 'title', v_title,
                            'section_slug', v_section, 'item_slug', v_slug, 'locale', p_locale);
end;
$$;
revoke all on function public.payments_goods_offer(uuid, text) from public, anon, authenticated;
grant execute on function public.payments_goods_offer(uuid, text) to service_role;
comment on function public.payments_goods_offer(uuid, text) is
  'Payments Worker (service_role only): the purchasable snapshot of an item, or NULL: the item and its section are published, the section is models3d, private.item_is_public holds and the item has an active physical offer. Returns {item_id, price_ore, title (in p_locale, else Danish), section_slug and item_slug (the English URL slugs, else Danish), locale}; NULL also without a title or slugs. 22023 invalid_payload for a NULL id or a p_locale other than da|en.';

-- payments_record_order ----------------------------------------------------------------------------
-- p_event = {id evt_…, type checkout.session.completed|checkout.session.async_payment_succeeded,
-- created (ISO timestamp), livemode}; p_order = GoodsOrderInput (src/lib/payments/orders/session.ts),
-- every key present: {stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
-- stripe_invoice_id, user_id, email, customer_name, phone, shipping_name, shipping_address,
-- locale, currency, amount_subtotal_ore, amount_tax_ore, amount_total_ore, terms_version,
-- terms_sha256, stripe_consent, anomaly, paid_at, capture_state, authorization_expires_at,
-- lines: [{line_no, item_id, offer_kind, title, quantity, unit_amount_ore, amount_total_ore,
-- amount_tax_ore}]}. capture_state is the payment intent's state the Worker read:
-- requires_capture (the normal case: authorized, charged at dispatch) or succeeded (captured at
-- Checkout already: recorded authorized with captured_at = paid_at and the captured_at_checkout
-- anomaly). The column CHECKs do the rest.
create or replace function public.payments_record_order(p_event jsonb, p_order jsonb) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_line     jsonb;
  v_user     uuid;
  v_id       uuid;
  v_number   bigint;
  v_captured boolean;
  v_anomaly  text;
begin
  if jsonb_typeof(p_event -> 'id') is distinct from 'string'
     or (p_event ->> 'id') !~ '^evt_[A-Za-z0-9]+$'
     or jsonb_typeof(p_event -> 'type') is distinct from 'string'
     or (p_event ->> 'type') not in ('checkout.session.completed', 'checkout.session.async_payment_succeeded')
     or jsonb_typeof(p_event -> 'livemode') is distinct from 'boolean'
     or jsonb_typeof(p_event -> 'created') is distinct from 'string'
     or not private.payments_valid_timestamptz(p_event ->> 'created')
     or jsonb_typeof(p_order) is distinct from 'object'
     or jsonb_typeof(p_order -> 'stripe_checkout_session_id') is distinct from 'string'
     or jsonb_typeof(p_order -> 'stripe_payment_intent_id') is distinct from 'string'
     or coalesce(jsonb_typeof(p_order -> 'stripe_customer_id'), 'missing') not in ('null', 'string')
     or coalesce(jsonb_typeof(p_order -> 'stripe_invoice_id'), 'missing') not in ('null', 'string')
     or coalesce(jsonb_typeof(p_order -> 'user_id'), 'missing') not in ('null', 'string')
     or (jsonb_typeof(p_order -> 'user_id') = 'string' and not pg_input_is_valid(p_order ->> 'user_id', 'uuid'))
     or jsonb_typeof(p_order -> 'email') is distinct from 'string'
     or coalesce(jsonb_typeof(p_order -> 'customer_name'), 'missing') not in ('null', 'string')
     or coalesce(jsonb_typeof(p_order -> 'phone'), 'missing') not in ('null', 'string')
     or coalesce(jsonb_typeof(p_order -> 'shipping_name'), 'missing') not in ('null', 'string')
     or coalesce(jsonb_typeof(p_order -> 'shipping_address'), 'missing') not in ('null', 'object')
     or (p_order ->> 'locale') is null or (p_order ->> 'locale') not in ('da', 'en')
     or jsonb_typeof(p_order -> 'currency') is distinct from 'string'
     or jsonb_typeof(p_order -> 'amount_subtotal_ore') is distinct from 'number'
     or jsonb_typeof(p_order -> 'amount_tax_ore') is distinct from 'number'
     or jsonb_typeof(p_order -> 'amount_total_ore') is distinct from 'number'
     or jsonb_typeof(p_order -> 'terms_version') is distinct from 'string'
     or coalesce(jsonb_typeof(p_order -> 'terms_sha256'), 'missing') not in ('null', 'string')
     or coalesce(jsonb_typeof(p_order -> 'stripe_consent'), 'missing') not in ('null', 'string')
     or coalesce(jsonb_typeof(p_order -> 'anomaly'), 'missing') not in ('null', 'string')
     or jsonb_typeof(p_order -> 'paid_at') is distinct from 'string'
     or not private.payments_valid_timestamptz(p_order ->> 'paid_at')
     or jsonb_typeof(p_order -> 'capture_state') is distinct from 'string'
     or (p_order ->> 'capture_state') not in ('requires_capture', 'succeeded')
     or coalesce(jsonb_typeof(p_order -> 'authorization_expires_at'), 'missing') not in ('null', 'string')
     or (jsonb_typeof(p_order -> 'authorization_expires_at') = 'string'
         and not private.payments_valid_timestamptz(p_order ->> 'authorization_expires_at'))
     or jsonb_typeof(p_order -> 'lines') is distinct from 'array'
     or jsonb_array_length(p_order -> 'lines') not between 1 and 10 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  -- The amounts are JSON numbers here: whole and within bigint (the CHECKs bound their sign).
  if (p_order -> 'amount_subtotal_ore')::numeric <> trunc((p_order -> 'amount_subtotal_ore')::numeric)
     or abs((p_order -> 'amount_subtotal_ore')::numeric) > 9223372036854775807
     or (p_order -> 'amount_tax_ore')::numeric <> trunc((p_order -> 'amount_tax_ore')::numeric)
     or abs((p_order -> 'amount_tax_ore')::numeric) > 9223372036854775807
     or (p_order -> 'amount_total_ore')::numeric <> trunc((p_order -> 'amount_total_ore')::numeric)
     or abs((p_order -> 'amount_total_ore')::numeric) > 9223372036854775807 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  for v_line in select value from jsonb_array_elements(p_order -> 'lines')
  loop
    if jsonb_typeof(v_line) is distinct from 'object'
       or jsonb_typeof(v_line -> 'line_no') is distinct from 'number'
       or coalesce(jsonb_typeof(v_line -> 'item_id'), 'missing') not in ('null', 'string')
       or (jsonb_typeof(v_line -> 'item_id') = 'string' and not pg_input_is_valid(v_line ->> 'item_id', 'uuid'))
       or jsonb_typeof(v_line -> 'offer_kind') is distinct from 'string'
       or jsonb_typeof(v_line -> 'title') is distinct from 'string'
       or jsonb_typeof(v_line -> 'quantity') is distinct from 'number'
       or jsonb_typeof(v_line -> 'unit_amount_ore') is distinct from 'number'
       or jsonb_typeof(v_line -> 'amount_total_ore') is distinct from 'number'
       or jsonb_typeof(v_line -> 'amount_tax_ore') is distinct from 'number' then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
    if (v_line -> 'line_no')::numeric not between 1 and 32767
       or (v_line -> 'line_no')::numeric <> trunc((v_line -> 'line_no')::numeric)
       or (v_line -> 'quantity')::numeric <> trunc((v_line -> 'quantity')::numeric)
       or abs((v_line -> 'quantity')::numeric) > 2147483647
       or (v_line -> 'unit_amount_ore')::numeric <> trunc((v_line -> 'unit_amount_ore')::numeric)
       or abs((v_line -> 'unit_amount_ore')::numeric) > 9223372036854775807
       or (v_line -> 'amount_total_ore')::numeric <> trunc((v_line -> 'amount_total_ore')::numeric)
       or abs((v_line -> 'amount_total_ore')::numeric) > 9223372036854775807
       or (v_line -> 'amount_tax_ore')::numeric <> trunc((v_line -> 'amount_tax_ore')::numeric)
       or abs((v_line -> 'amount_tax_ore')::numeric) > 9223372036854775807 then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
  end loop;

  insert into public.stripe_events (id, type, livemode, processed_at)
  values (p_event ->> 'id', p_event ->> 'type', (p_event ->> 'livemode')::boolean, now())
  on conflict (id) do nothing;
  if not found then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  -- A session completes once, but async_payment_succeeded may follow completed, or a replay may
  -- carry a new event id: the first wins. Checked before the insert, which would take the next
  -- order_number (the invoice number) even when its ON CONFLICT then skips the row.
  if exists (select 1 from public.orders o
              where o.stripe_checkout_session_id = p_order ->> 'stripe_checkout_session_id') then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  -- The buyer only while the account has a profile (deleted since Checkout: a guest order).
  if exists (select 1 from public.profiles p where p.user_id = (p_order ->> 'user_id')::uuid) then
    v_user := (p_order ->> 'user_id')::uuid;
  end if;

  -- Captured at Checkout (should not happen with manual capture): the money moved at paid_at; the
  -- owner sees the captured_at_checkout anomaly and "Markér afsendt" captures nothing more.
  v_captured := (p_order ->> 'capture_state') = 'succeeded';
  v_anomaly := p_order ->> 'anomaly';
  if v_captured and not coalesce('captured_at_checkout' = any (string_to_array(v_anomaly, ',')), false) then
    v_anomaly := concat_ws(',', v_anomaly, 'captured_at_checkout');
  end if;

  -- Two deliveries of one session at the same time both pass the check above: the second insert
  -- skips its row (and its order_number is lost).
  insert into public.orders
    (user_id, email, customer_name, phone, shipping_name, shipping_address, locale, currency,
     amount_subtotal_ore, amount_tax_ore, amount_total_ore, stripe_checkout_session_id,
     stripe_payment_intent_id, stripe_customer_id, stripe_invoice_id, terms_version, terms_sha256,
     stripe_consent, anomaly, paid_at, status, authorization_expires_at, captured_at)
  values (v_user, p_order ->> 'email', p_order ->> 'customer_name', p_order ->> 'phone',
          p_order ->> 'shipping_name', nullif(p_order -> 'shipping_address', 'null'::jsonb),
          (p_order ->> 'locale')::public.locale_code, p_order ->> 'currency',
          (p_order -> 'amount_subtotal_ore')::numeric::bigint, (p_order -> 'amount_tax_ore')::numeric::bigint,
          (p_order -> 'amount_total_ore')::numeric::bigint, p_order ->> 'stripe_checkout_session_id',
          p_order ->> 'stripe_payment_intent_id', p_order ->> 'stripe_customer_id',
          p_order ->> 'stripe_invoice_id', p_order ->> 'terms_version', p_order ->> 'terms_sha256',
          p_order ->> 'stripe_consent', v_anomaly, (p_order ->> 'paid_at')::timestamptz, 'authorized',
          case when not v_captured then (p_order ->> 'authorization_expires_at')::timestamptz end,
          case when v_captured then (p_order ->> 'paid_at')::timestamptz end)
  on conflict (stripe_checkout_session_id) do nothing
  returning id, order_number into v_id, v_number;
  if not found then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  -- An item deleted since Checkout is kept as the snapshot only (item_id NULL).
  insert into public.order_items
    (order_id, line_no, item_id, offer_kind, title, quantity, unit_amount_ore, amount_total_ore, amount_tax_ore)
  select v_id, (l.value -> 'line_no')::numeric::smallint,
         (select i.id from public.items i where i.id = (l.value ->> 'item_id')::uuid),
         l.value ->> 'offer_kind', l.value ->> 'title', (l.value -> 'quantity')::numeric::integer,
         (l.value -> 'unit_amount_ore')::numeric::bigint, (l.value -> 'amount_total_ore')::numeric::bigint,
         (l.value -> 'amount_tax_ore')::numeric::bigint
    from jsonb_array_elements(p_order -> 'lines') l;

  return jsonb_build_object('outcome', 'recorded', 'order_id', v_id, 'order_number', v_number);
end;
$$;
revoke all on function public.payments_record_order(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.payments_record_order(jsonb, jsonb) to service_role;
comment on function public.payments_record_order(jsonb, jsonb) is
  'Payments Worker (service_role only): records an authorized goods Checkout Session in one transaction. p_event = {id evt_…, type checkout.session.completed|checkout.session.async_payment_succeeded, created ISO timestamp, livemode}; p_order = GoodsOrderInput (every key present with its JSON type, whole øre amounts, capture_state requires_capture|succeeded, authorization_expires_at NULL or an ISO timestamp, 1 to 10 lines; 22023 invalid_payload otherwise; the column CHECKs raise 23514). An event id seen before: {"outcome": "duplicate"}, nothing else written. A session id already recorded (async_payment_succeeded after completed, or a replay under a new event id): the event is recorded, {"outcome": "duplicate"}, found before the order insert so no order_number is taken (only two deliveries of one session at the same moment can still lose one to the insert''s ON CONFLICT). Else inserts the order with status authorized (user_id only while that account has a profile, else a guest order): capture_state requires_capture stores authorization_expires_at as given (NULL for a method without one) and leaves captured_at NULL; succeeded (captured at Checkout) sets captured_at = paid_at, authorization_expires_at NULL and adds the captured_at_checkout anomaly. Then its lines (item_id NULL when the item no longer exists); returns {"outcome": "recorded", "order_id", "order_number"}.';

-- payments_order_mail_sent -------------------------------------------------------------------------
create or replace function public.payments_order_mail_sent(p_order_id uuid, p_kind text, p_email_id text)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_order public.orders%rowtype;
begin
  if p_order_id is null or p_kind is null
     or p_kind not in ('confirmation', 'owner', 'capture_warning', 'expired_alert', 'shipped', 'failed')
     or (p_kind <> 'failed' and (p_email_id is null or char_length(p_email_id) not between 1 and 200)) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  if p_kind = 'failed' then
    update public.orders o set mail_attempts = o.mail_attempts + 1, updated_at = now() where o.id = p_order_id;
    return jsonb_build_object('outcome', 'counted');
  end if;
  if p_kind = 'confirmation' and v_order.confirmation_sent_at is null then
    update public.orders o
       set confirmation_sent_at = now(), confirmation_email_id = p_email_id, updated_at = now()
     where o.id = p_order_id;
    return jsonb_build_object('outcome', 'stamped');
  end if;
  if p_kind = 'owner' and v_order.owner_notified_at is null then
    update public.orders o
       set owner_notified_at = now(), owner_email_id = p_email_id, updated_at = now()
     where o.id = p_order_id;
    return jsonb_build_object('outcome', 'stamped');
  end if;
  if p_kind = 'capture_warning' and v_order.capture_warning_sent_at is null then
    update public.orders o
       set capture_warning_sent_at = now(), capture_warning_email_id = p_email_id, updated_at = now()
     where o.id = p_order_id;
    return jsonb_build_object('outcome', 'stamped');
  end if;
  if p_kind = 'expired_alert' and v_order.expired_alert_sent_at is null then
    update public.orders o
       set expired_alert_sent_at = now(), expired_alert_email_id = p_email_id, updated_at = now()
     where o.id = p_order_id;
    return jsonb_build_object('outcome', 'stamped');
  end if;
  if p_kind = 'shipped' then
    if v_order.shipped_at is null then
      raise exception 'order_not_shipped' using errcode = 'P0001';
    end if;
    if v_order.shipped_email_sent_at is null then
      update public.orders o
         set shipped_email_sent_at = now(), shipped_email_id = p_email_id, updated_at = now()
       where o.id = p_order_id;
      return jsonb_build_object('outcome', 'stamped');
    end if;
  end if;
  return jsonb_build_object('outcome', 'already');
end;
$$;
revoke all on function public.payments_order_mail_sent(uuid, text, text) from public, anon, authenticated;
grant execute on function public.payments_order_mail_sent(uuid, text, text) to service_role;
comment on function public.payments_order_mail_sent(uuid, text, text) is
  'Payments Worker (service_role only): records an order email. p_kind confirmation | owner | capture_warning | expired_alert | shipped stamps confirmation_sent_at, owner_notified_at, capture_warning_sent_at, expired_alert_sent_at or shipped_email_sent_at = now() with p_email_id (1 to 200 characters) once: the first stamp wins ({"outcome": "stamped"}, later {"outcome": "already"}); shipped needs a shipped order (P0001 order_not_shipped). p_kind failed adds 1 to mail_attempts ({"outcome": "counted"}; p_email_id ignored). Locks the order row; P0002 order_not_found; 22023 invalid_payload for a malformed argument.';

-- Markér afsendt: payments_order_begin_ship, then (the Worker captures the payment at Stripe)
-- payments_order_captured, or payments_order_capture_failed when Stripe refuses the capture. ------
create or replace function public.payments_order_begin_ship(p_order_id uuid, p_actor uuid, p_tracking_ref text default null)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_order public.orders%rowtype;
begin
  if p_order_id is null or p_actor is null or char_length(btrim(p_tracking_ref)) > 200 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles p where p.user_id = p_actor and p.role in ('owner', 'admin')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if v_order.status in ('refunded', 'canceled') then
    raise exception 'order_closed' using errcode = 'P0001';
  end if;
  if v_order.status = 'shipped' then
    return jsonb_build_object('outcome', 'already_shipped', 'order', private.payments_order_json(p_order_id));
  end if;
  -- Never ship goods the consumer has withdrawn from (received, approved, or awaiting manual handling).
  if exists (select 1 from public.order_withdrawals w
              where w.order_id = p_order_id and w.status in ('received', 'approved', 'needs_manual')) then
    raise exception 'withdrawal_pending' using errcode = 'P0001';
  end if;
  update public.orders o
     set tracking_ref = nullif(btrim(p_tracking_ref), ''), updated_at = now()
   where o.id = p_order_id;
  return jsonb_build_object('outcome', 'capture', 'order', private.payments_order_json(p_order_id));
end;
$$;
revoke all on function public.payments_order_begin_ship(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.payments_order_begin_ship(uuid, uuid, text) to service_role;
comment on function public.payments_order_begin_ship(uuid, uuid, text) is
  'Payments Worker (service_role only): the first step of "Markér afsendt" for p_actor (verified by the Worker from the access token; its profiles.role must be owner or admin, else 42501 forbidden). Locks the order row; P0002 order_not_found. Refunded or canceled: P0001 order_closed. Already shipped: {"outcome": "already_shipped", "order"} (nothing changed). A withdrawal received, approved or needing manual handling: P0001 withdrawal_pending. Else stores tracking_ref = p_tracking_ref trimmed (empty or NULL -> NULL; over 200 characters -> 22023 invalid_payload) and returns {"outcome": "capture", "order": private.payments_order_json}: the Worker captures the payment intent (unless captured_at is already set), then calls payments_order_captured, or payments_order_capture_failed when Stripe refuses.';

create or replace function public.payments_order_captured(p_order_id uuid, p_actor uuid)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_order public.orders%rowtype;
begin
  if p_order_id is null or p_actor is null then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles p where p.user_id = p_actor and p.role in ('owner', 'admin')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if v_order.status = 'shipped' then
    return jsonb_build_object('outcome', 'already_shipped', 'order', private.payments_order_json(p_order_id));
  end if;
  if v_order.status <> 'authorized' then
    raise exception 'order_closed' using errcode = 'P0001';
  end if;
  -- The money moved at Stripe: recorded even if a withdrawal arrived during the capture call.
  update public.orders o
     set captured_at = coalesce(o.captured_at, now()), status = 'shipped', shipped_at = now(),
         shipped_by = p_actor, updated_at = now()
   where o.id = p_order_id;
  return jsonb_build_object('outcome', 'shipped', 'order', private.payments_order_json(p_order_id));
end;
$$;
revoke all on function public.payments_order_captured(uuid, uuid) from public, anon, authenticated;
grant execute on function public.payments_order_captured(uuid, uuid) to service_role;
comment on function public.payments_order_captured(uuid, uuid) is
  'Payments Worker (service_role only): the payment of an authorized order was captured (or was captured at Checkout already) and the goods are dispatched, for p_actor (profiles.role owner or admin, else 42501 forbidden). Locks the order row; P0002 order_not_found. Authorized: captured_at = now() unless already set (the first capture wins), status shipped, shipped_at = now(), shipped_by = p_actor; returns {"outcome": "shipped", "order": private.payments_order_json} (then the shipped email). Already shipped: {"outcome": "already_shipped", "order"} (nothing changed). Refunded or canceled: P0001 order_closed. 22023 invalid_payload for a NULL argument.';

create or replace function public.payments_order_capture_failed(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_order public.orders%rowtype;
begin
  if p_order_id is null or p_reason is null or p_reason !~ '^[a-z_]{1,64}$' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if p_reason = 'authorization_expired' and v_order.status = 'authorized' and v_order.captured_at is null then
    update public.orders o
       set status = 'canceled', canceled_at = now(), cancel_reason = 'authorization_expired', updated_at = now()
     where o.id = p_order_id;
    return jsonb_build_object('outcome', 'canceled', 'order', private.payments_order_json(p_order_id));
  end if;
  if p_reason = 'authorization_expired' and v_order.status = 'canceled' then
    return jsonb_build_object('outcome', 'canceled', 'order', private.payments_order_json(p_order_id));
  end if;
  -- Refused for another reason (a decline) while the payment intent is not canceled: the order stays
  -- authorized and unshipped, flagged once for the owner, who is told not to send the goods.
  if p_reason = 'capture_refused' and v_order.status = 'authorized' and v_order.captured_at is null
     and not coalesce('capture_failed' = any (string_to_array(v_order.anomaly, ',')), false) then
    update public.orders o
       set anomaly = concat_ws(',', o.anomaly, 'capture_failed'), updated_at = now()
     where o.id = p_order_id;
  end if;
  return jsonb_build_object('outcome', 'unchanged', 'order', private.payments_order_json(p_order_id));
end;
$$;
revoke all on function public.payments_order_capture_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.payments_order_capture_failed(uuid, text) to service_role;
comment on function public.payments_order_capture_failed(uuid, text) is
  'Payments Worker (service_role only): Stripe refused to capture an order''s payment. p_reason (^[a-z_]{1,64}$, else 22023 invalid_payload) authorization_expired (the payment intent is canceled or its authorization lapsed): an authorized, uncaptured order becomes canceled (canceled_at = now(), cancel_reason authorization_expired) and the answer is {"outcome": "canceled", "order"}, also when it was canceled already; do not send the goods. capture_refused (Stripe refused the capture for another reason, e.g. a decline, and the payment intent is not canceled): an authorized, uncaptured order stays authorized and unshipped and gains the anomaly capture_failed (once); the answer is {"outcome": "unchanged", "order"}; do not send the goods before it is resolved. Any other reason or state: nothing changes, {"outcome": "unchanged", "order"}. Locks the order row; P0002 order_not_found.';

-- payments_find_order ------------------------------------------------------------------------------
create or replace function public.payments_find_order(p_order_number bigint, p_email text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('order_id', (
    select o.id from public.orders o
     where o.order_number = p_order_number and lower(o.email) = lower(btrim(p_email))));
$$;
revoke all on function public.payments_find_order(bigint, text) from public, anon, authenticated;
grant execute on function public.payments_find_order(bigint, text) to service_role;
comment on function public.payments_find_order(bigint, text) is
  'Payments Worker (service_role only): the order a withdrawal form names: {"order_id": id} when p_order_number matches and the order''s email equals p_email (trimmed, case-insensitive), else {"order_id": null}: the same answer for an unknown number, a wrong email and NULL arguments.';

-- payments_begin_order_withdrawal ------------------------------------------------------------------
-- A notice by the personal link or the order number + email form: no account is involved, so the
-- withdrawal's user_id stays NULL.
create or replace function public.payments_begin_order_withdrawal(
  p_order_id uuid, p_consumer_name text, p_channel text, p_statement_version text, p_locale text)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_id    uuid;
begin
  if p_order_id is null
     or p_consumer_name is null or char_length(btrim(p_consumer_name)) not between 1 and 200
     or p_consumer_name ~ '[[:cntrl:]]'
     or p_channel is null or p_channel not in ('link', 'form')
     or p_statement_version is null or char_length(p_statement_version) not between 1 and 64
     or p_locale is null or p_locale not in ('da', 'en') then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  -- Lock order: the order row first, so concurrent notices for it queue up.
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  -- A withdrawal already recorded is answered first, whatever the order's status: a repeated
  -- notice after the refund or the release is "received" again, not refused (amendment A3-2).
  select w.id into v_id from public.order_withdrawals w where w.order_id = p_order_id;
  if found then
    return jsonb_build_object('outcome', 'existing',
                              'withdrawal', private.payments_order_withdrawal_json(v_id),
                              'order', private.payments_order_json(p_order_id));
  end if;
  -- Refunded, or canceled (the authorization was released or lapsed): the contract is over.
  if v_order.status in ('refunded', 'canceled') then
    return jsonb_build_object('outcome', 'not_withdrawable');
  end if;
  -- Never refused for lateness: a late notice is recorded with late = true for the owner.
  insert into public.order_withdrawals
    (order_id, consumer_name, channel, statement_version, locale, shipped_before_notice,
     deadline_at, refund_due_at)
  values (p_order_id, btrim(p_consumer_name), p_channel, p_statement_version,
          p_locale::public.locale_code, v_order.shipped_at is not null,
          private.order_withdrawal_deadline(v_order.shipped_at, v_order.confirmation_sent_at),
          now() + interval '14 days')
  returning id into v_id;
  return jsonb_build_object('outcome', 'created',
                            'withdrawal', private.payments_order_withdrawal_json(v_id),
                            'order', private.payments_order_json(p_order_id));
end;
$$;
revoke all on function public.payments_begin_order_withdrawal(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.payments_begin_order_withdrawal(uuid, text, text, text, text) to service_role;
comment on function public.payments_begin_order_withdrawal(uuid, text, text, text, text) is
  'Payments Worker (service_role only): records a goods withdrawal notice for an order the Worker identified (personal link token or order number + email; no account, so user_id stays NULL), with the consumer''s name (1 to 200 characters trimmed, no control character), the channel link|form, the statement''s text version (1 to 64 characters) and locale da|en; 22023 invalid_payload otherwise. Locks the order row first; P0002 order_not_found. A withdrawal already recorded (whatever the order''s status, so a repeated notice after the refund or the release is answered too): {"outcome": "existing", "withdrawal", "order"}. Else a refunded or canceled order: {"outcome": "not_withdrawable"}. Else inserts it (requested_at = now(), shipped_before_notice = shipped_at is set, deadline_at = private.order_withdrawal_deadline(shipped_at, confirmation_sent_at), refund_due_at = now() + 14 days; never refused for lateness: late is recorded) and returns {"outcome": "created", "withdrawal", "order"} (private.payments_order_withdrawal_json, private.payments_order_json).';

-- payments_approve_order_refund --------------------------------------------------------------------
create or replace function public.payments_approve_order_refund(
  p_order_id uuid, p_actor uuid, p_goods_state text, p_deduction_ore bigint, p_deduction_reason text default null)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_order  public.orders%rowtype;
  v_w      public.order_withdrawals%rowtype;
  v_action text;
  v_refund bigint;
  v_reason text := nullif(btrim(p_deduction_reason), '');
  v_id     uuid;
begin
  if p_order_id is null or p_actor is null
     or p_goods_state is null or p_goods_state not in ('returned', 'not_shipped')
     or p_deduction_ore is null or char_length(v_reason) > 500 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles p where p.user_id = p_actor and p.role in ('owner', 'admin')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if v_order.status = 'refunded' then
    raise exception 'order_refunded' using errcode = 'P0001';
  end if;
  select * into v_w from public.order_withdrawals w where w.order_id = p_order_id for update;
  if found and v_w.status in ('approved', 'completed', 'needs_manual') then
    return jsonb_build_object('outcome', 'already_approved',
                              'withdrawal', private.payments_order_withdrawal_json(v_w.id),
                              'order', private.payments_order_json(p_order_id));
  end if;
  if p_goods_state = 'not_shipped' and v_order.shipped_at is not null then
    raise exception 'order_shipped' using errcode = 'P0001';
  end if;
  if p_goods_state = 'returned' and v_order.shipped_at is null then
    raise exception 'order_not_shipped' using errcode = 'P0001';
  end if;
  -- Goods never shipped lost no value: nothing is deducted. Never captured: the authorization is
  -- released and nothing is refunded. Captured (shipped, or captured at Checkout): the refund is
  -- what is left after earlier refunds and the deduction.
  if p_goods_state = 'not_shipped' and p_deduction_ore <> 0 then
    raise exception 'deduction_invalid' using errcode = '22023';
  end if;
  if p_goods_state = 'not_shipped' and v_order.captured_at is null then
    v_action := 'cancel_authorization';
  else
    v_action := 'refund';
    v_refund := v_order.amount_total_ore - v_order.amount_refunded_ore - p_deduction_ore;
    if p_deduction_ore < 0 or v_refund < 1 then
      raise exception 'deduction_invalid' using errcode = '22023';
    end if;
    if p_deduction_ore > 0 and v_reason is null then
      raise exception 'deduction_reason_required' using errcode = '22023';
    end if;
  end if;

  if v_w.id is null then
    -- A notice the owner received outside the online function (email, letter): channel admin,
    -- which gets no online-withdrawal receipt and no owner alert (payments_pending_order_work).
    insert into public.order_withdrawals
      (order_id, user_id, consumer_name, channel, statement_version, locale, shipped_before_notice,
       deadline_at, refund_due_at)
    values (p_order_id, v_order.user_id,
            left(coalesce(nullif(btrim(v_order.shipping_name), ''), nullif(btrim(v_order.customer_name), ''), v_order.email), 200),
            'admin', 'admin', v_order.locale, v_order.shipped_at is not null,
            private.order_withdrawal_deadline(v_order.shipped_at, v_order.confirmation_sent_at),
            now() + interval '14 days')
    returning id into v_id;
  else
    v_id := v_w.id;
  end if;
  update public.order_withdrawals w
     set status = 'approved', goods_state = p_goods_state, action = v_action, approved_by = p_actor,
         approved_at = now(), deduction_ore = p_deduction_ore,
         deduction_reason = case when p_deduction_ore > 0 then v_reason end,
         refund_ore = v_refund, updated_at = now()
   where w.id = v_id;
  return jsonb_build_object('outcome', 'approved',
                            'withdrawal', private.payments_order_withdrawal_json(v_id),
                            'order', private.payments_order_json(p_order_id));
end;
$$;
revoke all on function public.payments_approve_order_refund(uuid, uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.payments_approve_order_refund(uuid, uuid, text, bigint, text) to service_role;
comment on function public.payments_approve_order_refund(uuid, uuid, text, bigint, text) is
  'Payments Worker (service_role only): the owner approves a withdrawn order''s refund or release for p_actor (profiles.role owner or admin, else 42501 forbidden). p_goods_state returned (the goods came back; only for a shipped order, else P0001 order_not_shipped) or not_shipped (never sent; only while shipped_at is NULL, else P0001 order_shipped; the deduction must be 0, else 22023 deduction_invalid). Locks the order row, then the withdrawal row; P0002 order_not_found; P0001 order_refunded. A withdrawal already approved, completed or needing manual handling: {"outcome": "already_approved", "withdrawal", "order"} (nothing changed). The action: not_shipped on an order never captured (authorized, or canceled after its authorization lapsed) -> cancel_authorization (the Worker releases the authorization; refund_ore NULL); otherwise -> refund with refund_ore = amount_total_ore - amount_refunded_ore - p_deduction_ore (22023 deduction_invalid when the deduction is negative or leaves less than 1 øre; 22023 deduction_reason_required for a deduction without a non-blank reason, at most 500 characters, else 22023 invalid_payload). Without a withdrawal (a notice received by email or letter) it creates one: channel admin, statement_version admin, the shipping name (else customer name, else email) as consumer_name, the order''s locale (no online-withdrawal receipt and no owner alert are sent for it: payments_pending_order_work). Sets status approved with goods_state, action, approved_by/at, the deduction and refund_ore; returns {"outcome": "approved", "withdrawal", "order"}.';

-- payments_claim_order_withdrawal ------------------------------------------------------------------
create or replace function public.payments_claim_order_withdrawal(p_withdrawal_id uuid, p_lease_seconds integer)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_order_id uuid;
  v_w        public.order_withdrawals%rowtype;
  v_claimed  boolean := false;
begin
  if p_withdrawal_id is null or p_lease_seconds is null or p_lease_seconds not between 1 and 600 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  select w.order_id into v_order_id from public.order_withdrawals w where w.id = p_withdrawal_id;
  if not found then
    raise exception 'withdrawal_not_found' using errcode = 'P0002';
  end if;
  perform 1 from public.orders o where o.id = v_order_id for update;
  select * into v_w from public.order_withdrawals w where w.id = p_withdrawal_id for update;
  if v_w.status = 'approved' and (v_w.lease_until is null or v_w.lease_until <= now()) then
    update public.order_withdrawals w
       set lease_until = now() + make_interval(secs => p_lease_seconds), attempts = w.attempts + 1, updated_at = now()
     where w.id = p_withdrawal_id;
    v_claimed := true;
  end if;
  return jsonb_build_object('claimed', v_claimed,
                            'withdrawal', private.payments_order_withdrawal_json(p_withdrawal_id),
                            'order', private.payments_order_json(v_order_id));
end;
$$;
revoke all on function public.payments_claim_order_withdrawal(uuid, integer) from public, anon, authenticated;
grant execute on function public.payments_claim_order_withdrawal(uuid, integer) to service_role;
comment on function public.payments_claim_order_withdrawal(uuid, integer) is
  'Payments Worker (service_role only): leases an approved goods withdrawal for its refund or release for p_lease_seconds (1 to 600; 22023 invalid_payload otherwise). Locks the order row, then the withdrawal row. Approved with no live lease: lease_until = now() + lease, attempts + 1, claimed true; otherwise claimed false and nothing changes. Returns {"claimed", "withdrawal": private.payments_order_withdrawal_json (action among its columns), "order": private.payments_order_json} (id, order_number, email, locale, status, amount_total_ore, amount_refunded_ore, captured_at, stripe_payment_intent_id among the order''s columns). P0002 withdrawal_not_found.';

-- payments_order_withdrawal_step -------------------------------------------------------------------
create or replace function public.payments_order_withdrawal_step(p_withdrawal_id uuid, p_step text, p_data jsonb)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_order_id uuid;
  v_order    public.orders%rowtype;
  v_w        public.order_withdrawals%rowtype;
  v_applied  boolean := false;
  v_tax      bigint;
begin
  if p_withdrawal_id is null or p_step is null
     or p_step not in ('ack_sent', 'owner_alerted', 'refunded', 'authorization_canceled', 'receipt_sent',
                       'reminder_sent', 'needs_manual', 'manual_alert_sent', 'attempt_failed', 'mail_failed')
     or jsonb_typeof(p_data) is distinct from 'object' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  -- The step's data, checked before any lock.
  if p_step in ('ack_sent', 'owner_alerted', 'receipt_sent', 'manual_alert_sent')
     and (jsonb_typeof(p_data -> 'email_id') is distinct from 'string'
          or char_length(p_data ->> 'email_id') not between 1 and 200) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  -- A Stripe refund only (no credit notes: amendment A1).
  if p_step = 'refunded' then
    if p_data ? 'credit_note_id'
       or jsonb_typeof(p_data -> 'refund_id') is distinct from 'string'
       or (p_data ->> 'refund_id') !~ '^re_[A-Za-z0-9]+$'
       or jsonb_typeof(p_data -> 'refund_tax_ore') is distinct from 'number' then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
    if (p_data -> 'refund_tax_ore')::numeric not between 0 and 9223372036854775807
       or (p_data -> 'refund_tax_ore')::numeric <> trunc((p_data -> 'refund_tax_ore')::numeric) then
      raise exception 'invalid_payload' using errcode = '22023';
    end if;
    v_tax := (p_data -> 'refund_tax_ore')::numeric::bigint;
  end if;
  if p_step = 'needs_manual'
     and (jsonb_typeof(p_data -> 'reason') is distinct from 'string' or (p_data ->> 'reason') !~ '^[a-z_]{1,64}$') then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if p_step = 'attempt_failed'
     and (jsonb_typeof(p_data -> 'error') is distinct from 'string' or char_length(p_data ->> 'error') not between 1 and 200) then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  select w.order_id into v_order_id from public.order_withdrawals w where w.id = p_withdrawal_id;
  if not found then
    raise exception 'withdrawal_not_found' using errcode = 'P0002';
  end if;
  -- Lock order: the order row, then the withdrawal row.
  select * into v_order from public.orders o where o.id = v_order_id for update;
  select * into v_w from public.order_withdrawals w where w.id = p_withdrawal_id for update;

  case p_step
  when 'ack_sent' then
    if v_w.ack_sent_at is null then
      update public.order_withdrawals w
         set ack_sent_at = now(), ack_email_id = p_data ->> 'email_id', updated_at = now()
       where w.id = p_withdrawal_id;
      v_applied := true;
    end if;

  when 'owner_alerted' then
    if v_w.owner_alerted_at is null then
      update public.order_withdrawals w
         set owner_alerted_at = now(), owner_alert_email_id = p_data ->> 'email_id', updated_at = now()
       where w.id = p_withdrawal_id;
      v_applied := true;
    end if;

  when 'refunded' then
    if v_w.status = 'completed' then
      -- A replay of the same refund is done already; any other is refused.
      if v_w.action is distinct from 'refund'
         or v_w.stripe_refund_id is distinct from (p_data ->> 'refund_id')
         or v_w.refund_tax_ore is distinct from v_tax then
        raise exception 'illegal_step' using errcode = 'P0001';
      end if;
    elsif v_w.status <> 'approved' or v_w.action is distinct from 'refund' or v_tax > v_w.refund_ore then
      raise exception 'illegal_step' using errcode = 'P0001';
    else
      update public.order_withdrawals w
         set status = 'completed', refunded_at = now(), stripe_refund_id = p_data ->> 'refund_id',
             refund_tax_ore = v_tax, lease_until = null, updated_at = now()
       where w.id = p_withdrawal_id;
      -- The order then holds everything refunded: what was refunded at approval plus this refund
      -- (total - deduction, since refund_ore = total - refunded - deduction then), never less than
      -- a charge.refunded sync already recorded (each refund also fires that event, so a sum would
      -- count it twice) and never more than the total.
      update public.orders o
         set amount_refunded_ore = least(o.amount_total_ore, greatest(o.amount_refunded_ore, o.amount_total_ore - v_w.deduction_ore)),
             status = 'refunded', updated_at = now()
       where o.id = v_order_id;
      v_applied := true;
    end if;

  when 'authorization_canceled' then
    if v_w.status = 'completed' and v_w.action = 'cancel_authorization' then
      null;   -- a replay: released already
    elsif v_w.status <> 'approved' or v_w.action is distinct from 'cancel_authorization'
          or v_order.captured_at is not null then
      raise exception 'illegal_step' using errcode = 'P0001';
    else
      update public.order_withdrawals w
         set status = 'completed', authorization_canceled_at = now(), lease_until = null, updated_at = now()
       where w.id = p_withdrawal_id;
      -- An order already canceled (its authorization lapsed first) keeps its reason.
      update public.orders o
         set status = 'canceled', canceled_at = now(), cancel_reason = 'withdrawn', updated_at = now()
       where o.id = v_order_id and o.status = 'authorized';
      v_applied := true;
    end if;

  when 'receipt_sent' then
    if v_w.status <> 'completed' then
      raise exception 'illegal_step' using errcode = 'P0001';
    end if;
    if v_w.receipt_sent_at is null then
      update public.order_withdrawals w
         set receipt_sent_at = now(), receipt_email_id = p_data ->> 'email_id', updated_at = now()
       where w.id = p_withdrawal_id;
      v_applied := true;
    end if;

  when 'reminder_sent' then
    if v_w.reminder_sent_at is null then
      update public.order_withdrawals w set reminder_sent_at = now(), updated_at = now() where w.id = p_withdrawal_id;
      v_applied := true;
    end if;

  when 'needs_manual' then
    if v_w.status = 'approved' then
      update public.order_withdrawals w
         set status = 'needs_manual', manual_reason = p_data ->> 'reason', lease_until = null, updated_at = now()
       where w.id = p_withdrawal_id;
      v_applied := true;
    elsif v_w.status <> 'needs_manual' then
      raise exception 'illegal_step' using errcode = 'P0001';
    end if;

  when 'manual_alert_sent' then
    -- The owner's manual-handling alert (amendment A3-3): only for a withdrawal awaiting it.
    if v_w.status <> 'needs_manual' then
      raise exception 'illegal_step' using errcode = 'P0001';
    end if;
    if v_w.manual_alert_sent_at is null then
      update public.order_withdrawals w
         set manual_alert_sent_at = now(), manual_alert_email_id = p_data ->> 'email_id', updated_at = now()
       where w.id = p_withdrawal_id;
      v_applied := true;
    end if;

  when 'attempt_failed' then
    update public.order_withdrawals w
       set last_error = p_data ->> 'error', lease_until = null, updated_at = now()
     where w.id = p_withdrawal_id;
    v_applied := true;

  when 'mail_failed' then
    update public.order_withdrawals w set mail_attempts = w.mail_attempts + 1, updated_at = now() where w.id = p_withdrawal_id;
    v_applied := true;
  end case;

  return jsonb_build_object('outcome', case when v_applied then 'applied' else 'already' end,
                            'withdrawal', private.payments_order_withdrawal_json(p_withdrawal_id));
end;
$$;
revoke all on function public.payments_order_withdrawal_step(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.payments_order_withdrawal_step(uuid, text, jsonb) to service_role;
comment on function public.payments_order_withdrawal_step(uuid, text, jsonb) is
  'Payments Worker (service_role only): records one step of a goods withdrawal and returns {"outcome": "applied" | "already", "withdrawal": private.payments_order_withdrawal_json}. Locks the order row, then the withdrawal row. Steps (p_data): ack_sent {email_id} and owner_alerted {email_id}: stamp the receipt / the owner alert once, any status. refunded {refund_id re_…, refund_tax_ore whole, at most refund_ore; a credit_note_id key is 22023 invalid_payload}: an approved refund -> completed, refunded_at = now(), lease released; the order''s amount_refunded_ore becomes total - deduction (never lower than already recorded, never above the total) and its status refunded; an identical replay on a completed row is already, any other P0001 illegal_step. authorization_canceled {}: an approved cancel_authorization on an uncaptured order -> completed, authorization_canceled_at = now(), lease released; an authorized order becomes canceled (canceled_at = now(), cancel_reason withdrawn), a canceled one keeps its reason; a replay on a completed release is already, any other P0001 illegal_step. receipt_sent {email_id}: stamps the refund or release receipt once, completed only. reminder_sent {}: stamps the owner reminder once. needs_manual {reason ^[a-z_]{1,64}$}: approved -> needs_manual with manual_reason, lease released; already when needs_manual. manual_alert_sent {email_id}: stamps the owner''s manual-handling alert once (manual_alert_sent_at, manual_alert_email_id), needs_manual only. attempt_failed {error, 1 to 200 characters}: last_error, lease released. mail_failed {}: mail_attempts + 1. Every first stamp wins; any other transition P0001 illegal_step; P0002 withdrawal_not_found; 22023 invalid_payload for a malformed argument.';

-- payments_pending_order_work ----------------------------------------------------------------------
create or replace function public.payments_pending_order_work(p_limit integer, p_max_mail_attempts integer) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 50
     or p_max_mail_attempts is null or p_max_mail_attempts not between 1 and 1000 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'orders_mail', coalesce((
      select jsonb_agg(jsonb_build_object('order_id', q.id, 'needs', to_jsonb(q.needs)) order by q.updated_at, q.id)
        from (select o.id, o.updated_at,
                     array_remove(array[
                       case when o.confirmation_sent_at is null then 'confirmation' end,
                       case when o.owner_notified_at is null then 'owner' end,
                       case when o.status = 'shipped' and o.shipped_email_sent_at is null then 'shipped' end,
                       -- The owner's "do not send the goods" alert of a lapsed authorization: retried
                       -- until stamped, so a failed send at the webhook is not lost.
                       case when o.status = 'canceled' and o.cancel_reason = 'authorization_expired'
                                 and o.expired_alert_sent_at is null then 'expired_alert' end], null) as needs
                from public.orders o
               where o.mail_attempts < p_max_mail_attempts
                 and (o.confirmation_sent_at is null or o.owner_notified_at is null
                      or (o.status = 'shipped' and o.shipped_email_sent_at is null)
                      or (o.status = 'canceled' and o.cancel_reason = 'authorization_expired'
                          and o.expired_alert_sent_at is null))
               -- The least recently touched first: a failed send moves an order to the back.
               order by o.updated_at, o.id
               limit p_limit) q), '[]'::jsonb),
    'withdrawals', coalesce((
      select jsonb_agg(jsonb_build_object('withdrawal_id', q.id, 'needs', to_jsonb(q.needs)) order by q.updated_at, q.id)
        from (select w.id, w.updated_at, n.needs
                from public.order_withdrawals w
               cross join lateral (
                 select array_remove(array[
                          -- An offline notice the owner recorded (channel admin, "Registrér
                          -- fortrydelse") gets neither the online-withdrawal receipt nor the
                          -- owner's "new withdrawal" alert (amendment A3-1).
                          case when w.mail_attempts < p_max_mail_attempts and w.channel <> 'admin'
                                    and w.ack_sent_at is null then 'ack' end,
                          case when w.mail_attempts < p_max_mail_attempts and w.channel <> 'admin'
                                    and w.owner_alerted_at is null then 'owner_alert' end,
                          -- WITHDRAWAL_MAX_ATTEMPTS (src/config/payments.ts): 8 passes over a refund.
                          case when w.status = 'approved' and (w.lease_until is null or w.lease_until <= now())
                                    and w.attempts < 8 then 'refund' end,
                          case when w.mail_attempts < p_max_mail_attempts and w.status = 'completed'
                                    and w.receipt_sent_at is null then 'receipt' end,
                          case when w.mail_attempts < p_max_mail_attempts and w.status = 'received'
                                    and w.reminder_sent_at is null and now() >= w.refund_due_at - interval '4 days'
                               then 'reminder' end,
                          -- The owner's manual-handling alert: retried until stamped (amendment A3-3).
                          case when w.mail_attempts < p_max_mail_attempts and w.status = 'needs_manual'
                                    and w.manual_alert_sent_at is null then 'manual_alert' end], null) as needs) n
               where cardinality(n.needs) > 0
               order by w.updated_at, w.id
               limit p_limit) q), '[]'::jsonb),
    -- ORDER_CAPTURE_WARNING_HOURS (src/config/payments.ts): the owner is warned once, 48 hours
    -- before an unshipped order's card authorization lapses (none while a withdrawal exists: that
    -- order is not to be sent). The soonest to lapse first.
    'orders_capture_warning', coalesce((
      select jsonb_agg(jsonb_build_object('order_id', q.id, 'needs', jsonb_build_array('capture_warning'))
                       order by q.authorization_expires_at, q.id)
        from (select o.id, o.authorization_expires_at
                from public.orders o
               where o.status = 'authorized' and o.captured_at is null
                 and o.authorization_expires_at > now()
                 and o.authorization_expires_at <= now() + interval '48 hours'
                 and o.capture_warning_sent_at is null
                 and o.mail_attempts < p_max_mail_attempts
                 and not exists (select 1 from public.order_withdrawals w where w.order_id = o.id)
               order by o.authorization_expires_at, o.id
               limit p_limit) q), '[]'::jsonb));
end;
$$;
revoke all on function public.payments_pending_order_work(integer, integer) from public, anon, authenticated;
grant execute on function public.payments_pending_order_work(integer, integer) to service_role;
comment on function public.payments_pending_order_work(integer, integer) is
  'Payments Worker sweep (service_role only): {"orders_mail": [{order_id, needs: [confirmation | owner | shipped | expired_alert]}], "withdrawals": [{withdrawal_id, needs: [ack | owner_alert | refund | receipt | reminder | manual_alert]}], "orders_capture_warning": [{order_id, needs: [capture_warning]}]}, at most p_limit (1 to 50) of each; 22023 invalid_payload for a p_limit or a p_max_mail_attempts (1 to 1000) out of range. Orders (least recently updated first): a missing confirmation (the invoice) or owner email, the shipped email of a shipped order, or the owner''s expired_alert of an order canceled because its authorization lapsed (cancel_reason authorization_expired, expired_alert_sent_at NULL), while mail_attempts < p_max_mail_attempts. Withdrawals (least recently updated first): the mail needs (ack and owner_alert, never for a channel admin notice the owner recorded; receipt once completed; reminder while received from refund_due_at - 4 days; manual_alert while needs_manual and manual_alert_sent_at is NULL) while mail_attempts < p_max_mail_attempts; refund (the refund or the release of the authorization) while approved with no live lease and attempts < 8 (WITHDRAWAL_MAX_ATTEMPTS). Capture warnings (soonest to lapse first): an authorized, uncaptured order without a withdrawal whose authorization_expires_at is in the next 48 hours (ORDER_CAPTURE_WARNING_HOURS), no warning stamped yet and mail_attempts < p_max_mail_attempts.';

-- payments_sync_order_refund -----------------------------------------------------------------------
create or replace function public.payments_sync_order_refund(p_event jsonb, p_payment_intent text, p_amount_refunded bigint)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_amount bigint;
  v_status text;
begin
  if jsonb_typeof(p_event -> 'id') is distinct from 'string'
     or (p_event ->> 'id') !~ '^evt_[A-Za-z0-9]+$'
     or jsonb_typeof(p_event -> 'type') is distinct from 'string'
     or jsonb_typeof(p_event -> 'livemode') is distinct from 'boolean'
     or jsonb_typeof(p_event -> 'created') is distinct from 'string'
     or not private.payments_valid_timestamptz(p_event ->> 'created')
     or p_payment_intent is null or p_payment_intent !~ '^pi_[A-Za-z0-9]+$'
     or p_amount_refunded is null or p_amount_refunded < 0 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  select * into v_order from public.orders o where o.stripe_payment_intent_id = p_payment_intent for update;
  if not found then
    -- Not a goods order (a subscription charge): nothing recorded, the event included.
    return jsonb_build_object('outcome', 'unknown_order');
  end if;
  insert into public.stripe_events (id, type, livemode, processed_at)
  values (p_event ->> 'id', p_event ->> 'type', (p_event ->> 'livemode')::boolean, now())
  on conflict (id) do nothing;
  if not found then
    return jsonb_build_object('outcome', 'duplicate');
  end if;
  -- Stripe's amount_refunded is cumulative: the larger one wins, so the amount never goes down. Only
  -- captured money is refunded: releasing an authorization (Stripe marks the charge refunded) moves
  -- nothing, so an uncaptured order keeps 0 and its status.
  if v_order.captured_at is null then
    v_amount := v_order.amount_refunded_ore;
  else
    v_amount := greatest(v_order.amount_refunded_ore, least(p_amount_refunded, v_order.amount_total_ore));
  end if;
  v_status := case when v_order.captured_at is not null and v_amount = v_order.amount_total_ore then 'refunded'
                   else v_order.status end;
  update public.orders o
     set amount_refunded_ore = v_amount, status = v_status, updated_at = now()
   where o.id = v_order.id;
  return jsonb_build_object('outcome', 'synced', 'order_id', v_order.id, 'amount_refunded_ore', v_amount, 'status', v_status);
end;
$$;
revoke all on function public.payments_sync_order_refund(jsonb, text, bigint) from public, anon, authenticated;
grant execute on function public.payments_sync_order_refund(jsonb, text, bigint) to service_role;
comment on function public.payments_sync_order_refund(jsonb, text, bigint) is
  'Payments Worker (service_role only): records a charge.refunded event on a goods order (p_event = {id evt_…, type, created ISO timestamp, livemode}; p_payment_intent pi_…; p_amount_refunded, Stripe''s cumulative amount, >= 0; 22023 invalid_payload otherwise). No order with that payment intent: {"outcome": "unknown_order"}, nothing recorded (a subscription charge). Locks the order row; an event id seen before: {"outcome": "duplicate"}. Else, bounded by the captured amount: a captured order''s amount_refunded_ore = the larger of the stored amount and p_amount_refunded capped at the total (never lowered), status refunded once that reaches the total; an uncaptured order (a released authorization) keeps amount_refunded_ore and status. Returns {"outcome": "synced", "order_id", "amount_refunded_ore", "status"}.';

-- payments_order_authorization_canceled ------------------------------------------------------------
create or replace function public.payments_order_authorization_canceled(p_event jsonb, p_payment_intent text)
returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_reason text;
begin
  if jsonb_typeof(p_event -> 'id') is distinct from 'string'
     or (p_event ->> 'id') !~ '^evt_[A-Za-z0-9]+$'
     or jsonb_typeof(p_event -> 'type') is distinct from 'string'
     or (p_event ->> 'type') <> 'payment_intent.canceled'
     or jsonb_typeof(p_event -> 'livemode') is distinct from 'boolean'
     or jsonb_typeof(p_event -> 'created') is distinct from 'string'
     or not private.payments_valid_timestamptz(p_event ->> 'created')
     or p_payment_intent is null or p_payment_intent !~ '^pi_[A-Za-z0-9]+$' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  select * into v_order from public.orders o where o.stripe_payment_intent_id = p_payment_intent for update;
  if not found then
    -- Not a goods order: nothing recorded, the event included.
    return jsonb_build_object('outcome', 'unknown_order');
  end if;
  insert into public.stripe_events (id, type, livemode, processed_at)
  values (p_event ->> 'id', p_event ->> 'type', (p_event ->> 'livemode')::boolean, now())
  on conflict (id) do nothing;
  if not found then
    return jsonb_build_object('outcome', 'duplicate');
  end if;
  if v_order.status <> 'authorized' or v_order.captured_at is not null then
    return jsonb_build_object('outcome', 'ignored', 'order_id', v_order.id);
  end if;
  -- The Worker's own release for a withdrawal also fires this event: then the reason is withdrawn.
  v_reason := case when exists (select 1 from public.order_withdrawals w
                                 where w.order_id = v_order.id and w.action = 'cancel_authorization')
                   then 'withdrawn' else 'authorization_expired' end;
  update public.orders o
     set status = 'canceled', canceled_at = now(), cancel_reason = v_reason, updated_at = now()
   where o.id = v_order.id;
  return jsonb_build_object('outcome', 'canceled', 'order', private.payments_order_json(v_order.id));
end;
$$;
revoke all on function public.payments_order_authorization_canceled(jsonb, text) from public, anon, authenticated;
grant execute on function public.payments_order_authorization_canceled(jsonb, text) to service_role;
comment on function public.payments_order_authorization_canceled(jsonb, text) is
  'Payments Worker (service_role only): records a payment_intent.canceled event (p_event = {id evt_…, type payment_intent.canceled, created ISO timestamp, livemode}; p_payment_intent pi_…; 22023 invalid_payload otherwise). No order with that payment intent: {"outcome": "unknown_order"}, nothing recorded. Locks the order row; an event id seen before: {"outcome": "duplicate"}. An authorized, uncaptured order becomes canceled (canceled_at = now(); cancel_reason withdrawn when its withdrawal was approved with action cancel_authorization, else authorization_expired: tell the owner not to send the goods) and the answer is {"outcome": "canceled", "order": private.payments_order_json}; any other order: the event is recorded, nothing changes, {"outcome": "ignored", "order_id"}.';

-- PostgREST serves the new tables and functions without waiting for its schema cache to expire.
notify pgrst, 'reload schema';
