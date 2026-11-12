/**
 * Integration tests — payments DB foundation: entitlement cap derivation,
 * cap-enforcement trigger, and lapse-pause (PAY1-AC1, PAY1-AC2a–d, PAY1-AC4).
 * Journey: payments-slice1-foundation
 *
 * Guard: e2e project only (SUPABASE_E2E_REF). Requires the payments foundation
 * migration (20261112000100_payments_foundation.sql) to be applied to the target.
 *
 * Run:
 *   npm run test:integration:e2e-project -- tests/integration/rls/rls-payments-entitlement.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient, type PoolClient } from "./helpers/db.js";
import {
  asServiceRole,
  expectPgError,
  seedAuthUser,
  withTx,
} from "./helpers/roles.js";

// ── Fixture UUIDs/emails (prefix 0a34 = pay1-entitlement) ────────────────────

const USER_A_UUID  = "00000000-0000-0000-0a34-000000000001";
const USER_A_EMAIL = "e2e-pay1-ent-a@alnyron-test.local";

const USER_B_UUID  = "00000000-0000-0000-0a34-000000000002";
const USER_B_EMAIL = "e2e-pay1-ent-b@alnyron-test.local";

// Fixed past timestamps so now() inside a tx is irrelevant for ordering.
const EVT_T1 = "2026-01-01T00:00:00Z";
const EVT_T2 = "2026-01-02T00:00:00Z";

// ── Seed helpers ──────────────────────────────────────────────────────────────

/** Insert a monitor_plan row in-tx; returns its id. */
async function seedPlan(
  c: PoolClient,
  stripePriceId: string,
  monitorLimit: number,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO public.monitor_plans
       (stripe_price_id, monitor_limit, billing_interval, amount_ore, active)
     VALUES ($1, $2, 'month', 1000, true)
     RETURNING id`,
    [stripePriceId, monitorLimit],
  );
  return rows[0]!.id;
}

/** Insert a subscription in-tx for the given user + plan. */
async function seedSubscription(
  c: PoolClient,
  subId: string,
  userId: string,
  customerId: string,
  planId: string,
  status: string,
  lastEventCreated: string = EVT_T1,
): Promise<void> {
  await c.query(
    `INSERT INTO public.subscriptions
       (stripe_subscription_id, user_id, stripe_customer_id, plan_id, status, last_event_created)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
    [subId, userId, customerId, planId, status, lastEventCreated],
  );
}

/** Call private.effective_monitor_limit as postgres (bypasses EXECUTE grant). */
async function effectiveLimit(c: PoolClient, userId: string): Promise<number | null> {
  const { rows } = await c.query<{ lim: number | null }>(
    "SELECT private.effective_monitor_limit($1::uuid) AS lim",
    [userId],
  );
  return rows[0]!.lim;
}

/** Set profiles.monitor_limit for a user (as postgres). */
async function setBaseLimit(c: PoolClient, userId: string, limit: number | null): Promise<void> {
  await c.query("UPDATE public.profiles SET monitor_limit = $2 WHERE user_id = $1", [userId, limit]);
}

/** Insert a monitor for userId as postgres, bypassing RLS; returns id. */
async function insertMonitor(
  c: PoolClient,
  userId: string,
  url: string,
  createdAt?: string,
): Promise<string> {
  const q = createdAt
    ? `INSERT INTO public.monitors (user_id, url, interval_minutes, status, created_at)
       VALUES ($1, $2, 30, 'active', $3::timestamptz) RETURNING id`
    : `INSERT INTO public.monitors (user_id, url, interval_minutes, status)
       VALUES ($1, $2, 30, 'active') RETURNING id`;
  const params = createdAt ? [userId, url, createdAt] : [userId, url];
  const { rows } = await c.query<{ id: string }>(q, params);
  return rows[0]!.id;
}

/** Build a valid p_event jsonb string. */
function pEvent(id: string, created: string = EVT_T1): string {
  return JSON.stringify({ id, type: "customer.subscription.updated", created, livemode: false });
}

