/**
 * Integration tests — monitor free-limit migration (MCH-AC5).
 * Journey: monitor-chrome  MCH-AC5
 *
 * Migration: supabase/migrations/20261107000300_monitor_free_limit_two.sql
 *
 * The test applies the migration itself, inside one rolled-back transaction
 * (withTx), so it proves the migration whether or not the target already
 * holds it:
 *   a. The migration SQL holds no transaction-control statement (a COMMIT
 *      would end withTx's transaction and persist everything below).
 *   b. Inside the transaction the column default is first put back to the
 *      pre-migration 5, and a profile created then (auth.users INSERT →
 *      handle_new_user trigger) gets monitor_limit = 5. After the migration
 *      SQL runs, that profile still holds 5 (spec Q3: "new signups only";
 *      catches a migration that also runs UPDATE profiles SET
 *      monitor_limit = 2).
 *   c. A profile created after the migration gets monitor_limit = 2.
 *   d. information_schema.columns reports column_default = '2'.
 *   e. After the ROLLBACK the column default is what it was before the
 *      test: neither the reset to 5 nor the migration persists.
 *
 * No module-level readFileSync: a missing file surfaces as a named assertion
 * failure (not a module-load crash), so the skip guard can apply before any
 * DB connection is attempted.
 *
 * Guard: e2e project only. The ALTER TABLE statements lock public.profiles
 * until ROLLBACK, which must never happen on production's live table.
 *
 * Run:
 *   npm run test:integration:e2e-project -- tests/integration/rls/rls-monitor-free-limit.test.ts
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import { transactionControlStatements } from "./helpers/migration-sql.js";
import { monitorLimitDefault } from "./helpers/monitor-limit.js";
import { seedAuthUser, withTx } from "./helpers/roles.js";

const ON_E2E_PROJECT = !!process.env.SUPABASE_E2E_REF;

const MIGRATION_PATH = path.resolve(
  "supabase/migrations/20261107000300_monitor_free_limit_two.sql",
);

/** Read the migration file inside a test body — surfaces missing file as a named assertion. */
function readMigration(): string {
  expect(fs.existsSync(MIGRATION_PATH), "migration file 20261107000300 is absent").toBe(true);
  return fs.readFileSync(MIGRATION_PATH, "utf-8");
}

/** The monitor_limit rows of one profile. */
async function monitorLimitRows(c: PoolClient, userId: string): Promise<{ monitor_limit: number | null }[]> {
  const { rows } = await c.query<{ monitor_limit: number | null }>(
    "SELECT monitor_limit FROM public.profiles WHERE user_id = $1",
    [userId],
  );
  return rows;
}

describe.skipIf(!DB_AVAILABLE || !ON_E2E_PROJECT)(
  "MCH-AC5: monitor free-limit migration (20261107000300)",
  () => {
    let client: PoolClient;

    beforeAll(async () => {
      client = await getClient();
    });

    afterAll(async () => {
      client.release();
    });

    // ── a. No transaction-control ─────────────────────────────────────────────

    it("MCH-AC5-mig-a: migration holds no transaction-control statement (safe to run inside withTx)", () => {
      const sql = readMigration();
      expect(transactionControlStatements(sql)).toEqual([]);
    });

    // ── b/c/d/e. Pre-migration state rebuilt in one withTx ────────────────────

    it("MCH-AC5-mig-bcde: existing row keeps 5, new row gets 2, column_default is '2', nothing persists", async () => {
      const sql = readMigration();
      const defaultBefore = await monitorLimitDefault(client);

      await withTx(client, async (c) => {
        await c.query("SET LOCAL lock_timeout = '5s'");

        // Rebuild the pre-migration state, so the test does not pass vacuously
        // on a target that already holds 20261107000300.
        await c.query("ALTER TABLE public.profiles ALTER COLUMN monitor_limit SET DEFAULT 5");

        // MCH-AC5-mig-b (setup): a profile created under the pre-migration default.
        const existingId = randomUUID();
        await seedAuthUser(c, existingId, `mch-ac5-existing-${existingId.slice(0, 8)}@test.local`);
        expect(await monitorLimitRows(c, existingId)).toEqual([{ monitor_limit: 5 }]);

        // Apply the migration in-tx.
        await c.query(sql);

        // MCH-AC5-mig-b: the existing profile keeps its 5 (the migration has no UPDATE).
        expect(await monitorLimitRows(c, existingId)).toEqual([{ monitor_limit: 5 }]);

        // MCH-AC5-mig-c: a profile created after the migration gets monitor_limit = 2.
        const newId = randomUUID();
        await seedAuthUser(c, newId, `mch-ac5-new-${newId.slice(0, 8)}@test.local`);
        expect(await monitorLimitRows(c, newId)).toEqual([{ monitor_limit: 2 }]);

        // MCH-AC5-mig-d: information_schema reports the new default.
        expect(await monitorLimitDefault(c)).toBe("2");
      });

      // MCH-AC5-mig-e: the ROLLBACK undid both the reset to 5 and the migration.
      expect(await monitorLimitDefault(client)).toBe(defaultBefore);
    }, 15_000);
  },
);
