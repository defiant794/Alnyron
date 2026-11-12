/**
 * Integration tests — EXECUTE privileges on functions.
 *
 * Covers F0.4 hardening (migration 20261101000400_hardening.sql), the F2.1 catalog
 * grants (migration 20261103000100_catalog_admin.sql), the F2.1 catalog hardening
 * (migration 20261103000300_catalog_hardening.sql), the P3 MyLife role gate
 * (migration 20261106000200_monitor_schema.sql), the admin Monitor signups list
 * (migration 20261111000100_admin_monitor_signups.sql), the admin Monitor signup
 * delete (migration 20261111000200_admin_delete_monitor_user.sql), and the payments
 * foundation (migration 20261112000100_payments_foundation.sql):
 *   - a function newly created by postgres in `private` is not executable by PUBLIC,
 *     anon, authenticated, or service_role (anon/authenticated hold USAGE on `private`,
 *     so a PUBLIC EXECUTE default would expose every future security-definer helper;
 *     service_role is similarly not granted EXECUTE by default — only the four explicitly
 *     granted private helpers carry that privilege)
 *   - existing private functions: no PUBLIC EXECUTE; anon may run only the RLS visibility
 *     helpers, authenticated additionally is_owner(), is_mylife() (the mylife_* policies),
 *     is_monitor() (the monitors / monitor_events policies; expected only where the monitor
 *     schema is applied) and the CHECK / storage-policy helpers external_links_valid(),
 *     media_mime_type() and media_path_valid() (evaluated as the writer); the trigger functions
 *     media_limit_per_item() / stamp_updated_by() need no grant (triggers are not EXECUTE-checked
 *     when they fire)
 *   - admin RPCs (pages + catalog + admin_list_monitor_signups() +
 *     admin_delete_monitor_user(), each conditional on its migration) are executable
 *     by authenticated, never by anon / PUBLIC
 *   - payments ACLs: payments_sync_subscription and payments_record_subscription_invoice
 *     (public) are EXECUTE-only for service_role; my_monitor_limit() grants EXECUTE to
 *     authenticated (service_role retains schema default); and of the private helpers,
 *     exactly the four called by the public payments functions (effective_monitor_limit,
 *     payments_valid_timestamptz, payments_apply_subscription, payments_pause_over_cap)
 *     have service_role EXECUTE
 *
 * Connection: postgres. The probe function is created inside a rolled-back transaction.
 * Journey: payments-slice1-foundation  PAY1-AC5h, PAY1-AC5j, PAY1-AC5k
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

  it("a new function in schema private is not executable by PUBLIC, anon, authenticated, or service_role", async () => {
    await withTx(client, async (c) => {
      await c.query(
        "CREATE FUNCTION private.zz_default_acl_probe() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS 'select true'",
      );
      expect(await execPrivileges(c, "n.nspname = 'private' AND p.proname = 'zz_default_acl_probe'")).toEqual([
        { fn: "zz_default_acl_probe()", public_exec: false, anon_exec: false, authenticated_exec: false },
      ]);
      // service_role must also have no EXECUTE on a freshly created private function:
      // the schema default grants no EXECUTE to service_role, so only the four explicitly
      // granted helpers carry the privilege.
      const { rows: svcRows } = await c.query<{ exec: boolean }>(
        `SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') AS exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'private' AND p.proname = 'zz_default_acl_probe'`,
      );
      expect(svcRows).toHaveLength(1);
      expect(svcRows[0]!.exec).toBe(false);
    });
  }, 12_000);

  it("existing private functions: no PUBLIC EXECUTE; anon only the visibility helpers; authenticated also is_owner, is_mylife, is_monitor and the CHECK/policy helpers", async () => {
    await withTx(client, async (c) => {
      const rows = await execPrivileges(c, "n.nspname = 'private'");
      const exposed = (key: "public_exec" | "anon_exec" | "authenticated_exec") =>
        rows.filter((r) => r[key]).map((r) => r.fn);

      expect(rows.length).toBeGreaterThan(0);
      // private.is_monitor() arrives with 20261106000200_monitor_schema.sql: pin it where that
      // migration is applied, so the exact list holds both before and after the apply.
      const { rows: target } = await c.query<{ monitor_applied: boolean }>(
        "SELECT to_regprocedure('private.is_monitor()') IS NOT NULL AS monitor_applied",
      );
      const monitorHelper = target[0]!.monitor_applied ? ["is_monitor()"] : [];
      expect(exposed("public_exec")).toEqual([]);
      expect(exposed("anon_exec")).toEqual([
        "category_is_public(p_id uuid)",
        "is_admin()",
        "item_is_public(p_id uuid)",
        "page_is_public(p_id uuid)",
      ]);
      expect(exposed("authenticated_exec")).toEqual([
        "category_is_public(p_id uuid)",
        "external_links_valid(p_links jsonb)",
        "is_admin()",
        ...monitorHelper,
        "is_mylife()",
        "is_owner()",
        "item_is_public(p_id uuid)",
        "media_mime_type(p_path text)",
        "media_path_valid(p_path text)",
        "page_is_public(p_id uuid)",
      ]);
      // The hardening trigger functions exist and nobody but their owner may call them.
      expect(rows.filter((r) => ["media_limit_per_item()", "stamp_updated_by()"].includes(r.fn))).toEqual([
        { fn: "media_limit_per_item()", public_exec: false, anon_exec: false, authenticated_exec: false },
        { fn: "stamp_updated_by()", public_exec: false, anon_exec: false, authenticated_exec: false },
      ]);
    });
  }, 12_000);

  it("AMC-34 / admin RPCs are executable by authenticated only", async () => {
    await withTx(client, async (c) => {
      // Pinned only where the function exists on the target.
      const { rows: probe } = await c.query<{ applied: boolean }>(
        `SELECT to_regprocedure('public.admin_list_monitor_signups()') IS NOT NULL AS applied`,
      );
      const monitorSignups = probe[0]!.applied
        ? [{ fn: "admin_list_monitor_signups()", public_exec: false, anon_exec: false, authenticated_exec: true }]
        : [];

      // AMC-34: admin_delete_monitor_user(uuid) — conditional on migration 20261111000200.
      const { rows: deletePr } = await c.query<{ applied: boolean }>(
        `SELECT to_regprocedure('public.admin_delete_monitor_user(uuid)') IS NOT NULL AS applied`,
      );
      const deleteMonitorUser = deletePr[0]!.applied
        ? [{ fn: "admin_delete_monitor_user(p_user_id uuid)", public_exec: false, anon_exec: false, authenticated_exec: true }]
        : [];

      expect(await execPrivileges(c, "n.nspname = 'public' AND p.proname LIKE 'admin\\_%'")).toEqual([
        {
          fn: "admin_attach_media(p_item_id uuid, p_path text, p_alt_da text, p_alt_en text, p_width integer, p_height integer)",
          public_exec: false,
          anon_exec: false,
          authenticated_exec: true,
        },
        { fn: "admin_check_media_slot(p_item_id uuid)", public_exec: false, anon_exec: false, authenticated_exec: true },
        { fn: "admin_delete_item(p_item_id uuid)", public_exec: false, anon_exec: false, authenticated_exec: true },
        ...deleteMonitorUser,
        { fn: "admin_detach_media(p_media_id uuid)", public_exec: false, anon_exec: false, authenticated_exec: true },
        ...monitorSignups,
        {
          fn: "admin_list_orphan_media(p_older_than interval)",
          public_exec: false,
          anon_exec: false,
          authenticated_exec: true,
        },
        {
          fn: "admin_reorder_items(p_category_id uuid, p_item_ids uuid[])",
          public_exec: false,
          anon_exec: false,
          authenticated_exec: true,
        },
        { fn: "admin_reorder_nav(p_page_ids uuid[])", public_exec: false, anon_exec: false, authenticated_exec: true },
        { fn: "admin_save_category(payload jsonb)", public_exec: false, anon_exec: false, authenticated_exec: true },
        { fn: "admin_save_item(payload jsonb)", public_exec: false, anon_exec: false, authenticated_exec: true },
        { fn: "admin_save_page(payload jsonb)", public_exec: false, anon_exec: false, authenticated_exec: true },
        {
          fn: "admin_set_category_status(p_category_id uuid, p_status content_status)",
          public_exec: false,
          anon_exec: false,
          authenticated_exec: true,
        },
        {
          fn: "admin_set_item_status(p_item_id uuid, p_status content_status)",
          public_exec: false,
          anon_exec: false,
          authenticated_exec: true,
        },
        { fn: "admin_set_page_nav(p_page_id uuid, p_show boolean)", public_exec: false, anon_exec: false, authenticated_exec: true },
        {
          fn: "admin_set_page_status(p_page_id uuid, p_status content_status)",
          public_exec: false,
          anon_exec: false,
          authenticated_exec: true,
        },
      ]);
    });
  }, 12_000);

  // ── PAY1-AC5j/5k: payments function EXECUTE ACLs (e2e project only) ─────────
  // Gated to the e2e project because the payments functions exist only where
  // 20261112000100_payments_foundation.sql has been applied.
  describe.skipIf(!process.env.SUPABASE_E2E_REF)("PAY1 payments function EXECUTE ACLs", () => {
    it("PAY1-AC5j: payments_sync_subscription(jsonb,jsonb) — not executable by PUBLIC, anon or authenticated (service_role only)", async () => {
      await withTx(client, async (c) => {
        expect(
          await execPrivileges(
            c,
            "n.nspname = 'public' AND p.proname = 'payments_sync_subscription'",
          ),
        ).toEqual([
          {
            fn: "payments_sync_subscription(p_event jsonb, p_subscription jsonb)",
            public_exec: false,
            anon_exec: false,
            authenticated_exec: false,
          },
        ]);
      });
    }, 12_000);

    it("PAY1-AC5j: payments_record_subscription_invoice(jsonb,jsonb,jsonb) — not executable by PUBLIC, anon or authenticated", async () => {
      await withTx(client, async (c) => {
        expect(
          await execPrivileges(
            c,
            "n.nspname = 'public' AND p.proname = 'payments_record_subscription_invoice'",
          ),
        ).toEqual([
          {
            fn: "payments_record_subscription_invoice(p_event jsonb, p_subscription jsonb, p_invoice jsonb)",
            public_exec: false,
            anon_exec: false,
            authenticated_exec: false,
          },
        ]);
      });
    }, 12_000);

    it("PAY1-AC5h: my_monitor_limit() — not PUBLIC or anon; authenticated granted", async () => {
      await withTx(client, async (c) => {
        expect(
          await execPrivileges(c, "n.nspname = 'public' AND p.proname = 'my_monitor_limit'"),
        ).toEqual([
          {
            fn: "my_monitor_limit()",
            public_exec: false,
            anon_exec: false,
            authenticated_exec: true,
          },
        ]);
      });
    }, 12_000);

    it("PAY1-AC5k: private.effective_monitor_limit(uuid) — not executable by PUBLIC, anon or authenticated", async () => {
      await withTx(client, async (c) => {
        expect(
          await execPrivileges(
            c,
            "n.nspname = 'private' AND p.proname = 'effective_monitor_limit'",
          ),
        ).toEqual([
          {
            fn: "effective_monitor_limit(p_user_id uuid)",
            public_exec: false,
            anon_exec: false,
            authenticated_exec: false,
          },
        ]);
      });
    }, 12_000);

    it("PAY1-AC5j-service_role: payments_sync_subscription and payments_record_subscription_invoice — service_role EXECUTE = true", async () => {
      await withTx(client, async (c) => {
        for (const fnName of [
          "payments_sync_subscription",
          "payments_record_subscription_invoice",
        ] as const) {
          const { rows } = await c.query<{ exec: boolean }>(
            `SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') AS exec
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = $1`,
            [fnName],
          );
          expect(rows).toHaveLength(1);
          expect(rows[0]!.exec).toBe(true);
        }
      });
    }, 12_000);

    it("PAY1-AC5k-service_role: private functions with service_role EXECUTE are exactly the four granted", async () => {
      await withTx(client, async (c) => {
        const { rows } = await c.query<{ fn: string }>(
          `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fn
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'private'
              AND has_function_privilege('service_role', p.oid, 'EXECUTE')
            ORDER BY 1`,
        );
        expect(rows.map((r) => r.fn)).toEqual([
          "effective_monitor_limit(p_user_id uuid)",
          "payments_apply_subscription(p_event jsonb, p_subscription jsonb, OUT outcome text, OUT account_id uuid)",
          "payments_pause_over_cap(p_user_id uuid)",
          "payments_valid_timestamptz(p_value text)",
        ]);
      });
    }, 12_000);
  });
});
