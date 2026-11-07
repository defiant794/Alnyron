/**
 * Integration tests — Before-User-Created hook (0400 semantics) and
 * on_auth_user_created trigger (0400 semantics).
 *
 * Migration 20261106000400_monitor_public_signup.sql changes the hook and trigger
 * semantics from F0.4 (allowlist = admit; non-allowlist = reject) to 0400
 * (allowlist = REJECT on every hook path; non-allowlist = ADMIT as monitor_user).
 *
 * These tests are RED until migration 0400 is applied to the target DB.
 * Run against the isolated e2e project via:
 *   npm run test:integration:e2e-project -- tests/integration/rls/rls-auth-hook.test.ts
 *
 * The supabase_auth_admin privilege checks are unchanged (the hook still requires
 * the same EXECUTE / schema USAGE / table SELECT grants and the same RLS policy).
 *
 * Why supabase_auth_admin is checked through the catalog: GoTrue calls the hook as
 * supabase_auth_admin, but on Supabase cloud `postgres` is not a superuser and
 * membership in supabase_auth_admin is reserved, so `SET ROLE supabase_auth_admin`
 * is impossible from a test connection. The hook is SECURITY INVOKER, so the role's
 * effective privileges are the complete authorisation chain and are asserted via
 * the catalog below.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_AVAILABLE, getClient, type PoolClient } from "./helpers/db.js";
import { withTx } from "./helpers/roles.js";

// Unique emails prevent cross-test collisions inside rolled-back transactions.
// Under 0400: LISTED_EMAIL (in user_allowlist) → REJECTED; UNLISTED_EMAIL → ADMITTED.
const LISTED_EMAIL = "listed-hook-test@test.local";
const UNLISTED_EMAIL = "unlisted-hook-test@test.local";
const HOOK = "public.hook_before_user_created(jsonb)";

async function callHook(c: PoolClient, email: string, userMeta: Record<string, unknown> = {}, appMeta: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { rows } = await c.query<{ result: Record<string, unknown> }>(
    "SELECT public.hook_before_user_created($1::jsonb) AS result",
    [JSON.stringify({ user: { email, user_metadata: userMeta, app_metadata: appMeta } })],
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

describe.skipIf(!DB_AVAILABLE)("RLS — Before-User-Created hook + trigger (0400 semantics)", () => {
  let client: PoolClient;

  beforeAll(async () => {
    client = await getClient();
  });

  afterAll(async () => {
    client.release();
  });

  // --------------------------------------------------------------------------
  // MON-AC52: hook rejects ALLOWLISTED emails — including with metadata spoofs
  // --------------------------------------------------------------------------

  it("MON-AC52a: hook rejects an allowlisted email with http_code 403", async () => {
    await withTx(client, async (c) => {
      await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'admin')", [LISTED_EMAIL]);
      const result = await callHook(c, LISTED_EMAIL);
      expect(result).toMatchObject({ error: { http_code: 403 } });
    });
  }, 12_000);

  it("MON-AC52b: hook rejects allowlisted email with area:'admin' metadata spoof", async () => {
    await withTx(client, async (c) => {
      await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'admin')", [LISTED_EMAIL]);
      const result = await callHook(c, LISTED_EMAIL, { area: "admin" });
      expect(result).toMatchObject({ error: { http_code: 403 } });
    });
  }, 12_000);

  it("MON-AC52c: hook rejects allowlisted email with invited:true metadata spoof", async () => {
    await withTx(client, async (c) => {
      await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'admin')", [LISTED_EMAIL]);
      const result = await callHook(c, LISTED_EMAIL, { invited: true });
      expect(result).toMatchObject({ error: { http_code: 403 } });
    });
  }, 12_000);

  it("MON-AC52e: hook rejects allowlisted email with app_metadata spoof {role:'admin'}", async () => {
    await withTx(client, async (c) => {
      await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'admin')", [LISTED_EMAIL]);
      const result = await callHook(c, LISTED_EMAIL, {}, { role: "admin" });
      expect(result).toMatchObject({ error: { http_code: 403 } });
    });
  }, 12_000);

  it("MON-AC52d: hook rejects allowlisted email in upper case / whitespace (generic message)", async () => {
    await withTx(client, async (c) => {
      await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'admin')", [LISTED_EMAIL]);
      const result = await callHook(c, "  Listed-Hook-TEST@Test.Local  ");
      expect(result).toMatchObject({ error: { http_code: 403 } });
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // MON-AC53: hook ADMITS non-allowlisted emails (public monitor signup)
  // --------------------------------------------------------------------------

  it("MON-AC53a: hook admits a non-allowlisted email (returns {})", async () => {
    await withTx(client, async (c) => {
      const result = await callHook(c, UNLISTED_EMAIL);
      expect(result).toEqual({});
    });
  }, 12_000);

  it("MON-AC53b: hook admits unlisted email even with metadata payload", async () => {
    await withTx(client, async (c) => {
      const result = await callHook(c, UNLISTED_EMAIL, { area: "admin", invited: true });
      expect(result).toEqual({});
    });
  }, 12_000);

  // --------------------------------------------------------------------------
  // hook privilege assertions (unchanged from F0.4)
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
        `SELECT has_function_privilege('supabase_auth_admin', $1::regprocedure, 'EXECUTE')    AS can_execute,
                has_schema_privilege('supabase_auth_admin', 'public', 'USAGE')                AS schema_usage,
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
        security_definer: false,
        rls_enabled: true,
        role_bypasses_rls: false,
      });

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
  // MON-AC53: on_auth_user_created trigger → role = 'monitor_user' for unlisted
  // --------------------------------------------------------------------------

  it("MON-AC53c: trigger creates profiles row with role='monitor_user' for non-allowlisted email", async () => {
    await withTx(client, async (c) => {
      const userId = "00000000-0000-0000-aaaa-000000000020";
      await insertAuthUser(c, userId, UNLISTED_EMAIL);

      const { rows } = await c.query<{ role: string | null }>(
        "SELECT role FROM public.profiles WHERE user_id = $1",
        [userId],
      );
      expect(rows).toEqual([{ role: "monitor_user" }]);
    });
  }, 12_000);

  it("MON-AC53d: trigger sets monitor_limit to column default (5) for monitor_user", async () => {
    await withTx(client, async (c) => {
      const userId = "00000000-0000-0000-aaaa-000000000021";
      await insertAuthUser(c, userId, UNLISTED_EMAIL);

      const { rows } = await c.query<{ monitor_limit: number | null }>(
        "SELECT monitor_limit FROM public.profiles WHERE user_id = $1",
        [userId],
      );
      expect(rows).toEqual([{ monitor_limit: 5 }]);
    });
  }, 12_000);

  it("MON-AC57a: trigger still assigns allowlist role for a seeded allowlist email (admin.createUser path)", async () => {
    await withTx(client, async (c) => {
      const userId = "00000000-0000-0000-aaaa-000000000022";
      // Seed allowlist first (admin.createUser doesn't fire the hook, but handle_new_user reads allowlist)
      await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'admin')", [LISTED_EMAIL]);
      await insertAuthUser(c, userId, LISTED_EMAIL);

      const { rows } = await c.query<{ role: string | null }>(
        "SELECT role FROM public.profiles WHERE user_id = $1",
        [userId],
      );
      expect(rows).toEqual([{ role: "admin" }]);
    });
  }, 12_000);

  it("MON-AC57b: trigger matches the allowlist case-insensitively and stores email lower-cased (admin path)", async () => {
    await withTx(client, async (c) => {
      const userId = "00000000-0000-0000-aaaa-000000000023";
      await c.query("INSERT INTO public.user_allowlist (email, role) VALUES ($1, 'admin')", [LISTED_EMAIL]);
      await insertAuthUser(c, userId, "Listed-Hook-TEST@Test.Local");

      const { rows } = await c.query<{ email: string; role: string | null }>(
        "SELECT email, role FROM public.profiles WHERE user_id = $1",
        [userId],
      );
      expect(rows).toEqual([{ email: LISTED_EMAIL, role: "admin" }]);
    });
  }, 12_000);
});
