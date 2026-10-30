/**
 * Integration tests — Before-User-Created hook and on_auth_user_created trigger.
 *
 * Covers F0.4 acceptance:
 *   - hook rejects a non-allowlisted email (returns 403 error jsonb)
 *   - hook accepts an allowlisted email (returns empty jsonb {}), also when the incoming
 *     email differs in case / surrounding whitespace (matched on lower(btrim(email)))
 *   - only supabase_auth_admin can execute the hook (anon / authenticated / PUBLIC cannot)
 *     and supabase_auth_admin can read user_allowlist through RLS
 *   - trigger assigns role from user_allowlist when an auth.users row is inserted
 *     (case-insensitively), and role = NULL when the email is not allowlisted
 *
 * Why supabase_auth_admin is checked through the catalog: GoTrue calls the hook as
 * supabase_auth_admin, but on Supabase cloud `postgres` is not a superuser and
 * membership in supabase_auth_admin is reserved (GRANT → 42501 "role memberships are
 * reserved, only superusers can grant them"), so `SET ROLE supabase_auth_admin` is
 * impossible from a test connection. The hook is SECURITY INVOKER, so the role's
 * effective privileges (EXECUTE, schema USAGE, table SELECT, a permissive RLS policy —
 * the role has no BYPASSRLS) are the complete authorisation chain and are asserted
 * against the real role below. The hook's matching logic runs as postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import { withTx } from "./helpers/roles.js";

// Unique emails prevent cross-test collisions inside rolled-back transactions
const LISTED_EMAIL = "listed-hook-test@test.local";
const UNLISTED_EMAIL = "unlisted-hook-test@test.local";
const HOOK = "public.hook_before_user_created(jsonb)";

async function callHook(c: PoolClient, email: string): Promise<Record<string, unknown>> {
  const { rows } = await c.query<{ result: Record<string, unknown> }>(
    "SELECT public.hook_before_user_created($1::jsonb) AS result",
    [JSON.stringify({ user: { email } })],
  );
  return rows[0]!.result;
}

async function insertAuthUser(c: PoolClient, id: string, email: string): Promise<void> {
  await c.query(
    `INSERT INTO auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at,
                             raw_app_meta_data, raw_user_meta_data, is_super_admin, encrypted_password)
     VALUES ($1, 'authenticated', 'authenticated', $2, now(), now(), now(), '{}', '{}', false, '')`,
    [id, email],
  );
}

describe.skipIf(!DB_AVAILABLE)("RLS — Before-User-Created hook + trigger", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // hook_before_user_created — matching logic
  // --------------------------------------------------------------------------

  it("hook: non-allowlisted email returns error jsonb with http_code 403", async () => {
    await withTx(client, async (c) => {
      const result = await callHook(c, UNLISTED_EMAIL);
      expect(result).toEqual({
        error: { http_code: 403, message: "Adgang kræver en invitation." },
      });
    });
  }, 12_000);

  it("hook: allowlisted email returns empty jsonb {}", async () => {
    await withTx(client, async (c) => {
      await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'admin')", [LISTED_EMAIL]);
      expect(await callHook(c, LISTED_EMAIL)).toEqual({});
    });
  }, 12_000);

  it("hook: allowlisted email in upper case with surrounding whitespace returns {}", async () => {
    await withTx(client, async (c) => {
      await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'admin')", [LISTED_EMAIL]);
      expect(await callHook(c, "  Listed-Hook-TEST@Test.Local  ")).toEqual({});
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // hook_before_user_created — who may run it (see header for the catalog approach)
  // --------------------------------------------------------------------------

  it("hook: anon, authenticated and PUBLIC cannot execute it", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{ anon: boolean; authenticated: boolean; public: boolean }>(
        `SELECT has_function_privilege('anon', $1::regprocedure, 'EXECUTE')          AS anon,
                has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated,
                has_function_privilege('public', $1::regprocedure, 'EXECUTE')        AS public`,
        [HOOK],
      );
      expect(rows[0]).toEqual({ anon: false, authenticated: false, public: false });
    });
  }, 12_000);

  it("hook: supabase_auth_admin can execute it and read user_allowlist through RLS", async () => {
    await withTx(client, async (c) => {
      const { rows } = await c.query<{
        can_execute: boolean;
        schema_usage: boolean;
        table_select: boolean;
        security_definer: boolean;
        rls_enabled: boolean;
        role_bypasses_rls: boolean;
      }>(
        `SELECT has_function_privilege('supabase_auth_admin', $1::regprocedure, 'EXECUTE')   AS can_execute,
                has_schema_privilege('supabase_auth_admin', 'public', 'USAGE')               AS schema_usage,
                has_table_privilege('supabase_auth_admin', 'public.user_allowlist', 'SELECT') AS table_select,
                (SELECT prosecdef FROM pg_proc WHERE oid = $1::regprocedure)                  AS security_definer,
                (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_allowlist'::regclass) AS rls_enabled,
                (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'supabase_auth_admin')     AS role_bypasses_rls`,
        [HOOK],
      );
      expect(rows[0]).toEqual({
        can_execute: true,
        schema_usage: true,
        table_select: true,
        security_definer: false, // runs with the caller's (supabase_auth_admin's) privileges
        rls_enabled: true,
        role_bypasses_rls: false, // so a policy for the role is required …
      });

      // … and it exists: a permissive SELECT policy for supabase_auth_admin that admits every row.
      const policies = await c.query<{ policyname: string; permissive: string; cmd: string; qual: string }>(
        `SELECT policyname, permissive, cmd, qual FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'user_allowlist'
            AND 'supabase_auth_admin' = ANY (roles)`,
      );
      expect(policies.rows).toEqual([
        { policyname: "user_allowlist_auth_hook", permissive: "PERMISSIVE", cmd: "SELECT", qual: "true" },
      ]);
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // on_auth_user_created trigger
  // --------------------------------------------------------------------------

  it("trigger: creates profiles row with correct role when email is in user_allowlist", async () => {
    await withTx(client, async (c) => {
      const userId = "00000000-0000-0000-aaaa-000000000010";
      // Seed allowlist BEFORE inserting auth user (trigger reads it)
      await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'admin')", [LISTED_EMAIL]);
      await insertAuthUser(c, userId, LISTED_EMAIL);

      const { rows } = await c.query<{ role: string | null }>(
        "SELECT role FROM public.profiles WHERE user_id = $1",
        [userId],
      );
      expect(rows).toEqual([{ role: "admin" }]);
    });
  }, 12_000);

  it("trigger: matches the allowlist case-insensitively and stores the email lower-cased", async () => {
    await withTx(client, async (c) => {
      const userId = "00000000-0000-0000-aaaa-000000000012";
      await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'admin')", [LISTED_EMAIL]);
      await insertAuthUser(c, userId, "Listed-Hook-TEST@Test.Local");

      const { rows } = await c.query<{ email: string; role: string | null }>(
        "SELECT email, role FROM public.profiles WHERE user_id = $1",
        [userId],
      );
      expect(rows).toEqual([{ email: LISTED_EMAIL, role: "admin" }]);
    });
  }, 12_000);

  it("trigger: creates profiles row with role=NULL when email is not in user_allowlist", async () => {
    await withTx(client, async (c) => {
      const userId = "00000000-0000-0000-aaaa-000000000011";
      await insertAuthUser(c, userId, UNLISTED_EMAIL);

      const { rows } = await c.query<{ role: string | null }>(
        "SELECT role FROM public.profiles WHERE user_id = $1",
        [userId],
      );
      expect(rows).toEqual([{ role: null }]);
    });
  }, 12_000);
});
