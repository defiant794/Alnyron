/**
 * Integration tests — payments table visibility (RLS), write-block, and
 * admin_delete_monitor_user extended with has_active_subscription guard
 * (PAY1-AC5, PAY1-AC6a–b).
 * Journey: payments-slice1-foundation
 *
 * Guard: e2e project only (SUPABASE_E2E_REF). Requires the payments foundation
 * migration (20261112000100_payments_foundation.sql) to be applied to the target.
 *
 * Run:
 *   npm run test:integration:e2e-project -- tests/integration/rls/rls-payments-visibility.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient, type PoolClient } from "./helpers/db.js";
import {
  ADMIN_CLAIMS,
  ANON_CLAIMS,
  asRole,
  expectPgError,
  seedAdmin,
  seedAuthUser,
  withTx,
  type JwtClaims,
} from "./helpers/roles.js";

// ── Fixture UUIDs/emails (prefix 0a36 = pay1-visibility) ─────────────────────

const USER_UUID   = "00000000-0000-0000-0a36-000000000002";
const USER_EMAIL  = "e2e-pay1-vis-user@alnyron-test.local";

const OTHER_UUID  = "00000000-0000-0000-0a36-000000000003";
const OTHER_EMAIL = "e2e-pay1-vis-other@alnyron-test.local";

const DEL_UUID    = "00000000-0000-0000-0a36-000000000004";
const DEL_EMAIL   = "e2e-pay1-vis-del@alnyron-test.local";

const USER_CLAIMS: JwtClaims = { sub: USER_UUID, role: "authenticated", email: USER_EMAIL };

const EVT_T1 = "2026-01-01T00:00:00Z";

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedPlan(
  c: PoolClient,
  priceId: string,
  active = true,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO public.monitor_plans
       (stripe_price_id, monitor_limit, billing_interval, amount_ore, active)
     VALUES ($1, 20, 'month', 1000, $2)
     RETURNING id`,
    [priceId, active],
  );
  return rows[0]!.id;
}

async function seedPlanTranslation(c: PoolClient, planId: string): Promise<void> {
  await c.query(
    `INSERT INTO public.monitor_plan_translations (plan_id, locale, name, description)
     VALUES ($1, 'da', 'Testplan', 'Beskrivelse')`,
    [planId],
  );
}

async function seedSubscription(
  c: PoolClient,
  subId: string,
  userId: string,
  planId: string,
  status: string,
): Promise<void> {
  await c.query(
    `INSERT INTO public.subscriptions
       (stripe_subscription_id, user_id, stripe_customer_id, plan_id, status, last_event_created)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
    [subId, userId, `cus_vis_${subId}`, planId, status, EVT_T1],
  );
}

async function seedBillingCustomer(c: PoolClient, userId: string, customerId: string): Promise<void> {
  await c.query(
    "INSERT INTO public.billing_customers (user_id, stripe_customer_id) VALUES ($1, $2)",
    [userId, customerId],
  );
}

async function seedInvoice(c: PoolClient, invoiceId: string, subId: string, userId: string): Promise<void> {
  await c.query(
    `INSERT INTO public.subscription_invoices
       (stripe_invoice_id, stripe_subscription_id, user_id, email, amount_total_ore, amount_tax_ore, paid_at)
     VALUES ($1, $2, $3, $4, 1000, 200, now())`,
    [invoiceId, subId, userId, USER_EMAIL],
  );
}

// ── describe ──────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.SUPABASE_E2E_REF)(
  "PAY1-AC5 — payments table visibility and write-block; PAY1-AC6 — admin delete guard",
  () => {
    let client: PoolClient;

    beforeAll(async () => {
      client = await getClient();
    });

    afterAll(async () => {
      client.release();
    });

    // ── PAY1-AC5a: anon sees only active monitor_plans ─────────────────────────

    it("PAY1-AC5a: anon sees active monitor_plans, not inactive ones", async () => {
      await withTx(client, async (c) => {
        await seedPlan(c, "price_vis_active_plan",   true);
        await seedPlan(c, "price_vis_inactive_plan", false);

        await asRole(c, "anon", ANON_CLAIMS);
        const { rows } = await c.query<{ stripe_price_id: string }>(
          "SELECT stripe_price_id FROM public.monitor_plans ORDER BY stripe_price_id",
        );
        const priceIds = rows.map((r) => r.stripe_price_id);
        expect(priceIds).toContain("price_vis_active_plan");
        expect(priceIds).not.toContain("price_vis_inactive_plan");
      });
    }, 15_000);

    it("PAY1-AC5a-auth: authenticated also sees only active monitor_plans", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await seedPlan(c, "price_vis_active_auth", true);
        await seedPlan(c, "price_vis_inactive_auth", false);

        await asRole(c, "authenticated", USER_CLAIMS);
        const { rows } = await c.query<{ stripe_price_id: string }>(
          "SELECT stripe_price_id FROM public.monitor_plans ORDER BY stripe_price_id",
        );
        const priceIds = rows.map((r) => r.stripe_price_id);
        expect(priceIds).toContain("price_vis_active_auth");
        expect(priceIds).not.toContain("price_vis_inactive_auth");
      });
    }, 15_000);

    // ── PAY1-AC5b: plan translations follow plan.active ───────────────────────

    it("PAY1-AC5b: anon sees translations for active plans, not inactive plans", async () => {
      await withTx(client, async (c) => {
        const activePlanId   = await seedPlan(c, "price_vis_tr_active",   true);
        const inactivePlanId = await seedPlan(c, "price_vis_tr_inactive", false);
        await seedPlanTranslation(c, activePlanId);
        await seedPlanTranslation(c, inactivePlanId);

        await asRole(c, "anon", ANON_CLAIMS);
        const { rows } = await c.query<{ plan_id: string }>(
          "SELECT plan_id FROM public.monitor_plan_translations",
        );
        const planIds = rows.map((r) => r.plan_id);
        expect(planIds).toContain(activePlanId);
        expect(planIds).not.toContain(inactivePlanId);
      });
    }, 15_000);

    // ── PAY1-AC5c/d: billing data own-only for authenticated, none for anon ───

    it("PAY1-AC5c: authenticated sees own billing_customers row", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await seedBillingCustomer(c, USER_UUID, "cus_vis_own");

        await asRole(c, "authenticated", USER_CLAIMS);
        const { rows } = await c.query<{ stripe_customer_id: string }>(
          "SELECT stripe_customer_id FROM public.billing_customers WHERE user_id = $1",
          [USER_UUID],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.stripe_customer_id).toBe("cus_vis_own");
      });
    }, 15_000);

    it("PAY1-AC5d: anon SELECT on billing_customers → refused (42501, no SELECT privilege)", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await seedBillingCustomer(c, USER_UUID, "cus_vis_anon_check");

        await asRole(c, "anon", ANON_CLAIMS);
        await expectPgError(
          c,
          () => c.query("SELECT 1 FROM public.billing_customers LIMIT 1"),
          "42501",
          "anon select billing_customers",
          { messageIncludes: "permission denied" },
        );
      });
    }, 15_000);

    it("PAY1-AC5e: authenticated sees no other user's billing_customers", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await seedAuthUser(c, OTHER_UUID, OTHER_EMAIL);
        await seedBillingCustomer(c, OTHER_UUID, "cus_vis_other");

        await asRole(c, "authenticated", USER_CLAIMS);
        const { rows } = await c.query<{ user_id: string }>(
          "SELECT user_id FROM public.billing_customers WHERE user_id = $1",
          [OTHER_UUID],
        );
        expect(rows).toHaveLength(0);
      });
    }, 15_000);

    it("PAY1-AC5c-subs: authenticated sees own subscriptions", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const planId = await seedPlan(c, "price_vis_sub_own");
        await seedSubscription(c, "sub_vis_own", USER_UUID, planId, "active");

        await asRole(c, "authenticated", USER_CLAIMS);
        const { rows } = await c.query<{ stripe_subscription_id: string }>(
          "SELECT stripe_subscription_id FROM public.subscriptions WHERE user_id = $1",
          [USER_UUID],
        );
        expect(rows).toHaveLength(1);
      });
    }, 15_000);

    it("PAY1-AC5d-subs: anon SELECT on subscriptions → refused (42501, no SELECT privilege)", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const planId = await seedPlan(c, "price_vis_sub_anon");
        await seedSubscription(c, "sub_vis_anon", USER_UUID, planId, "active");

        await asRole(c, "anon", ANON_CLAIMS);
        await expectPgError(
          c,
          () => c.query("SELECT 1 FROM public.subscriptions LIMIT 1"),
          "42501",
          "anon select subscriptions",
          { messageIncludes: "permission denied" },
        );
      });
    }, 15_000);

    it("PAY1-AC5d-inv: anon SELECT on subscription_invoices → refused (42501, no SELECT privilege)", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const planId = await seedPlan(c, "price_vis_inv_anon");
        await seedSubscription(c, "sub_vis_inv_anon", USER_UUID, planId, "active");
        await seedInvoice(c, "inv_vis_inv_anon", "sub_vis_inv_anon", USER_UUID);

        await asRole(c, "anon", ANON_CLAIMS);
        await expectPgError(
          c,
          () => c.query("SELECT 1 FROM public.subscription_invoices LIMIT 1"),
          "42501",
          "anon select subscription_invoices",
          { messageIncludes: "permission denied" },
        );
      });
    }, 15_000);

    it("PAY1-AC5e-subs: authenticated sees no other user's subscriptions", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await seedAuthUser(c, OTHER_UUID, OTHER_EMAIL);
        const planId = await seedPlan(c, "price_vis_sub_other");
        await seedSubscription(c, "sub_vis_other", OTHER_UUID, planId, "active");

        await asRole(c, "authenticated", USER_CLAIMS);
        const { rows } = await c.query<{ user_id: string }>(
          "SELECT user_id FROM public.subscriptions WHERE user_id = $1",
          [OTHER_UUID],
        );
        expect(rows).toHaveLength(0);
      });
    }, 15_000);

    it("PAY1-AC5c-inv: authenticated sees own subscription_invoices", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        const planId = await seedPlan(c, "price_vis_inv_own");
        await seedSubscription(c, "sub_vis_inv_own", USER_UUID, planId, "active");
        await seedInvoice(c, "inv_vis_own", "sub_vis_inv_own", USER_UUID);

        await asRole(c, "authenticated", USER_CLAIMS);
        const { rows } = await c.query<{ stripe_invoice_id: string }>(
          "SELECT stripe_invoice_id FROM public.subscription_invoices WHERE user_id = $1",
          [USER_UUID],
        );
        expect(rows).toHaveLength(1);
      });
    }, 15_000);

    // ── PAY1-AC5f: no anon/authenticated writes ────────────────────────────────

    it("PAY1-AC5f: anon cannot INSERT into monitor_plans", async () => {
      await withTx(client, async (c) => {
        await asRole(c, "anon", ANON_CLAIMS);
        await expectPgError(
          c,
          () =>
            c.query(
              `INSERT INTO public.monitor_plans
                 (stripe_price_id, monitor_limit, billing_interval, amount_ore, active)
               VALUES ('price_anon_write', 1, 'month', 1, true)`,
            ),
          "42501",
          "anon insert monitor_plans",
          { messageIncludes: "permission denied" },
        );
      });
    }, 15_000);

    it("PAY1-AC5f-auth: authenticated cannot INSERT into subscriptions", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await asRole(c, "authenticated", USER_CLAIMS);
        await expectPgError(
          c,
          () =>
            c.query(
              `INSERT INTO public.subscriptions
                 (stripe_subscription_id, user_id, stripe_customer_id, plan_id, status, last_event_created)
               VALUES ('sub_auth_write', $1, 'cus_x',
                       '00000000-0000-0000-0000-000000000000', 'active', now())`,
              [USER_UUID],
            ),
          "42501",
          "authenticated insert subscriptions",
          { messageIncludes: "permission denied" },
        );
      });
    }, 15_000);

    it("PAY1-AC5f-bc: authenticated cannot INSERT into billing_customers", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await asRole(c, "authenticated", USER_CLAIMS);
        await expectPgError(
          c,
          () =>
            c.query(
              "INSERT INTO public.billing_customers (user_id, stripe_customer_id) VALUES ($1, 'cus_authwrite')",
              [USER_UUID],
            ),
          "42501",
          "authenticated insert billing_customers",
          { messageIncludes: "permission denied" },
        );
      });
    }, 15_000);

    // ── PAY1-AC5g: stripe_events invisible ────────────────────────────────────

    it("PAY1-AC5g: authenticated cannot SELECT from stripe_events (no policy, no grant)", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await asRole(c, "authenticated", USER_CLAIMS);
        await expectPgError(
          c,
          () => c.query("SELECT 1 FROM public.stripe_events LIMIT 1"),
          "42501",
          "authenticated select stripe_events",
          { messageIncludes: "permission denied" },
        );
      });
    }, 15_000);

    it("PAY1-AC5g-anon: anon cannot SELECT from stripe_events", async () => {
      await withTx(client, async (c) => {
        await asRole(c, "anon", ANON_CLAIMS);
        await expectPgError(
          c,
          () => c.query("SELECT 1 FROM public.stripe_events LIMIT 1"),
          "42501",
          "anon select stripe_events",
          { messageIncludes: "permission denied" },
        );
      });
    }, 15_000);

    // ── PAY1-AC5h/i: my_monitor_limit ─────────────────────────────────────────

    it("PAY1-AC5h: my_monitor_limit() as authenticated with base 2 and active plan cap 20 → returns exactly 20", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        // base cap 2
        await c.query("UPDATE public.profiles SET monitor_limit = 2 WHERE user_id = $1", [USER_UUID]);
        // active plan with monitor_limit = 20 (seedPlan default)
        const planId = await seedPlan(c, "price_vis_mml_h");
        await seedSubscription(c, "sub_vis_mml_h", USER_UUID, planId, "active");

        await asRole(c, "authenticated", USER_CLAIMS);
        const { rows } = await c.query<{ lim: number | null }>(
          "SELECT public.my_monitor_limit() AS lim",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.lim).toBe(20);
      });
    }, 15_000);

    it("PAY1-AC5i: my_monitor_limit() as anon → 42501 (no EXECUTE privilege; body never reached)", async () => {
      await withTx(client, async (c) => {
        await asRole(c, "anon", ANON_CLAIMS);
        await expectPgError(
          c,
          () => c.query("SELECT public.my_monitor_limit()"),
          "42501",
          "my_monitor_limit as anon",
          { messageIncludes: "permission denied" },
        );
      });
    }, 15_000);

    it("PAY1-AC5i-nosub: my_monitor_limit() as authenticated without sub claim → 42501 forbidden (body branch)", async () => {
      await withTx(client, async (c) => {
        // Authenticated role but no `sub` claim: auth.uid() returns NULL inside the function
        await asRole(c, "authenticated", { role: "authenticated" });
        await expectPgError(
          c,
          () => c.query("SELECT public.my_monitor_limit()"),
          "42501",
          "my_monitor_limit authenticated no sub claim",
          { messageIncludes: "forbidden" },
        );
      });
    }, 15_000);

    // ── PAY1-AC6a: admin delete refused with active subscription ──────────────

    it("PAY1-AC6a: admin_delete_monitor_user refuses when user has active subscription → P0001 has_active_subscription", async () => {
      await withTx(client, async (c) => {
        await seedAdmin(c);
        await seedAuthUser(c, DEL_UUID, DEL_EMAIL);
        const planId = await seedPlan(c, "price_vis_del_active");
        await seedSubscription(c, "sub_vis_del_active", DEL_UUID, planId, "active");

        await asRole(c, "authenticated", ADMIN_CLAIMS);
        await expectPgError(
          c,
          () =>
            c.query("SELECT public.admin_delete_monitor_user($1::uuid)", [DEL_UUID]),
          "P0001",
          "delete with active sub",
          { messageIncludes: "has_active_subscription" },
        );

        // Reset to postgres so auth.users is accessible for the verification read.
        await c.query("RESET role; RESET \"request.jwt.claims\"");
        // User exists (delete refused).
        const { rows } = await c.query<{ id: string }>(
          "SELECT id FROM auth.users WHERE id = $1",
          [DEL_UUID],
        );
        expect(rows).toHaveLength(1);
      });
    }, 20_000);

    it("PAY1-AC6a-trialing: trialing subscription also blocks delete", async () => {
      await withTx(client, async (c) => {
        await seedAdmin(c);
        await seedAuthUser(c, DEL_UUID, DEL_EMAIL);
        const planId = await seedPlan(c, "price_vis_del_trial");
        await seedSubscription(c, "sub_vis_del_trial", DEL_UUID, planId, "trialing");

        await asRole(c, "authenticated", ADMIN_CLAIMS);
        await expectPgError(
          c,
          () =>
            c.query("SELECT public.admin_delete_monitor_user($1::uuid)", [DEL_UUID]),
          "P0001",
          "delete with trialing sub",
          { messageIncludes: "has_active_subscription" },
        );
      });
    }, 20_000);

    // ── PAY1-AC6b: delete allowed when subscription is canceled ───────────────

    it("PAY1-AC6b: delete allowed when subscription is canceled; sub + invoice survive with user_id NULL", async () => {
      await withTx(client, async (c) => {
        await seedAdmin(c);
        await seedAuthUser(c, DEL_UUID, DEL_EMAIL);
        await seedBillingCustomer(c, DEL_UUID, "cus_vis_del_canceled");
        const planId = await seedPlan(c, "price_vis_del_canceled");
        await seedSubscription(c, "sub_vis_del_canceled", DEL_UUID, planId, "canceled");
        await seedInvoice(c, "inv_vis_del_canceled", "sub_vis_del_canceled", DEL_UUID);

        await asRole(c, "authenticated", ADMIN_CLAIMS);
        await expect(
          c.query("SELECT public.admin_delete_monitor_user($1::uuid)", [DEL_UUID]),
        ).resolves.toBeDefined();

        // Reset to postgres so auth.users is accessible for the verification reads.
        await c.query("RESET role; RESET \"request.jwt.claims\"");
        // User deleted
        const { rows: userRows } = await c.query(
          "SELECT 1 FROM auth.users WHERE id = $1",
          [DEL_UUID],
        );
        expect(userRows).toHaveLength(0);

        // billing_customers cascades (user_id FK on delete cascade)
        const { rows: bcRows } = await c.query(
          "SELECT 1 FROM public.billing_customers WHERE stripe_customer_id = $1",
          ["cus_vis_del_canceled"],
        );
        expect(bcRows).toHaveLength(0);

        // Subscription survives with user_id = NULL (FK on delete set null)
        const { rows: subRows } = await c.query<{ user_id: string | null }>(
          "SELECT user_id FROM public.subscriptions WHERE stripe_subscription_id = $1",
          ["sub_vis_del_canceled"],
        );
        expect(subRows).toHaveLength(1);
        expect(subRows[0]!.user_id).toBeNull();

        // Invoice survives with user_id = NULL
        const { rows: invRows } = await c.query<{ user_id: string | null }>(
          "SELECT user_id FROM public.subscription_invoices WHERE stripe_invoice_id = $1",
          ["inv_vis_del_canceled"],
        );
        expect(invRows).toHaveLength(1);
        expect(invRows[0]!.user_id).toBeNull();
      });
    }, 20_000);

    // ── PAY1-AC5f table-driven: all 6 tables × {anon, authenticated} × {INSERT,UPDATE,DELETE,TRUNCATE} ──

    it(
      "PAY1-AC5f table-driven: anon and authenticated refused INSERT/UPDATE/DELETE/TRUNCATE on all 6 payments tables (42501)",
      async () => {
        await withTx(client, async (c) => {
          // Seed base rows as postgres for the UPDATE/DELETE/TRUNCATE probes.
          await seedAuthUser(c, USER_UUID, USER_EMAIL);

          const { rows: [planRow] } = await c.query<{ id: string }>(
            `INSERT INTO public.monitor_plans (stripe_price_id, monitor_limit, billing_interval, amount_ore)
             VALUES ('price_ac5f_tbl', 5, 'month', 1000)
             RETURNING id`,
          );
          const planId = planRow!.id;

          await c.query(
            `INSERT INTO public.monitor_plan_translations (plan_id, locale, name)
             VALUES ($1, 'da', 'AC5f Testplan')`,
            [planId],
          );

          await c.query(
            `INSERT INTO public.billing_customers (user_id, stripe_customer_id)
             VALUES ($1, 'cus_ac5f_tbl')`,
            [USER_UUID],
          );

          await c.query(
            `INSERT INTO public.subscriptions
               (stripe_subscription_id, user_id, stripe_customer_id, plan_id, status, last_event_created)
             VALUES ('sub_ac5f_tbl', $1, 'cus_ac5f_tbl', $2, 'active', now())`,
            [USER_UUID, planId],
          );

          await c.query(
            `INSERT INTO public.subscription_invoices
               (stripe_invoice_id, stripe_subscription_id, user_id, email, amount_total_ore, amount_tax_ore, paid_at)
             VALUES ('inv_ac5f_tbl', 'sub_ac5f_tbl', $1, $2, 1000, 0, now())`,
            [USER_UUID, USER_EMAIL],
          );

          await c.query(
            `INSERT INTO public.stripe_events (id, type, livemode, received_at)
             VALUES ('evt_ac5f_tbl', 'test.event', false, now())`,
          );

          type Probe = {
            label: string;
            role: "anon" | "authenticated";
            claims: JwtClaims;
            sql: string;
            params?: unknown[];
          };

          const probes: Probe[] = [];

          const addProbes = (
            table: string,
            insertSql: string,
            updateSql: string,
            updateParams: unknown[],
            deleteSql: string,
            deleteParams: unknown[],
          ) => {
            for (const [role, claims] of [
              ["anon",          ANON_CLAIMS],
              ["authenticated", USER_CLAIMS],
            ] as const) {
              probes.push({ label: `${role} INSERT ${table}`,   role, claims, sql: insertSql });
              probes.push({ label: `${role} UPDATE ${table}`,   role, claims, sql: updateSql, params: updateParams });
              probes.push({ label: `${role} DELETE ${table}`,   role, claims, sql: deleteSql, params: deleteParams });
              probes.push({ label: `${role} TRUNCATE ${table}`, role, claims, sql: `TRUNCATE public.${table}` });
            }
          };

          addProbes(
            "monitor_plans",
            `INSERT INTO public.monitor_plans (stripe_price_id, monitor_limit, billing_interval, amount_ore)
             VALUES ('price_ac5f_i_mp', 1, 'month', 100)`,
            `UPDATE public.monitor_plans SET sort_order = 99 WHERE id = $1`,
            [planId],
            `DELETE FROM public.monitor_plans WHERE id = $1`,
            [planId],
          );

          addProbes(
            "monitor_plan_translations",
            `INSERT INTO public.monitor_plan_translations (plan_id, locale, name)
             VALUES ('00000000-0000-0000-0000-000000000000', 'en', 'x')`,
            `UPDATE public.monitor_plan_translations SET name = 'x' WHERE plan_id = $1`,
            [planId],
            `DELETE FROM public.monitor_plan_translations WHERE plan_id = $1`,
            [planId],
          );

          addProbes(
            "billing_customers",
            `INSERT INTO public.billing_customers (user_id, stripe_customer_id)
             VALUES ('00000000-0000-0000-0000-000000000000', 'cus_ac5f_i')`,
            `UPDATE public.billing_customers SET stripe_customer_id = 'cus_updated' WHERE user_id = $1`,
            [USER_UUID],
            `DELETE FROM public.billing_customers WHERE user_id = $1`,
            [USER_UUID],
          );

          addProbes(
            "subscriptions",
            `INSERT INTO public.subscriptions
               (stripe_subscription_id, user_id, stripe_customer_id, plan_id, status, last_event_created)
             VALUES ('sub_ac5f_i', '00000000-0000-0000-0000-000000000000', 'cus_x',
                     '00000000-0000-0000-0000-000000000000', 'active', now())`,
            `UPDATE public.subscriptions SET status = 'paused' WHERE stripe_subscription_id = $1`,
            ["sub_ac5f_tbl"],
            `DELETE FROM public.subscriptions WHERE stripe_subscription_id = $1`,
            ["sub_ac5f_tbl"],
          );

          addProbes(
            "subscription_invoices",
            `INSERT INTO public.subscription_invoices
               (stripe_invoice_id, stripe_subscription_id, user_id, email, amount_total_ore, amount_tax_ore, paid_at)
             VALUES ('inv_ac5f_i', 'sub_ac5f_tbl', '00000000-0000-0000-0000-000000000000', 'x@x', 0, 0, now())`,
            `UPDATE public.subscription_invoices SET amount_total_ore = 200 WHERE stripe_invoice_id = $1`,
            ["inv_ac5f_tbl"],
            `DELETE FROM public.subscription_invoices WHERE stripe_invoice_id = $1`,
            ["inv_ac5f_tbl"],
          );

          addProbes(
            "stripe_events",
            `INSERT INTO public.stripe_events (id, type, livemode, received_at)
             VALUES ('evt_ac5f_i', 'test', false, now())`,
            `UPDATE public.stripe_events SET processed_at = now() WHERE id = $1`,
            ["evt_ac5f_tbl"],
            `DELETE FROM public.stripe_events WHERE id = $1`,
            ["evt_ac5f_tbl"],
          );

          // Execute each probe: switch role, assert 42501, then reset to postgres.
          for (const probe of probes) {
            await asRole(c, probe.role, probe.claims);
            await expectPgError(c, () => c.query(probe.sql, probe.params), "42501", probe.label, { messageIncludes: "permission denied" });
            await c.query("SET LOCAL ROLE postgres");
          }
        });
      },
      120_000,
    );

    // ── PAY1-AC5c admin half: admin sees any user's billing data ──────────

    it("PAY1-AC5c-admin: admin sees every user's billing_customers, subscriptions, and subscription_invoices", async () => {
      await withTx(client, async (c) => {
        await seedAdmin(c);
        // Two non-admin users with separate billing data
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await seedBillingCustomer(c, USER_UUID, "cus_vis_admin_u1");
        const planId1 = await seedPlan(c, "price_vis_admin_u1");
        await seedSubscription(c, "sub_vis_admin_u1", USER_UUID, planId1, "active");
        await seedInvoice(c, "inv_vis_admin_u1", "sub_vis_admin_u1", USER_UUID);

        await seedAuthUser(c, OTHER_UUID, OTHER_EMAIL);
        await seedBillingCustomer(c, OTHER_UUID, "cus_vis_admin_u2");
        const planId2 = await seedPlan(c, "price_vis_admin_u2");
        await seedSubscription(c, "sub_vis_admin_u2", OTHER_UUID, planId2, "active");
        await seedInvoice(c, "inv_vis_admin_u2", "sub_vis_admin_u2", OTHER_UUID);

        await asRole(c, "authenticated", ADMIN_CLAIMS);

        // Admin can read USER's billing data
        const { rows: bc1 } = await c.query(
          "SELECT 1 FROM public.billing_customers WHERE stripe_customer_id = $1",
          ["cus_vis_admin_u1"],
        );
        expect(bc1).toHaveLength(1);

        // Admin can read OTHER's billing data too (not just own)
        const { rows: bc2 } = await c.query(
          "SELECT 1 FROM public.billing_customers WHERE stripe_customer_id = $1",
          ["cus_vis_admin_u2"],
        );
        expect(bc2).toHaveLength(1);

        const { rows: subRows } = await c.query(
          "SELECT 1 FROM public.subscriptions WHERE stripe_subscription_id IN ($1, $2)",
          ["sub_vis_admin_u1", "sub_vis_admin_u2"],
        );
        expect(subRows).toHaveLength(2);

        const { rows: invRows } = await c.query(
          "SELECT 1 FROM public.subscription_invoices WHERE stripe_invoice_id IN ($1, $2)",
          ["inv_vis_admin_u1", "inv_vis_admin_u2"],
        );
        expect(invRows).toHaveLength(2);
      });
    }, 15_000);

    // ── PAY1-AC5e: authenticated sees no other user's subscription_invoices ──────

    it("PAY1-AC5e-inv: authenticated sees no other user's subscription_invoices", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_UUID, USER_EMAIL);
        await seedAuthUser(c, OTHER_UUID, OTHER_EMAIL);
        const planId = await seedPlan(c, "price_vis_inv_other");
        await seedSubscription(c, "sub_vis_inv_other", OTHER_UUID, planId, "active");
        await seedInvoice(c, "inv_vis_inv_other", "sub_vis_inv_other", OTHER_UUID);

        await asRole(c, "authenticated", USER_CLAIMS);
        const { rows } = await c.query(
          "SELECT 1 FROM public.subscription_invoices WHERE user_id = $1",
          [OTHER_UUID],
        );
        expect(rows).toHaveLength(0);
      });
    }, 15_000);

    // ── PAY1-AC6a-past_due: past_due also blocks delete ──────────────────────────

    it("PAY1-AC6a-past_due: past_due subscription blocks admin_delete_monitor_user", async () => {
      await withTx(client, async (c) => {
        await seedAdmin(c);
        await seedAuthUser(c, DEL_UUID, DEL_EMAIL);
        const planId = await seedPlan(c, "price_vis_del_pd");
        await seedSubscription(c, "sub_vis_del_pd", DEL_UUID, planId, "past_due");

        await asRole(c, "authenticated", ADMIN_CLAIMS);
        await expectPgError(
          c,
          () =>
            c.query("SELECT public.admin_delete_monitor_user($1::uuid)", [DEL_UUID]),
          "P0001",
          "delete with past_due sub",
          { messageIncludes: "has_active_subscription" },
        );
      });
    }, 20_000);

    // ── PAY1-AC6a extended: non-terminal statuses also block delete ───────────────

    it("PAY1-AC6a-unpaid: unpaid subscription blocks admin_delete_monitor_user", async () => {
      await withTx(client, async (c) => {
        await seedAdmin(c);
        await seedAuthUser(c, DEL_UUID, DEL_EMAIL);
        const planId = await seedPlan(c, "price_vis_del_unpaid");
        await seedSubscription(c, "sub_vis_del_unpaid", DEL_UUID, planId, "unpaid");

        await asRole(c, "authenticated", ADMIN_CLAIMS);
        await expectPgError(
          c,
          () =>
            c.query("SELECT public.admin_delete_monitor_user($1::uuid)", [DEL_UUID]),
          "P0001",
          "delete with unpaid sub",
          { messageIncludes: "has_active_subscription" },
        );
      });
    }, 20_000);

    it("PAY1-AC6a-incomplete: incomplete subscription blocks admin_delete_monitor_user", async () => {
      await withTx(client, async (c) => {
        await seedAdmin(c);
        await seedAuthUser(c, DEL_UUID, DEL_EMAIL);
        const planId = await seedPlan(c, "price_vis_del_incomplete");
        await seedSubscription(c, "sub_vis_del_incomplete", DEL_UUID, planId, "incomplete");

        await asRole(c, "authenticated", ADMIN_CLAIMS);
        await expectPgError(
          c,
          () =>
            c.query("SELECT public.admin_delete_monitor_user($1::uuid)", [DEL_UUID]),
          "P0001",
          "delete with incomplete sub",
          { messageIncludes: "has_active_subscription" },
        );
      });
    }, 20_000);

    it("PAY1-AC6a-paused-sub: paused subscription status blocks admin_delete_monitor_user", async () => {
      await withTx(client, async (c) => {
        await seedAdmin(c);
        await seedAuthUser(c, DEL_UUID, DEL_EMAIL);
        const planId = await seedPlan(c, "price_vis_del_paused");
        await seedSubscription(c, "sub_vis_del_paused", DEL_UUID, planId, "paused");

        await asRole(c, "authenticated", ADMIN_CLAIMS);
        await expectPgError(
          c,
          () =>
            c.query("SELECT public.admin_delete_monitor_user($1::uuid)", [DEL_UUID]),
          "P0001",
          "delete with paused sub",
          { messageIncludes: "has_active_subscription" },
        );
      });
    }, 20_000);

    it("PAY1-AC6b-incomplete_expired: incomplete_expired subscription allows delete", async () => {
      await withTx(client, async (c) => {
        await seedAdmin(c);
        await seedAuthUser(c, DEL_UUID, DEL_EMAIL);
        await seedBillingCustomer(c, DEL_UUID, "cus_vis_del_incexp");
        const planId = await seedPlan(c, "price_vis_del_incexp");
        await seedSubscription(c, "sub_vis_del_incexp", DEL_UUID, planId, "incomplete_expired");

        await asRole(c, "authenticated", ADMIN_CLAIMS);
        await expect(
          c.query("SELECT public.admin_delete_monitor_user($1::uuid)", [DEL_UUID]),
        ).resolves.toBeDefined();

        await c.query("RESET role; RESET \"request.jwt.claims\"");
        // User deleted
        const { rows: userRows } = await c.query("SELECT 1 FROM auth.users WHERE id = $1", [DEL_UUID]);
        expect(userRows).toHaveLength(0);

        // billing_customers removed by cascade
        const { rows: bcRows } = await c.query(
          "SELECT 1 FROM public.billing_customers WHERE stripe_customer_id = $1",
          ["cus_vis_del_incexp"],
        );
        expect(bcRows).toHaveLength(0);

        // Subscription row survives with user_id = NULL (FK on delete set null)
        const { rows: subRows } = await c.query<{ user_id: string | null }>(
          "SELECT user_id FROM public.subscriptions WHERE stripe_subscription_id = $1",
          ["sub_vis_del_incexp"],
        );
        expect(subRows).toHaveLength(1);
        expect(subRows[0]!.user_id).toBeNull();
      });
    }, 20_000);
  },
);
