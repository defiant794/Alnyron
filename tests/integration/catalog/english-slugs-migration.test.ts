/**
 * Integration tests: english-slugs data migration
 * Journey: english-slugs
 * Acceptance ID: AC-ENSLUG-09
 *
 * Migration: supabase/migrations/20261105000200_english_route_slugs.sql
 *
 * Verifies that:
 *   1. The migration's SQL holds no transaction-control statement, so running
 *      it inside withTx cannot commit (persist) its UPDATE.
 *   2. The migration's SQL, run on a category whose Danish route slug differs
 *      from its English one, sets the Danish slug to the English slug, leaves
 *      custom-page routes alone, and leaves both unchanged when run again.
 *      Only the seeded rows are asserted, so the result does not depend on
 *      whether the target DB is already migrated.
 *   3. In the target DB, every category's Danish route slug equals its English
 *      one.
 *   4. No route row holds an old Danish section slug (hjemmesider, ydelser,
 *      3d-modeller).
 *
 * Every test runs inside a rolled-back transaction (withTx): the seeded rows
 * and the migration's UPDATE never persist. The seeded category routes per
 * kind are checked by rls-catalog-constraints.test.ts (AC-CAT-43).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "../rls/helpers/db.js";
import { seedCategory, seedDraftPage, seedRoute, withTx } from "../rls/helpers/roles.js";

const MIGRATION_SQL = fs.readFileSync(
  path.resolve("supabase/migrations/20261105000200_english_route_slugs.sql"),
  "utf-8",
);

/** Statement keywords that start, end or nest a transaction. */
const TRANSACTION_CONTROL = /^(begin|start\s+transaction|commit|end|abort|rollback|savepoint|release|prepare\s+transaction)\b/i;

/**
 * The statements of `sql` that control the transaction. Comments and
 * dollar-quoted bodies are removed first, so neither a `-- commit` remark nor
 * a function's `end;` counts.
 */
function transactionControlStatements(sql: string): string[] {
  return sql
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => TRANSACTION_CONTROL.test(statement));
}

describe.skipIf(!DB_AVAILABLE)("english-slugs migration: DA route slugs equal EN route slugs", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  it("AC-ENSLUG-09: the migration sets a category's DA route slug to its EN slug, and a second run leaves it unchanged", async () => {
    // The guard finds transaction control, but not in a comment or a function body.
    expect(transactionControlStatements("-- commit\nbegin;\nupdate x set y = 1;\ncommit;")).toEqual(["begin", "commit"]);
    expect(transactionControlStatements("do $$ begin perform 1; end $$;")).toEqual([]);
    // A COMMIT (or BEGIN/END) in the file would end withTx's transaction and
    // persist the UPDATE on the target DB.
    expect(transactionControlStatements(MIGRATION_SQL)).toEqual([]);

    await withTx(client, async (c) => {
      const suffix = randomUUID().slice(0, 8);
      const catId = await seedCategory(c);
      await seedRoute(c, "da", `enslug-mig-da-${suffix}`, { categoryId: catId });
      await seedRoute(c, "en", `enslug-mig-en-${suffix}`, { categoryId: catId });
      const pageId = await seedDraftPage(c);
      await seedRoute(c, "da", `enslug-mig-page-da-${suffix}`, { pageId });
      await seedRoute(c, "en", `enslug-mig-page-en-${suffix}`, { pageId });

      const routesOf = async (column: "category_id" | "page_id", id: string) =>
        (
          await c.query<{ locale: string; slug: string }>(
            `SELECT locale, slug FROM public.routes WHERE ${column} = $1 ORDER BY locale`,
            [id],
          )
        ).rows;
      const migratedCategoryRoutes = [
        { locale: "da", slug: `enslug-mig-en-${suffix}` },
        { locale: "en", slug: `enslug-mig-en-${suffix}` },
      ];
      const pageRoutes = [
        { locale: "da", slug: `enslug-mig-page-da-${suffix}` },
        { locale: "en", slug: `enslug-mig-page-en-${suffix}` },
      ];

      // Only the seeded rows are asserted: the UPDATE also changes any other
      // category the target DB still has unmigrated, so a row count would
      // depend on the DB's state.
      await c.query(MIGRATION_SQL);
      expect(await routesOf("category_id", catId)).toEqual(migratedCategoryRoutes);
      expect(await routesOf("page_id", pageId)).toEqual(pageRoutes);

      await c.query(MIGRATION_SQL);
      expect(await routesOf("category_id", catId)).toEqual(migratedCategoryRoutes);
      expect(await routesOf("page_id", pageId)).toEqual(pageRoutes);
    });
  }, 15_000);

  it("AC-ENSLUG-09: every category's DA route slug equals its EN route slug", async () => {
    await withTx(client, async (c) => {
      // Grouped by category id (not kind), so two categories of one kind cannot
      // hide a mismatch; IS DISTINCT FROM also flags a category missing one
      // locale's route. The rows name every category that still differs.
      const { rows } = await c.query<{ cat_id: string; kind: string; da_slug: string | null; en_slug: string | null }>(
        `SELECT cat.id AS cat_id, cat.kind,
                MAX(CASE WHEN r.locale = 'da' THEN r.slug END) AS da_slug,
                MAX(CASE WHEN r.locale = 'en' THEN r.slug END) AS en_slug
           FROM public.routes r
           JOIN public.categories cat ON cat.id = r.category_id
          GROUP BY cat.id, cat.kind
         HAVING MAX(CASE WHEN r.locale = 'da' THEN r.slug END)
                IS DISTINCT FROM
                MAX(CASE WHEN r.locale = 'en' THEN r.slug END)
         ORDER BY cat.kind`,
      );
      expect(rows).toEqual([]);
    });
  }, 15_000);

  it("AC-ENSLUG-09: no route row holds an old Danish section slug (hjemmesider, ydelser, 3d-modeller)", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ locale: string; slug: string }>(
        `SELECT locale, slug FROM public.routes
          WHERE slug IN ('hjemmesider', 'ydelser', '3d-modeller')`,
      );
      expect(rows).toEqual([]);
    });
  }, 15_000);
});