/** Build a valid p_subscription jsonb string. */
function pSubscription(opts: {
  id: string;
  customerId: string;
  userId: string | null;
  priceId: string;
  status: string;
}): string {
  return JSON.stringify({
    id: opts.id,
    customer: opts.customerId,
    user_id: opts.userId,
    price_id: opts.priceId,
    status: opts.status,
    current_period_end: null,
    cancel_at_period_end: false,
  });
}

// ── describe ──────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.SUPABASE_E2E_REF)(
  "PAY1 — entitlement cap derivation, trigger enforcement, lapse pause",
  () => {
    let client: PoolClient;

    beforeAll(async () => {
      client = await getClient();
    });

    afterAll(async () => {
      client.release();
    });

    // ── PAY1-AC1: cap derivation ───────────────────────────────────────────────

    it("PAY1-AC1a: owner role → effective limit is NULL (unlimited)", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL, "owner");
        expect(await effectiveLimit(c, USER_A_UUID)).toBeNull();
      });
    }, 15_000);

    it("PAY1-AC1b: profiles.monitor_limit IS NULL → effective limit is NULL", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, null);
        expect(await effectiveLimit(c, USER_A_UUID)).toBeNull();
      });
    }, 15_000);

    it("PAY1-AC1c: no profile row → effective limit is NULL", async () => {
      await withTx(client, async (c) => {
        // seedAuthUser triggers on_auth_user_created, which creates the profile row; delete it to
        // simulate a user whose profile has been removed.
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await c.query("DELETE FROM public.profiles WHERE user_id = $1", [USER_A_UUID]);
        expect(await effectiveLimit(c, USER_A_UUID)).toBeNull();
      });
    }, 15_000);

    it("PAY1-AC1d: active sub, plan cap 20 > base cap 2 → effective limit is 20", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, 2);
        const planId = await seedPlan(c, "price_pay1_ent_active", 20);
        await seedSubscription(c, "sub_pay1_ent_active", USER_A_UUID, "cus_pay1_a", planId, "active");
        expect(await effectiveLimit(c, USER_A_UUID)).toBe(20);
      });
    }, 15_000);

    it("PAY1-AC1d-trialing: trialing sub also entitles", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, 2);
        const planId = await seedPlan(c, "price_pay1_ent_trial", 20);
        await seedSubscription(c, "sub_pay1_ent_trial", USER_A_UUID, "cus_pay1_a", planId, "trialing");
        expect(await effectiveLimit(c, USER_A_UUID)).toBe(20);
      });
    }, 15_000);

    it("PAY1-AC1d-past_due: past_due sub also entitles", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, 2);
        const planId = await seedPlan(c, "price_pay1_ent_pd", 20);
        await seedSubscription(c, "sub_pay1_ent_pd", USER_A_UUID, "cus_pay1_a", planId, "past_due");
        expect(await effectiveLimit(c, USER_A_UUID)).toBe(20);
      });
    }, 15_000);

    it("PAY1-AC1e: active sub with plan cap 1 < base cap 5 → effective limit is 5 (greatest wins)", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, 5);
        const planId = await seedPlan(c, "price_pay1_ent_low", 1);
        await seedSubscription(c, "sub_pay1_ent_low", USER_A_UUID, "cus_pay1_a", planId, "active");
        expect(await effectiveLimit(c, USER_A_UUID)).toBe(5);
      });
    }, 15_000);

    it("PAY1-AC1f: canceled sub → effective limit falls back to base cap", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, 2);
        const planId = await seedPlan(c, "price_pay1_ent_cancel", 20);
        await seedSubscription(c, "sub_pay1_ent_cancel", USER_A_UUID, "cus_pay1_a", planId, "canceled");
        expect(await effectiveLimit(c, USER_A_UUID)).toBe(2);
      });
    }, 15_000);

    it("PAY1-AC1d-inactive-plan: plan.active=false still counted when sub is entitling (grandfathered entitlement)", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, 2);
        const planId = await seedPlan(c, "price_pay1_ent_legacy", 15);
        // Mark plan inactive (grandfathered)
        await c.query("UPDATE public.monitor_plans SET active = false WHERE id = $1", [planId]);
        await seedSubscription(c, "sub_pay1_ent_legacy", USER_A_UUID, "cus_pay1_a", planId, "active");
        expect(await effectiveLimit(c, USER_A_UUID)).toBe(15);
      });
    }, 15_000);

    // ── PAY1-AC2: trigger enforcement ─────────────────────────────────────────

    it("PAY1-AC2a: INSERT at effective plan cap → P0001 monitor_limit_reached", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        // base 1, plan cap 2 → effective = greatest(1, 2) = 2
        await setBaseLimit(c, USER_A_UUID, 1);
        const planId = await seedPlan(c, "price_pay1_trig_a", 2);
        await seedSubscription(c, "sub_pay1_trig_a", USER_A_UUID, "cus_pay1_a", planId, "active");

        // Insert exactly 2 monitors (at the effective cap of 2)
        await insertMonitor(c, USER_A_UUID, "https://pay1-a1.example.com");
        await insertMonitor(c, USER_A_UUID, "https://pay1-a2.example.com");

        // The 3rd insert should hit the trigger
        await expectPgError(
          c,
          () =>
            c.query(
              `INSERT INTO public.monitors (user_id, url, interval_minutes)
               VALUES ($1, 'https://pay1-a3.example.com', 30)`,
              [USER_A_UUID],
            ),
          "P0001",
          "insert over plan cap",
          { messageIncludes: "monitor_limit_reached" },
        );
      });
    }, 20_000);

    it("PAY1-AC2b: UPDATE status → active over effective cap → P0001 monitor_limit_reached", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        // base NULL = unlimited: the INSERT cap check fires but passes for all 21 monitors.
        await setBaseLimit(c, USER_A_UUID, null);

        // Insert 20 active monitors
        for (let i = 0; i < 20; i++) {
          await insertMonitor(c, USER_A_UUID, `https://pay1-b${i}.example.com`);
        }
        // Insert one paused monitor directly as postgres before the cap is lowered.
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO public.monitors (user_id, url, interval_minutes, status)
           VALUES ($1, 'https://pay1-b-paused.example.com', 30, 'paused')
           RETURNING id`,
          [USER_A_UUID],
        );
        const pausedId = rows[0]!.id;

        // Now set effective cap = 20; the 20 active monitors already hit the limit.
        const planId = await seedPlan(c, "price_pay1_trig_b", 20);
        await seedSubscription(c, "sub_pay1_trig_b", USER_A_UUID, "cus_pay1_a", planId, "active");
        await setBaseLimit(c, USER_A_UUID, 2);
        // effective = greatest(2, 20) = 20; already hold 20 active monitors = at cap
        // Re-activating when already 20 active → trigger should refuse
        await expectPgError(
          c,
          () =>
            c.query(
              "UPDATE public.monitors SET status = 'active' WHERE id = $1",
              [pausedId],
            ),
          "P0001",
          "activate over cap",
          { messageIncludes: "monitor_limit_reached" },
        );
      });
    }, 25_000);

    it("PAY1-AC2c: UPDATE status → paused over cap → no error (pausing always allowed)", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, 2);
        const planId = await seedPlan(c, "price_pay1_trig_c", 20);
        await seedSubscription(c, "sub_pay1_trig_c", USER_A_UUID, "cus_pay1_a", planId, "active");

        // Insert 20 active monitors
        const ids: string[] = [];
        for (let i = 0; i < 20; i++) {
          ids.push(await insertMonitor(c, USER_A_UUID, `https://pay1-c${i}.example.com`));
        }

        // Pausing any of them must not be blocked
        await expect(
          c.query("UPDATE public.monitors SET status = 'paused' WHERE id = $1", [ids[0]]),
        ).resolves.toBeDefined();
      });
    }, 25_000);

    it("PAY1-AC2d: INSERT under effective cap → succeeds", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, 5);
        const planId = await seedPlan(c, "price_pay1_trig_d", 20);
        await seedSubscription(c, "sub_pay1_trig_d", USER_A_UUID, "cus_pay1_a", planId, "active");

        // Insert 3 monitors (well under cap of 20)
        await expect(
          c.query(
            `INSERT INTO public.monitors (user_id, url, interval_minutes)
             VALUES ($1, 'https://pay1-d1.example.com', 30),
                    ($1, 'https://pay1-d2.example.com', 30),
                    ($1, 'https://pay1-d3.example.com', 30)`,
            [USER_A_UUID],
          ),
        ).resolves.toBeDefined();
      });
    }, 20_000);

    // ── PAY1-AC4: lapse pause ─────────────────────────────────────────────────

    it("PAY1-AC4a/b: lapse pauses newest monitors beyond plan cap, correct count returned", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        // base null (unlimited) so the INSERT cap check passes for all three inserts; lowered to 1 before the sync
        await setBaseLimit(c, USER_A_UUID, null);

        await seedPlan(c, "price_pay1_lapse_a", 2);

        // Insert 3 monitors with distinct created_at so ordering is deterministic
        await insertMonitor(c, USER_A_UUID, "https://pay1-lapse-oldest.example.com", "2026-01-01T00:00:00Z");
        await insertMonitor(c, USER_A_UUID, "https://pay1-lapse-middle.example.com", "2026-01-02T00:00:00Z");
        await insertMonitor(c, USER_A_UUID, "https://pay1-lapse-newest.example.com", "2026-01-03T00:00:00Z");

        // base 1, plan cap 2 → effective = greatest(1, 2) = 2; 3 active > 2 → lapse fires
        await setBaseLimit(c, USER_A_UUID, 1);

        await asServiceRole(c);
        const { rows } = await c.query<{ result: { outcome: string; paused: number } }>(
          "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
          [
            pEvent("evt_pay1_lapse_a", EVT_T1),
            pSubscription({
              id: "sub_pay1_lapse_a",
              customerId: "cus_pay1_lapse_a",
              userId: USER_A_UUID,
              priceId: "price_pay1_lapse_a",
              status: "active",
            }),
          ],
        );
        const result = rows[0]!.result;
        expect(result.outcome).toBe("applied");
        expect(result.paused).toBe(1);
      });
    }, 20_000);

    it("PAY1-AC4b: exactly the newest monitor is paused, oldest two remain active", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, null);
        await seedPlan(c, "price_pay1_lapse_b", 2);

        const id1 = await insertMonitor(c, USER_A_UUID, "https://pay1-lb-oldest.example.com", "2026-01-01T00:00:00Z");
        const id2 = await insertMonitor(c, USER_A_UUID, "https://pay1-lb-mid.example.com",    "2026-01-02T00:00:00Z");
        const id3 = await insertMonitor(c, USER_A_UUID, "https://pay1-lb-newest.example.com", "2026-01-03T00:00:00Z");
        await setBaseLimit(c, USER_A_UUID, 1);

        await asServiceRole(c);
        await c.query(
          "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb)",
          [
            pEvent("evt_pay1_lapse_b", EVT_T1),
            pSubscription({
              id: "sub_pay1_lapse_b",
              customerId: "cus_pay1_lapse_b",
              userId: USER_A_UUID,
              priceId: "price_pay1_lapse_b",
              status: "active",
            }),
          ],
        );

        // Verify statuses (service_role bypasses RLS for the read)
        const { rows } = await c.query<{ id: string; status: string }>(
          "SELECT id, status FROM public.monitors WHERE user_id = $1 ORDER BY created_at",
          [USER_A_UUID],
        );
        expect(rows).toEqual([
          { id: id1, status: "active" },
          { id: id2, status: "active" },
          { id: id3, status: "paused" },
        ]);
      });
    }, 20_000);

    it("PAY1-AC4c: lapse only pauses the target user's monitors, not other users", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, null);
        await seedAuthUser(c, USER_B_UUID, USER_B_EMAIL);
        await setBaseLimit(c, USER_B_UUID, 10);

        await seedPlan(c, "price_pay1_lapse_c", 2);

        // User A: 3 monitors (will be over effective cap 2 after sync)
        await insertMonitor(c, USER_A_UUID, "https://pay1-lc-a1.example.com", "2026-01-01T00:00:00Z");
        await insertMonitor(c, USER_A_UUID, "https://pay1-lc-a2.example.com", "2026-01-02T00:00:00Z");
        await insertMonitor(c, USER_A_UUID, "https://pay1-lc-a3.example.com", "2026-01-03T00:00:00Z");
        await setBaseLimit(c, USER_A_UUID, 1);

        // User B: 3 monitors (should not be touched)
        await insertMonitor(c, USER_B_UUID, "https://pay1-lc-b1.example.com");
        await insertMonitor(c, USER_B_UUID, "https://pay1-lc-b2.example.com");
        await insertMonitor(c, USER_B_UUID, "https://pay1-lc-b3.example.com");

        await asServiceRole(c);
        const { rows: syncResult } = await c.query<{ result: { outcome: string; paused: number } }>(
          "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
          [
            pEvent("evt_pay1_lapse_c", EVT_T1),
            pSubscription({
              id: "sub_pay1_lapse_c",
              customerId: "cus_pay1_lapse_c",
              userId: USER_A_UUID,
              priceId: "price_pay1_lapse_c",
              status: "active",
            }),
          ],
        );
        // lapse must have fired for user A: 3 active > effective cap 2 → 1 paused
        expect(syncResult[0]!.result.paused).toBe(1);

        const { rows: bRows } = await c.query<{ status: string }>(
          "SELECT status FROM public.monitors WHERE user_id = $1",
          [USER_B_UUID],
        );
        expect(bRows).toHaveLength(3);
        expect(bRows.every((r) => r.status === "active")).toBe(true);
      });
    }, 20_000);

    it("PAY1-AC4d: lapse pause changes status only — no monitors deleted", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, null);
        await seedPlan(c, "price_pay1_lapse_d", 2);
        await insertMonitor(c, USER_A_UUID, "https://pay1-ld-1.example.com", "2026-01-01T00:00:00Z");
        await insertMonitor(c, USER_A_UUID, "https://pay1-ld-2.example.com", "2026-01-02T00:00:00Z");
        await insertMonitor(c, USER_A_UUID, "https://pay1-ld-3.example.com", "2026-01-03T00:00:00Z");
        await setBaseLimit(c, USER_A_UUID, 1);

        const { rows: before } = await c.query<{ count: string }>(
          "SELECT count(*) FROM public.monitors WHERE user_id = $1",
          [USER_A_UUID],
        );

        await asServiceRole(c);
        const { rows: syncRows } = await c.query<{ result: { outcome: string; paused: number } }>(
          "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
          [
            pEvent("evt_pay1_lapse_d", EVT_T1),
            pSubscription({
              id: "sub_pay1_lapse_d",
              customerId: "cus_pay1_lapse_d",
              userId: USER_A_UUID,
              priceId: "price_pay1_lapse_d",
              status: "active",
            }),
          ],
        );
        expect(syncRows[0]!.result.paused).toBe(1);

        const { rows: after } = await c.query<{ count: string }>(
          "SELECT count(*) FROM public.monitors WHERE user_id = $1",
          [USER_A_UUID],
        );
        expect(after[0]!.count).toBe(before[0]!.count);
      });
    }, 20_000);

    it("PAY1-AC4e: re-activation within cap succeeds after a lapse pause", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, null);
        await seedPlan(c, "price_pay1_lapse_e", 2);

        // 3 monitors; lapse will pause the newest
        await insertMonitor(c, USER_A_UUID, "https://pay1-le-1.example.com", "2026-01-01T00:00:00Z");
        const id2 = await insertMonitor(c, USER_A_UUID, "https://pay1-le-2.example.com", "2026-01-02T00:00:00Z");
        const id3 = await insertMonitor(c, USER_A_UUID, "https://pay1-le-3.example.com", "2026-01-03T00:00:00Z");
        await setBaseLimit(c, USER_A_UUID, 1);

        await asServiceRole(c);
        await c.query(
          "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb)",
          [
            pEvent("evt_pay1_lapse_e", EVT_T1),
            pSubscription({
              id: "sub_pay1_lapse_e",
              customerId: "cus_pay1_lapse_e",
              userId: USER_A_UUID,
              priceId: "price_pay1_lapse_e",
              status: "active",
            }),
          ],
        );

        // id3 (newest) is paused; id2 is active. Pause id2 so a slot is free, then re-activate id3.
        await c.query("UPDATE public.monitors SET status = 'paused' WHERE id = $1", [id2]);

        // Now 1 active (id1) + 2 paused (id2, id3); cap 2 → re-activating id3 should work
        await expect(
          c.query("UPDATE public.monitors SET status = 'active' WHERE id = $1", [id3]),
        ).resolves.toBeDefined();
      });
    }, 25_000);

    // ── PAY1-AC1g: profiles.monitor_limit never written ──────────────────────

    it("PAY1-AC1g: profiles.monitor_limit is never written by subscription sync or invoice operations", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        await setBaseLimit(c, USER_A_UUID, 3);
        await seedPlan(c, "price_pay1_ac1g", 20);

        // Snapshot monitor_limit and ctid before any payment sync.
        const { rows: [snap] } = await c.query<{ monitor_limit: number; ctid: string }>(
          "SELECT monitor_limit, ctid::text FROM public.profiles WHERE user_id = $1",
          [USER_A_UUID],
        );
        expect(snap).toBeDefined();
        const originalLimit = snap!.monitor_limit;
        const originalCtid  = snap!.ctid;

        await asServiceRole(c);

        // Applied active sync (lapse runs; no monitors to pause — asserts no write to profiles).
        const r1 = await c.query<{ result: { outcome: string; paused: number } }>(
          "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
          [
            pEvent("evt_ac1g_1", EVT_T1),
            pSubscription({ id: "sub_ac1g", customerId: "cus_ac1g", userId: USER_A_UUID, priceId: "price_pay1_ac1g", status: "active" }),
          ],
        );
        expect(r1.rows[0]!.result.outcome).toBe("applied");

        const { rows: [a1] } = await c.query<{ monitor_limit: number; ctid: string }>(
          "SELECT monitor_limit, ctid::text FROM public.profiles WHERE user_id = $1",
          [USER_A_UUID],
        );
        expect(a1!.monitor_limit).toBe(originalLimit);
        expect(a1!.ctid).toBe(originalCtid);

        // Applied canceled sync (lapse to base cap; no monitors to pause).
        const r2 = await c.query<{ result: { outcome: string; paused: number } }>(
          "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
          [
            pEvent("evt_ac1g_2", EVT_T2),
            pSubscription({ id: "sub_ac1g", customerId: "cus_ac1g", userId: USER_A_UUID, priceId: "price_pay1_ac1g", status: "canceled" }),
          ],
        );
        expect(r2.rows[0]!.result.outcome).toBe("applied");

        const { rows: [a2] } = await c.query<{ monitor_limit: number; ctid: string }>(
          "SELECT monitor_limit, ctid::text FROM public.profiles WHERE user_id = $1",
          [USER_A_UUID],
        );
        expect(a2!.monitor_limit).toBe(originalLimit);
        expect(a2!.ctid).toBe(originalCtid);

        // payments_record_subscription_invoice also must not write profiles.monitor_limit.
        const r3 = await c.query<{ result: { outcome: string; paused: number } }>(
          "SELECT public.payments_record_subscription_invoice($1::jsonb, $2::jsonb, $3::jsonb) AS result",
          [
            pEvent("evt_ac1g_inv", "2026-01-03T00:00:00Z"),
            pSubscription({ id: "sub_ac1g", customerId: "cus_ac1g", userId: USER_A_UUID, priceId: "price_pay1_ac1g", status: "active" }),
            JSON.stringify({
              id: "inv_ac1g",
              subscription_id: "sub_ac1g",
              email: USER_A_EMAIL,
              amount_total_ore: 1000,
              amount_tax_ore: 0,
              period_start: null,
              period_end: null,
              paid_at: EVT_T1,
            }),
          ],
        );
        expect(r3.rows[0]!.result.outcome).toBe("applied");
        // Assert the invoice row was written.
        const { rows: invRows } = await c.query<{ stripe_invoice_id: string }>(
          "SELECT stripe_invoice_id FROM public.subscription_invoices WHERE stripe_invoice_id = $1",
          ["inv_ac1g"],
        );
        expect(invRows).toHaveLength(1);

        const { rows: [a3] } = await c.query<{ monitor_limit: number; ctid: string }>(
          "SELECT monitor_limit, ctid::text FROM public.profiles WHERE user_id = $1",
          [USER_A_UUID],
        );
        expect(a3!.monitor_limit).toBe(originalLimit);
        expect(a3!.ctid).toBe(originalCtid);
      });
    }, 30_000);

    // ── PAY1-AC4f: stale and duplicate syncs never trigger lapse ─────────────

    it("PAY1-AC4f-stale: stale sync returns paused = 0 and does not change monitors even when user is over cap", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        // Insert monitors while base is unlimited; lower the cap AFTER seeding.
        await setBaseLimit(c, USER_A_UUID, null);
        const planId = await seedPlan(c, "price_pay1_ac4f_stale", 2);

        const id1 = await insertMonitor(c, USER_A_UUID, "https://pay1-4f-stale-oldest.example.com", "2026-01-01T00:00:00Z");
        const id2 = await insertMonitor(c, USER_A_UUID, "https://pay1-4f-stale-mid.example.com",    "2026-01-02T00:00:00Z");
        const id3 = await insertMonitor(c, USER_A_UUID, "https://pay1-4f-stale-newest.example.com", "2026-01-03T00:00:00Z");

        // Lower cap AFTER inserts: effective (with an entitling sub) = greatest(1, 2) = 2; user has 3 → over cap.
        await setBaseLimit(c, USER_A_UUID, 1);

        // Seed the subscription row directly with last_event_created = EVT_T2 so any
        // event at EVT_T1 will be treated as stale without needing a prior sync call.
        await seedSubscription(c, "sub_ac4f_stale", USER_A_UUID, "cus_ac4f_stale", planId, "active", EVT_T2);

        await asServiceRole(c);

        // Send EVT_T1 (older than last_event_created EVT_T2) → outcome must be stale; paused must be 0.
        const staleResult = await c.query<{ result: { outcome: string; paused: number } }>(
          "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
          [
            pEvent("evt_ac4f_stale_probe", EVT_T1),
            pSubscription({ id: "sub_ac4f_stale", customerId: "cus_ac4f_stale", userId: USER_A_UUID, priceId: "price_pay1_ac4f_stale", status: "active" }),
          ],
        );
        expect(staleResult.rows[0]!.result.outcome).toBe("stale");
        expect(staleResult.rows[0]!.result.paused).toBe(0);

        // All 3 monitors must remain active — stale sync must not run lapse.
        const { rows } = await c.query<{ id: string; status: string }>(
          "SELECT id, status FROM public.monitors WHERE user_id = $1 ORDER BY created_at",
          [USER_A_UUID],
        );
        expect(rows).toEqual([
          { id: id1, status: "active" },
          { id: id2, status: "active" },
          { id: id3, status: "active" },
        ]);
      });
    }, 30_000);

    it("PAY1-AC4f-dup: duplicate sync returns paused = 0 and does not change monitors even when user is over cap", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        // Insert monitors while both base and plan cap are high enough to avoid trigger.
        await setBaseLimit(c, USER_A_UUID, 10);
        const planId = await seedPlan(c, "price_pay1_ac4f_dup", 20);

        const id1 = await insertMonitor(c, USER_A_UUID, "https://pay1-4f-dup-oldest.example.com", "2026-01-01T00:00:00Z");
        const id2 = await insertMonitor(c, USER_A_UUID, "https://pay1-4f-dup-mid.example.com",    "2026-01-02T00:00:00Z");
        const id3 = await insertMonitor(c, USER_A_UUID, "https://pay1-4f-dup-newest.example.com", "2026-01-03T00:00:00Z");

        await asServiceRole(c);

        // Apply EVT_T1 with plan cap 20: effective = greatest(10, 20) = 20; 3 ≤ 20 → paused = 0.
        const first = await c.query<{ result: { outcome: string; paused: number } }>(
          "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
          [
            pEvent("evt_ac4f_dup_1", EVT_T1),
            pSubscription({ id: "sub_ac4f_dup", customerId: "cus_ac4f_dup", userId: USER_A_UUID, priceId: "price_pay1_ac4f_dup", status: "active" }),
          ],
        );
        expect(first.rows[0]!.result.outcome).toBe("applied");
        expect(first.rows[0]!.result.paused).toBe(0);

        // As postgres, lower both caps so the user is now over the effective cap (3 active > 1).
        // This simulates the "over cap" state without re-activating any paused monitor.
        await c.query("SET LOCAL ROLE postgres");
        await c.query("UPDATE public.monitor_plans SET monitor_limit = 1 WHERE id = $1", [planId]);
        await setBaseLimit(c, USER_A_UUID, 1);

        // Switch back to service_role to run the duplicate sync.
        await asServiceRole(c);

        // Apply the same event id again → outcome must be duplicate; paused must be 0.
        const dupResult = await c.query<{ result: { outcome: string; paused: number } }>(
          "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
          [
            pEvent("evt_ac4f_dup_1", EVT_T1),
            pSubscription({ id: "sub_ac4f_dup", customerId: "cus_ac4f_dup", userId: USER_A_UUID, priceId: "price_pay1_ac4f_dup", status: "active" }),
          ],
        );
        expect(dupResult.rows[0]!.result.outcome).toBe("duplicate");
        expect(dupResult.rows[0]!.result.paused).toBe(0);

        // All 3 monitors must remain active — duplicate sync must not run lapse.
        const { rows } = await c.query<{ id: string; status: string }>(
          "SELECT id, status FROM public.monitors WHERE user_id = $1 ORDER BY created_at",
          [USER_A_UUID],
        );
        expect(rows).toEqual([
          { id: id1, status: "active" },
          { id: id2, status: "active" },
          { id: id3, status: "active" },
        ]);
      });
    }, 30_000);

    // ── PAY1-AC4g: lapse triggered by subscription leaving entitling status ───

    it("PAY1-AC4g: sync active then canceled (newer event) lapses user to base cap, pauses newest excess", async () => {
      await withTx(client, async (c) => {
        await seedAuthUser(c, USER_A_UUID, USER_A_EMAIL);
        // Insert monitors while base is unlimited; lower to 2 AFTER seeding to avoid INSERT trigger.
        await setBaseLimit(c, USER_A_UUID, null);
        await seedPlan(c, "price_pay1_ac4g", 20);

        const id1 = await insertMonitor(c, USER_A_UUID, "https://pay1-4g-oldest.example.com", "2026-01-01T00:00:00Z");
        const id2 = await insertMonitor(c, USER_A_UUID, "https://pay1-4g-mid.example.com",    "2026-01-02T00:00:00Z");
        const id3 = await insertMonitor(c, USER_A_UUID, "https://pay1-4g-newest.example.com", "2026-01-03T00:00:00Z");

        // Base cap 2; with active sub plan cap 20: effective = greatest(2, 20) = 20.
        await setBaseLimit(c, USER_A_UUID, 2);
        await asServiceRole(c);

        // Active sync (EVT_T1): effective = 20; 3 ≤ 20 → paused = 0.
        const activeResult = await c.query<{ result: { outcome: string; paused: number } }>(
          "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
          [
            pEvent("evt_ac4g_active", EVT_T1),
            pSubscription({ id: "sub_ac4g", customerId: "cus_ac4g", userId: USER_A_UUID, priceId: "price_pay1_ac4g", status: "active" }),
          ],
        );
        expect(activeResult.rows[0]!.result.outcome).toBe("applied");
        expect(activeResult.rows[0]!.result.paused).toBe(0);

        // Canceled sync (EVT_T2, newer): effective drops to base = 2; 3 active > 2 → pause 1 newest.
        const cancelResult = await c.query<{ result: { outcome: string; paused: number } }>(
          "SELECT public.payments_sync_subscription($1::jsonb, $2::jsonb) AS result",
          [
            pEvent("evt_ac4g_cancel", EVT_T2),
            pSubscription({ id: "sub_ac4g", customerId: "cus_ac4g", userId: USER_A_UUID, priceId: "price_pay1_ac4g", status: "canceled" }),
          ],
        );
        expect(cancelResult.rows[0]!.result.outcome).toBe("applied");
        expect(cancelResult.rows[0]!.result.paused).toBe(1);

        // Newest monitor (id3) must be paused; oldest two must remain active.
        const { rows } = await c.query<{ id: string; status: string }>(
          "SELECT id, status FROM public.monitors WHERE user_id = $1 ORDER BY created_at",
          [USER_A_UUID],
        );
        expect(rows).toEqual([
          { id: id1, status: "active" },
          { id: id2, status: "active" },
          { id: id3, status: "paused" },
        ]);
      });
    }, 30_000);
  },
);
