-- Monitor Plus plans for the ISOLATED e2e Supabase project, with Stripe TEST-mode price ids.
--
-- Not a migration: this file lives outside supabase/migrations/ so `supabase db push --linked`
-- can never carry test-mode price ids to production. Apply it to the e2e project only, with the
-- ref-guarded SQL runner (refuses any connection but postgres.<e2e ref>): a dry run that applies
-- it twice in one rolled-back transaction and verifies, then `--commit`, then a rolled-back probe.
-- Production gets its own seed with the live price ids at go-live (the go-live runbook).
--
-- The price ids are the TEST-mode prices `node --env-file=.env.local scripts/stripe-setup.mjs`
-- prints: lookup_key monitor_plus_year and monitor_plus_month of product monitor_plus. Both
-- plans allow 20 monitors and are active; the yearly one sorts first. amount_ore is the display
-- price incl. moms (Stripe charges the price itself): 95 kr a year, 10 kr a month.
--
-- Re-runnable: plans upsert on stripe_price_id, names on (plan_id, locale).

with plans as (
  insert into public.monitor_plans as p
    (stripe_price_id, monitor_limit, billing_interval, amount_ore, active, sort_order)
  values
    ('price_1Ub3CoFIgZG2PjS1HuHKEvrB', 20, 'year', 9500, true, 1),
    ('price_1Ub3CoFIgZG2PjS1sJ7VtPSS', 20, 'month', 1000, true, 2)
  on conflict (stripe_price_id) do update
    set monitor_limit    = excluded.monitor_limit,
        billing_interval = excluded.billing_interval,
        amount_ore       = excluded.amount_ore,
        active           = excluded.active,
        sort_order       = excluded.sort_order
  returning p.id
)
insert into public.monitor_plan_translations (plan_id, locale, name)
select plans.id, names.locale, 'Monitor Plus'
  from plans
 cross join (values ('da'::public.locale_code), ('en'::public.locale_code)) as names (locale)
on conflict (plan_id, locale) do update set name = excluded.name;
