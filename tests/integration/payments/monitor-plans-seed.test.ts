/**
 * Integration tests — monitor_plans seed for the e2e project.
 * Journey: payments-slice1b-billing  PAY1B-AC49
 *
 * Guard: e2e project only (SUPABASE_E2E_REF). Requires the payments foundation
 * migration (20261112000100_payments_foundation.sql) + the plans seed
 * (supabase/seed-e2e/monitor-plans-test.sql) applied to the target.
 *
 * Run:
 *   npm run test:integration:e2e-project -- tests/integration/payments/monitor-plans-seed.test.ts
 *
 * Notes:
 *   - PostgreSQL bigint is returned by node-pg as a string; select amount_ore::int to get a number.
 *   - sort_order column: year=1, month=2 (from the seed).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient, type PoolClient } from "../rls/helpers/db.js";
import { asRole, ANON_CLAIMS, withTx } from "../rls/helpers/roles.js";

describe.skipIf(!process.env.SUPABASE_E2E_REF)(
  "PAY1B-AC49 — monitor_plans seed: 2 active plans, correct data, anon visibility",
  () => {
    let client: PoolClient;

    beforeAll(async () => {
      client = await getClient();
    });

    afterAll(async () => {
      client.release();
    });

    it("PAY1B-AC49a: exactly two active plans exist", async () => {
      await withTx(client, async (c) => {
        const { rows } = await c.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM public.monitor_plans WHERE active = TRUE",
        );
        expect(rows[0]!.count).toBe("2");
      });
    }, 15_000);

    it("PAY1B-AC49b: plans have intervals 'year' (sort_order 1) and 'month' (sort_order 2)", async () => {
      await withTx(client, async (c) => {
        const { rows } = await c.query<{ billing_interval: string }>(
          "SELECT billing_interval FROM public.monitor_plans WHERE active = TRUE ORDER BY sort_order",
        );
        expect(rows.map((r) => r.billing_interval)).toEqual(["year", "month"]);
      });
    }, 15_000);

    it("PAY1B-AC49c: year plan has amount_ore = 9500", async () => {
      await withTx(client, async (c) => {
        // Cast bigint to int so node-pg returns a number, not a string.
        const { rows } = await c.query<{ amount_ore: number }>(
          "SELECT amount_ore::int AS amount_ore FROM public.monitor_plans WHERE active = TRUE AND billing_interval = 'year'",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.amount_ore).toBe(9500);
      });
    }, 15_000);

    it("PAY1B-AC49d: month plan has amount_ore = 1000", async () => {
      await withTx(client, async (c) => {
        const { rows } = await c.query<{ amount_ore: number }>(
          "SELECT amount_ore::int AS amount_ore FROM public.monitor_plans WHERE active = TRUE AND billing_interval = 'month'",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.amount_ore).toBe(1000);
      });
    }, 15_000);

    it("PAY1B-AC49e: both plans have monitor_limit = 20", async () => {
      await withTx(client, async (c) => {
        const { rows } = await c.query<{ monitor_limit: number }>(
          "SELECT monitor_limit::int AS monitor_limit FROM public.monitor_plans WHERE active = TRUE ORDER BY sort_order",
        );
        expect(rows.map((r) => r.monitor_limit)).toEqual([20, 20]);
      });
    }, 15_000);

    it("PAY1B-AC49f: stripe_price_id values start with 'price_' (test-mode ids)", async () => {
      await withTx(client, async (c) => {
        const { rows } = await c.query<{ stripe_price_id: string }>(
          "SELECT stripe_price_id FROM public.monitor_plans WHERE active = TRUE",
        );
        for (const row of rows) {
          expect(row.stripe_price_id).toMatch(/^price_/);
        }
      });
    }, 15_000);

    it("PAY1B-AC49g: year plan has sort_order = 1, month has sort_order = 2", async () => {
      await withTx(client, async (c) => {
        const { rows } = await c.query<{ billing_interval: string; sort_order: number }>(
          "SELECT billing_interval, sort_order::int AS sort_order FROM public.monitor_plans WHERE active = TRUE ORDER BY sort_order",
        );
        expect(rows[0]).toMatchObject({ billing_interval: "year", sort_order: 1 });
        expect(rows[1]).toMatchObject({ billing_interval: "month", sort_order: 2 });
      });
    }, 15_000);

    it("PAY1B-AC49h: da translation name is 'Monitor Plus' for both plans", async () => {
      await withTx(client, async (c) => {
        const { rows } = await c.query<{ name: string }>(
          `SELECT t.name FROM public.monitor_plan_translations t
           JOIN public.monitor_plans p ON p.id = t.plan_id
           WHERE p.active = TRUE AND t.locale = 'da'
           ORDER BY p.sort_order`,
        );
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.name)).toEqual(["Monitor Plus", "Monitor Plus"]);
      });
    }, 15_000);

    it("PAY1B-AC49i: en translation name is 'Monitor Plus' for both plans", async () => {
      await withTx(client, async (c) => {
        const { rows } = await c.query<{ name: string }>(
          `SELECT t.name FROM public.monitor_plan_translations t
           JOIN public.monitor_plans p ON p.id = t.plan_id
           WHERE p.active = TRUE AND t.locale = 'en'
           ORDER BY p.sort_order`,
        );
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.name)).toEqual(["Monitor Plus", "Monitor Plus"]);
      });
    }, 15_000);

    it("PAY1B-AC49j: anon role sees exactly the same active plans (both by stripe_price_id) as the superuser query", async () => {
      // First collect the superuser-visible stripe_price_ids
      let superuserPriceIds: string[] = [];
      await withTx(client, async (c) => {
        const { rows } = await c.query<{ stripe_price_id: string }>(
          "SELECT stripe_price_id FROM public.monitor_plans WHERE active = TRUE ORDER BY sort_order",
        );
        superuserPriceIds = rows.map((r) => r.stripe_price_id);
      });
      expect(superuserPriceIds).toHaveLength(2);

      // Then verify anon can read the same rows via RLS
      await withTx(client, async (c) => {
        await asRole(c, "anon", ANON_CLAIMS);
        const { rows } = await c.query<{ stripe_price_id: string }>(
          "SELECT stripe_price_id FROM public.monitor_plans WHERE active = TRUE ORDER BY sort_order",
        );
        expect(rows.map((r) => r.stripe_price_id)).toEqual(superuserPriceIds);
      });
    }, 15_000);

    it("PAY1B-AC49k: anon can read monitor_plan_translations (da + en) for both active plans", async () => {
      await withTx(client, async (c) => {
        await asRole(c, "anon", ANON_CLAIMS);
        const { rows } = await c.query<{ locale: string; name: string }>(
          `SELECT t.locale, t.name FROM public.monitor_plan_translations t
           JOIN public.monitor_plans p ON p.id = t.plan_id
           WHERE p.active = TRUE
           ORDER BY p.sort_order, t.locale`,
        );
        // 2 plans × 2 locales = 4 rows; all names "Monitor Plus"
        expect(rows).toHaveLength(4);
        expect(rows.every((r) => r.name === "Monitor Plus")).toBe(true);
        const locales = rows.map((r) => r.locale).sort();
        expect(locales).toEqual(["da", "da", "en", "en"]);
      });
    }, 15_000);
  },
);
