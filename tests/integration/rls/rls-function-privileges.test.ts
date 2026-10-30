/**
 * Integration tests — EXECUTE privileges on functions.
 *
 * Covers F0.4 hardening (migration 20261101000400_hardening.sql):
 *   - a function newly created by postgres in `private` is not executable by PUBLIC,
 *     anon or authenticated (anon/authenticated hold USAGE on `private`, so a PUBLIC
 *     EXECUTE default would expose every future security-definer helper)
 *   - existing private functions: no PUBLIC EXECUTE; anon may run only the RLS visibility
 *     helpers, authenticated additionally is_owner()
 *   - admin RPCs are executable by authenticated, never by anon / PUBLIC
 *
 * Connection: postgres. The probe function is created inside a rolled-back transaction.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import { withTx } from "./helpers/roles.js";

interface ExecRow {
  fn: string;
  public_exec: boolean;
  anon_exec: boolean;
  authenticated_exec: boolean;
}

/** EXECUTE flags per function for PUBLIC / anon / authenticated, keyed by name(args). */
async function execPrivileges(c: PoolClient, where: string, params: unknown[] = []): Promise<ExecRow[]> {
  const { rows } = await c.query<ExecRow>(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn,
            has_function_privilege('public', p.oid, 'EXECUTE')        AS public_exec,
            has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE ${where}
      ORDER BY 1`,
    params,
  );
  return rows;
}

describe.skipIf(!DB_AVAILABLE)("Function EXECUTE privileges", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  it("a new function in schema private is not executable by PUBLIC, anon or authenticated", async () => {
    await withTx(client, async (c) => {
      await c.query(
        "CREATE FUNCTION private.zz_default_acl_probe() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS 'select true'",
      );
      expect(await execPrivileges(c, "n.nspname = 'private' AND p.proname = 'zz_default_acl_probe'")).toEqual([
        { fn: "zz_default_acl_probe()", public_exec: false, anon_exec: false, authenticated_exec: false },
      ]);
    });
  }, 12_000);

  it("existing private functions: no PUBLIC EXECUTE; anon only the visibility helpers; authenticated also is_owner", async () => {
    await withTx(client, async (c) => {
      const rows = await execPrivileges(c, "n.nspname = 'private'");
      const exposed = (key: "public_exec" | "anon_exec" | "authenticated_exec") =>
        rows.filter((r) => r[key]).map((r) => r.fn);

      expect(rows.length).toBeGreaterThan(0);
      expect(exposed("public_exec")).toEqual([]);
      expect(exposed("anon_exec")).toEqual([
        "category_is_public(p_id uuid)",
        "is_admin()",
        "item_is_public(p_id uuid)",
        "page_is_public(p_id uuid)",
      ]);
      expect(exposed("authenticated_exec")).toEqual([
        "category_is_public(p_id uuid)",
        "is_admin()",
        "is_owner()",
        "item_is_public(p_id uuid)",
        "page_is_public(p_id uuid)",
      ]);
    });
  }, 12_000);

  it("admin RPCs are executable by authenticated only", async () => {
    await withTx(client, async (c) => {
      expect(await execPrivileges(c, "n.nspname = 'public' AND p.proname LIKE 'admin\\_%'")).toEqual([
        { fn: "admin_reorder_nav(p_page_ids uuid[])", public_exec: false, anon_exec: false, authenticated_exec: true },
        { fn: "admin_save_page(payload jsonb)", public_exec: false, anon_exec: false, authenticated_exec: true },
        {
          fn: "admin_set_page_status(p_page_id uuid, p_status content_status)",
          public_exec: false,
          anon_exec: false,
          authenticated_exec: true,
        },
      ]);
    });
  }, 12_000);
});
