/**
 * Integration tests — monitor_wipe_password_on_resignup trigger
 * (migration 20261110000100_monitor_signup_notice.sql)
 * Journey: monitor-signup-notice  SNE-AC3f-k
 *
 * e2e project ONLY. The whole suite is gated on SUPABASE_E2E_REF (not DB_AVAILABLE):
 * once the trigger reaches production, running auth.users UPDATEs there is not acceptable.
 * assertE2eTarget() is called first in beforeAll to verify the env points at the e2e project.
 *
 * SET LOCAL ROLE supabase_auth_admin is not possible from the pool connection:
 * postgres is not a member of supabase_auth_admin on Supabase cloud; membership in that
 * role is reserved there. All auth.users UPDATEs
 * in this file run as postgres. The trigger fires regardless of caller:
 *   - tgenabled = 'O'  (fires in origin session_replication_role, the default for all connections)
 *   - prosecdef = true  (SECURITY DEFINER: executes as postgres regardless of invoking role)
 * Live verification: SNE-AC3f-generate-link-live confirms that a live GoTrue
 * generateLink(type=signup) UPDATE fires the trigger (confirmation_sent_at);
 * SNE-AC3k-generate-link-recovery-live confirms the recovery_sent_at branch; SNE-AC3j asserts
 * the catalog invariants.
 *
 * pgcrypto: extensions.crypt(text,text) is available in the extensions schema.
 * All tests use real bcrypt hashes; a CASE guard avoids passing an empty-string salt after a wipe.
 *
 * SNE-AC3f-generate-link-live confirms via live admin.auth.admin.generateLink(type=signup) calls:
 *   First send  (confirmation_sent_at was NULL):  password not wiped after generateLink
 *               (explanation: trigger fires, condition false — old IS NULL guard).
 *   Re-send     (confirmation_sent_at was set):   password wiped to '' after generateLink
 *               (trigger fires: old IS NOT NULL guard, wipe executes).
 * Column changes per sequence are from the Journey C GoTrue background (adminGenerateLink
 * note; source reading, hosted version unverified).
 *
 * Run: npm run test:integration:e2e-project -- tests/integration/rls/rls-monitor-resignup-wipe.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { getClient, endPool, type PoolClient } from "./helpers/db.js";
import { withTx, type AppRole } from "./helpers/roles.js";
import { assertE2eTarget } from "../../helpers/assert-e2e-target.js";

const ON_E2E_PROJECT = !!process.env.SUPABASE_E2E_REF;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";

const WIPE_FN_SIG   = "private.monitor_wipe_password_on_resignup()";
const TRIGGER_NAME  = "monitor_wipe_password_on_resignup";
const MIGRATION_MSG = "apply 20261110000100_monitor_signup_notice.sql";

// Fixed UUIDs for this file (used only inside rolled-back transactions)
const WIPE_UUID_1  = "00000000-0000-0000-0000-000000005f01"; // f-keep-first
const WIPE_UUID_2  = "00000000-0000-0000-0000-000000005f02"; // f-updatepassword-wipe
const WIPE_UUID_3  = "00000000-0000-0000-0000-000000005f03"; // g-first-send
const WIPE_UUID_4  = "00000000-0000-0000-0000-000000005f04"; // h-confirmed-unchanged
const WIPE_UUID_5  = "00000000-0000-0000-0000-000000005f05"; // h-confirming-update
const WIPE_UUID_10 = "00000000-0000-0000-0000-000000005f10"; // i-owner
const WIPE_UUID_11 = "00000000-0000-0000-0000-000000005f11"; // i-admin
const WIPE_UUID_12 = "00000000-0000-0000-0000-000000005f12"; // i-mylife_user
const WIPE_UUID_13 = "00000000-0000-0000-0000-000000005f13"; // i-null-role
const WIPE_UUID_14 = "00000000-0000-0000-0000-000000005f14"; // f-edge-a
const WIPE_UUID_16 = "00000000-0000-0000-0000-000000005f16"; // f-edge-a-clearall
const WIPE_UUID_15 = "00000000-0000-0000-0000-000000005f15"; // f-edge-b

const WIPE_EMAIL_1  = "wipe-rls-f1@test.local";
const WIPE_EMAIL_2  = "wipe-rls-f2@test.local";
const WIPE_EMAIL_3  = "wipe-rls-g@test.local";
const WIPE_EMAIL_4  = "wipe-rls-h1@test.local";
const WIPE_EMAIL_5  = "wipe-rls-h2@test.local";
const WIPE_EMAIL_10 = "wipe-rls-i-owner@test.local";
const WIPE_EMAIL_11 = "wipe-rls-i-admin@test.local";
const WIPE_EMAIL_12 = "wipe-rls-i-mylife@test.local";
const WIPE_EMAIL_13 = "wipe-rls-i-null@test.local";
const WIPE_EMAIL_14 = "wipe-rls-f-cost@test.local";
const WIPE_EMAIL_15 = "wipe-rls-f-null@test.local";
const WIPE_EMAIL_16 = "wipe-rls-f-edgea-clear@test.local";
const WIPE_UUID_20 = "00000000-0000-0000-0000-000000005f20"; // k-wipe-recovery-null-to-now
const WIPE_UUID_21 = "00000000-0000-0000-0000-000000005f21"; // k-wipe-recovery-earlier-to-later
const WIPE_UUID_22 = "00000000-0000-0000-0000-000000005f22"; // k-no-wipe-recovery-confirmed
const WIPE_UUID_23 = "00000000-0000-0000-0000-000000005f23"; // k-no-wipe-recovery-owner
const WIPE_UUID_24 = "00000000-0000-0000-0000-000000005f24"; // k-no-wipe-recovery-admin
const WIPE_UUID_25 = "00000000-0000-0000-0000-000000005f25"; // k-no-wipe-recovery-mylife_user
const WIPE_UUID_26 = "00000000-0000-0000-0000-000000005f26"; // k-no-wipe-recovery-null-role
const WIPE_UUID_27 = "00000000-0000-0000-0000-000000005f27"; // k-updatepassword-also-sets-recovery-null

const WIPE_EMAIL_20 = "wipe-rls-k-rec-null@test.local";
const WIPE_EMAIL_21 = "wipe-rls-k-rec-earlier@test.local";
const WIPE_EMAIL_22 = "wipe-rls-k-rec-confirmed@test.local";
const WIPE_EMAIL_23 = "wipe-rls-k-rec-owner@test.local";
const WIPE_EMAIL_24 = "wipe-rls-k-rec-admin@test.local";
const WIPE_EMAIL_25 = "wipe-rls-k-rec-mylife@test.local";
const WIPE_EMAIL_26 = "wipe-rls-k-rec-null-role@test.local";
const WIPE_EMAIL_27 = "wipe-rls-k-rec-updatepw@test.local";


const OLD_CONF_SENT_AT = "2026-01-01 10:00:00+00";
const NEW_CONF_SENT_AT = "2026-06-01 12:00:00+00";
const OLD_RECOVERY_SENT_AT = "2026-01-01 11:00:00+00";
const NEW_RECOVERY_SENT_AT = "2026-06-01 13:00:00+00";


// ── Probe result (set by beforeAll) ──────────────────────────────────────────

interface WipeTarget { fnExists: boolean; triggerExists: boolean; }
let client: PoolClient;
let wipeTarget: WipeTarget;

// Persistent user created by the live GoTrue test; deleted in afterAll.
let liveTestUserId: string | undefined;
// Persistent user created by the live recovery-GoTrue test; deleted in afterAll.
let liveRecoveryTestUserId: string | undefined;


// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAdminClient() {
  return createClient(SUPABASE_URL, SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * Seed an UNCONFIRMED auth.users row (email_confirmed_at = NULL).
 * on_auth_user_created fires and creates the profiles row (role determined by user_allowlist).
 * The wipe trigger fires only on UPDATE OF confirmation_sent_at / recovery_sent_at, not on INSERT.
 */
async function seedUnconfirmedUser(
  c: PoolClient,
  userId: string,
  email: string,
  appRole: AppRole | undefined,
  confirmationSentAt: string | null,
  encryptedPassword: string,
  recoverySentAt?: string | null,
): Promise<void> {
  if (appRole) {
    await c.query(
      `INSERT INTO public.user_allowlist (email, role) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`,
      [email, appRole],
    );
  }
  await c.query(
    `INSERT INTO auth.users
       (id, aud, role, email, email_confirmed_at, confirmation_sent_at, recovery_sent_at,
        created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
        is_super_admin, encrypted_password)
     VALUES (
       $1, 'authenticated', 'authenticated', $2,
       NULL,
       $3::timestamptz,
       $5::timestamptz,
       now(), now(), '{}'::jsonb, '{}'::jsonb, false, $4
     )`,
    [userId, email, confirmationSentAt, encryptedPassword, recoverySentAt ?? null],
  );
}


/**
 * Seed an UNCONFIRMED null-role user: no allowlist row (gets monitor_user), then
 * clear profile role to NULL. Used for case i (null-role guard).
 */
async function seedUnconfirmedRolelessUser(
  c: PoolClient,
  userId: string,
  email: string,
  encryptedPassword: string,
): Promise<void> {
  await c.query(
    `INSERT INTO auth.users
       (id, aud, role, email, email_confirmed_at, confirmation_sent_at,
        created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
        is_super_admin, encrypted_password)
     VALUES ($1, 'authenticated', 'authenticated', $2,
             NULL, $3::timestamptz, now(), now(), '{}'::jsonb, '{}'::jsonb, false, $4)`,
    [userId, email, OLD_CONF_SENT_AT, encryptedPassword],
  );
  const { rowCount } = await c.query(
    "UPDATE public.profiles SET role = NULL WHERE user_id = $1",
    [userId],
  );
  if (rowCount !== 1)
    throw new Error(`seedUnconfirmedRolelessUser: no profiles row for ${userId}`);
}

/** Assert the profiles row has the expected role; prevents vacuous pass when seeding went wrong. */
async function assertProfileRole(
  c: PoolClient,
  userId: string,
  expectedRole: "monitor_user" | AppRole | null,
): Promise<void> {
  const { rows } = await c.query<{ role: string | null }>(
    "SELECT role FROM public.profiles WHERE user_id = $1",
    [userId],
  );
  expect(rows, `profiles row not found for ${userId}`).toHaveLength(1);
  expect(rows[0]!.role, `profile role for ${userId}`).toBe(expectedRole);
}

/** Read encrypted_password from auth.users (as postgres). */
async function readPw(c: PoolClient, userId: string): Promise<string> {
  const { rows } = await c.query<{ pw: string }>(
    "SELECT encrypted_password AS pw FROM auth.users WHERE id = $1",
    [userId],
  );
  expect(rows, `auth.users row not found for ${userId}`).toHaveLength(1);
  return rows[0]!.pw;
}

/**
 * Generate a real bcrypt hash using pgcrypto (cost 4 for speed).
 * extensions.crypt(text,text) is available in the extensions schema.
 */
async function bcryptHash(c: PoolClient, password: string): Promise<string> {
  const { rows } = await c.query<{ h: string }>(
    "SELECT extensions.crypt($1, extensions.gen_salt('bf', 4)) AS h",
    [password],
  );
  return rows[0]!.h;
}

/**
 * Verify stored password using pgcrypto. CASE guard avoids `crypt(pw, '')` invalid-salt
 * when encrypted_password has been wiped to ''. Returns false in that case.
 */
async function pgcryptMatches(
  c: PoolClient,
  userId: string,
  password: string,
): Promise<boolean> {
  const { rows } = await c.query<{ matches: boolean }>(
    `SELECT
       CASE WHEN pw = '' THEN false
            ELSE extensions.crypt($2, pw) = pw
       END AS matches
     FROM (SELECT encrypted_password AS pw FROM auth.users WHERE id = $1) t`,
    [userId, password],
  );
  return rows[0]!.matches;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

describe.skipIf(!ON_E2E_PROJECT)(
  "monitor_wipe_password_on_resignup trigger (e2e project only, SNE-AC3f-k)",
  () => {
    beforeAll(async () => {
      // assertE2eTarget first — before any DB connection — to prevent accidental prod targeting
      assertE2eTarget();

      client = await getClient();

      // Probe: function + trigger presence
      const { rows: fnRows } = await client.query<{ fn: string | null }>(
        `SELECT to_regprocedure($1::text)::text AS fn`,
        [WIPE_FN_SIG],
      );
      const { rows: tgRows } = await client.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'auth' AND c.relname = 'users'
            AND t.tgname = $1`,
        [TRIGGER_NAME],
      );

      wipeTarget = {
        fnExists: fnRows[0]?.fn != null,
        triggerExists: tgRows.length > 0,
      };

      // On the e2e project both must exist — throw so every test reports the migration message
      if (!wipeTarget.fnExists || !wipeTarget.triggerExists) {
        throw new Error(
          `${TRIGGER_NAME} trigger or ${WIPE_FN_SIG} not found on e2e project — ${MIGRATION_MSG}`,
        );
      }
    });

    afterAll(async () => {
      // Best-effort cleanup of persistent live-test users
      const admin = makeAdminClient();
      if (liveTestUserId) {
        await admin.auth.admin.deleteUser(liveTestUserId).catch(() => {});
        liveTestUserId = undefined;
      }
      if (liveRecoveryTestUserId) {
        await admin.auth.admin.deleteUser(liveRecoveryTestUserId).catch(() => {});
        liveRecoveryTestUserId = undefined;
      }
      client?.release();
      await endPool();
    });

    // ── SNE-AC3f: re-send wipes encrypted_password (keep-first path) ─────────

    it(
      "SNE-AC3f-wipe-keep-first: keep-first path — only confirmation_sent_at changes, trigger wipes password",
      async () => {
        await withTx(client, async (c) => {
          const attackerHash = await bcryptHash(c, "attacker-pw");
          await seedUnconfirmedUser(c, WIPE_UUID_1, WIPE_EMAIL_1, undefined, OLD_CONF_SENT_AT, attackerHash);
          await assertProfileRole(c, WIPE_UUID_1, "monitor_user");

          // Control: attacker's password verifies before the wipe
          expect(await pgcryptMatches(c, WIPE_UUID_1, "attacker-pw")).toBe(true);

          // Keep-first: only confirmation_sent_at changes (no encrypted_password update)
          await c.query(
            `UPDATE auth.users
               SET confirmation_sent_at = $2::timestamptz, confirmation_token = 'new-token'
             WHERE id = $1`,
            [WIPE_UUID_1, NEW_CONF_SENT_AT],
          );

          const pw = await readPw(c, WIPE_UUID_1);
          expect(pw, "encrypted_password must be '' after wipe (keep-first)").toBe("");
          expect(await pgcryptMatches(c, WIPE_UUID_1, "attacker-pw")).toBe(false);
        });
      },
      15_000,
    );

    // ── SNE-AC3f: UpdatePassword shape wipes password (master path, two-step) ─

    it(
      "SNE-AC3f-wipe-updatepassword: master-path UpdatePassword shape (non-NULL→NULL) wipes encrypted_password to ''; sendConfirmation shape (NULL→now) leaves ''",
      async () => {
        await withTx(client, async (c) => {
          const attackerHash = await bcryptHash(c, "attacker-pw");
          await seedUnconfirmedUser(c, WIPE_UUID_2, WIPE_EMAIL_2, undefined, OLD_CONF_SENT_AT, attackerHash);
          await assertProfileRole(c, WIPE_UUID_2, "monitor_user");

          // Control: attacker's password verifies before the UpdatePassword
          expect(await pgcryptMatches(c, WIPE_UUID_2, "attacker-pw")).toBe(true);

          // Step 1 — GoTrue User.UpdatePassword shape:
          // writes encrypted_password + confirmation_token + confirmation_sent_at = NULL in ONE UPDATE.
          // old.confirmation_sent_at IS NOT NULL (prior send) → trigger fires → wipes encrypted_password to ''.
          const newHash = await bcryptHash(c, "new-pw-updatepassword");
          await c.query(
            `UPDATE auth.users
               SET encrypted_password = $2, confirmation_token = '', confirmation_sent_at = NULL
             WHERE id = $1`,
            [WIPE_UUID_2, newHash],
          );

          const pw1 = await readPw(c, WIPE_UUID_2);
          expect(pw1, "encrypted_password must be '' after UpdatePassword wipe (step 1, non-NULL→NULL)").toBe("");
          expect(await pgcryptMatches(c, WIPE_UUID_2, "attacker-pw")).toBe(false);
          expect(await pgcryptMatches(c, WIPE_UUID_2, "new-pw-updatepassword")).toBe(false);

          // Step 2 — GoTrue sendConfirmation shape:
          // writes confirmation_token + confirmation_sent_at = now(). old IS NULL → trigger fires, condition false.
          await c.query(
            `UPDATE auth.users
               SET confirmation_token = 'send-token-2', confirmation_sent_at = $2::timestamptz
             WHERE id = $1`,
            [WIPE_UUID_2, NEW_CONF_SENT_AT],
          );

          const pw2 = await readPw(c, WIPE_UUID_2);
          expect(pw2, "encrypted_password must still be '' after sendConfirmation (NULL→now, trigger fires, wipe does not execute)").toBe("");
        });
      },
      15_000,
    );

    // ── SNE-AC3f edge (a): admin password/email/phone change without `email_confirm` on unconfirmed with prior send empties password (accepted cost) ─

    it(
      "SNE-AC3f-edge-a: UpdatePassword shape (admin password change) on unconfirmed monitor_user with prior send empties the password — accepted design cost",
      async () => {
        await withTx(client, async (c) => {
          const originalHash = await bcryptHash(c, "original-pw");
          await seedUnconfirmedUser(c, WIPE_UUID_14, WIPE_EMAIL_14, undefined, OLD_CONF_SENT_AT, originalHash);
          await assertProfileRole(c, WIPE_UUID_14, "monitor_user");

          // UpdatePassword shape: new hash + confirmation_token='' + confirmation_sent_at=NULL.
          // old.confirmation_sent_at IS NOT NULL → trigger fires → wipes encrypted_password to ''.
          // Accepted cost: an admin password, email or phone change on an unconfirmed monitor_user
          // that already had a confirmation sent empties the password (an admin update that also sets
          // `email_confirm` confirms the address first, so it wipes nothing). Pins this accepted design cost.
          const newHash = await bcryptHash(c, "new-legitimate-pw");
          await c.query(
            `UPDATE auth.users
               SET encrypted_password = $2, confirmation_token = '', confirmation_sent_at = NULL
             WHERE id = $1`,
            [WIPE_UUID_14, newHash],
          );

          const pw = await readPw(c, WIPE_UUID_14);
          expect(pw, "encrypted_password must be '' even on a legitimate password change (accepted cost)").toBe("");
          expect(await pgcryptMatches(c, WIPE_UUID_14, "new-legitimate-pw")).toBe(false);
        });
      },
      15_000,
    );

    // ── SNE-AC3f edge (a)-clearall: ClearAllPendingTokens shape (admin email/phone change without `email_confirm`) empties password (accepted cost) ─

    it(
      "SNE-AC3f-edge-a-clearall: ClearAllPendingTokens shape (admin email/phone change without email_confirm) on unconfirmed monitor_user with prior send empties the password — accepted design cost (source reading at v2.197.0 and master; hosted version unverified)",
      async () => {
        await withTx(client, async (c) => {
          const originalHash = await bcryptHash(c, "original-pw-clearall");
          await seedUnconfirmedUser(c, WIPE_UUID_16, WIPE_EMAIL_16, undefined, OLD_CONF_SENT_AT, originalHash);
          await assertProfileRole(c, WIPE_UUID_16, "monitor_user");

          // ClearAllPendingTokens shape (admin.go:351-355): confirmation_token='' + confirmation_sent_at=NULL.
          // No new encrypted_password written. old.confirmation_sent_at IS NOT NULL → trigger fires → wipes to ''.
          // Source reading at v2.197.0 and master; hosted version unverified.
          await c.query(
            `UPDATE auth.users
               SET confirmation_token = '', confirmation_sent_at = NULL
             WHERE id = $1`,
            [WIPE_UUID_16],
          );

          const pw = await readPw(c, WIPE_UUID_16);
          expect(pw, "encrypted_password must be '' after ClearAllPendingTokens wipe (SNE-AC3f-edge-a)").toBe("");
          expect(await pgcryptMatches(c, WIPE_UUID_16, "original-pw-clearall")).toBe(false);
        });
      },
      15_000,
    );


    // ── SNE-AC3f edge (b): UpdatePassword with confirmation_sent_at NULL keeps password (accepted residual) ─

    it(
      "SNE-AC3f-edge-b: account that never sent a confirmation (confirmation_sent_at NULL) — the password written by UpdatePassword is not wiped; accepted residual bounded by a recovery send (SNE-AC3k) or the 24h purge",
      async () => {
        await withTx(client, async (c) => {
          const existingHash = await bcryptHash(c, "existing-pw-null-sent");
          // Seed with confirmation_sent_at = NULL (account never sent a confirmation, e.g. admin createUser)
          await seedUnconfirmedUser(c, WIPE_UUID_15, WIPE_EMAIL_15, undefined, null, existingHash);
          await assertProfileRole(c, WIPE_UUID_15, "monitor_user");

          // Step 1 — UpdatePassword shape (NULL→NULL): trigger fires, but old IS NULL → condition false → NOT wiped.
          const newHash = await bcryptHash(c, "new-pw-null-sent");
          await c.query(
            `UPDATE auth.users
               SET encrypted_password = $2, confirmation_token = '', confirmation_sent_at = NULL
             WHERE id = $1`,
            [WIPE_UUID_15, newHash],
          );
          const pw1 = await readPw(c, WIPE_UUID_15);
          expect(pw1, "password must NOT be wiped when confirmation_sent_at is NULL→NULL (old IS NULL guard)").not.toBe("");
          expect(pw1, "UpdatePassword hash must be stored (trigger did not wipe)").toBe(newHash);

          // Step 2 — sendConfirmation (NULL→now()): old IS NULL → still not wiped. Password kept.
          await c.query(
            `UPDATE auth.users
               SET confirmation_token = 'send-token-null', confirmation_sent_at = $2::timestamptz
             WHERE id = $1`,
            [WIPE_UUID_15, NEW_CONF_SENT_AT],
          );
          const pw2 = await readPw(c, WIPE_UUID_15);
          expect(pw2, "password must still not be wiped after sendConfirmation (NULL→now)").not.toBe("");
          expect(pw2, "hash must be unchanged after sendConfirmation").toBe(newHash);
        });
      },
      15_000,
    );

    // ── SNE-AC3f: live GoTrue admin path — generateLink re-send wipes password ─

    it(
      "SNE-AC3f-generate-link-live: admin generateLink(type=signup) re-send changes confirmation_sent_at → trigger wipes encrypted_password",
      async () => {
        const admin = makeAdminClient();
        const liveEmail = `wipe-gl-${Date.now()}@alnyron-test.local`;

        // Create an unconfirmed monitor_user (no password, email_confirm: false).
        // GoTrue stores a non-empty encrypted_password even without an explicit password.
        const { data: created, error: createErr } = await admin.auth.admin.createUser({
          email: liveEmail,
          email_confirm: false,
          user_metadata: {},
        });
        if (createErr) throw new Error(`Failed to create live-test user: ${createErr.message}`);
        liveTestUserId = created.user.id;

        try {
          // Control: profile is monitor_user (handle_new_user assigns it for unlisted email)
          const c = await getClient();
          try {
            const { rows: profRows } = await c.query<{ role: string | null }>(
              "SELECT role FROM public.profiles WHERE user_id = $1",
              [liveTestUserId],
            );
            expect(profRows, "profile row not created by trigger").toHaveLength(1);
            expect(profRows[0]!.role, "profile role must be monitor_user").toBe("monitor_user");

            const { rows: pwRows } = await c.query<{ pw: string }>(
              "SELECT encrypted_password AS pw FROM auth.users WHERE id = $1",
              [liveTestUserId],
            );
            const initialPw = pwRows[0]!.pw;
            expect(initialPw, "GoTrue must store a non-empty hash on createUser").not.toBe("");

            // First send: generateLink sets confirmation_sent_at from NULL.
            // old.confirmation_sent_at IS NULL → trigger fires, condition false → password not wiped.
            const { error: link1Err } = await admin.auth.admin.generateLink({
              type: "signup",
              email: liveEmail,
              password: "attacker-pw-live!",
            });
            if (link1Err) throw new Error(`generateLink (first) failed: ${link1Err.message}`);

            const { rows: pw1Rows } = await c.query<{ pw: string; sent_at: string | null }>(
              "SELECT encrypted_password AS pw, (confirmation_sent_at AT TIME ZONE 'UTC')::text AS sent_at FROM auth.users WHERE id = $1",
              [liveTestUserId],
            );
            expect(pw1Rows[0]!.pw, "password must not be wiped by the first send").not.toBe("");
            expect(pw1Rows[0]!.sent_at, "confirmation_sent_at must be set by first generateLink").not.toBeNull();

            // Re-send: generateLink changes confirmation_sent_at (old IS NOT NULL) → trigger fires → wipe.
            const { error: link2Err } = await admin.auth.admin.generateLink({
              type: "signup",
              email: liveEmail,
              password: "attacker-pw-live!",
            });
            if (link2Err) throw new Error(`generateLink (re-send) failed: ${link2Err.message}`);

            const { rows: pw2Rows } = await c.query<{ pw: string }>(
              "SELECT encrypted_password AS pw FROM auth.users WHERE id = $1",
              [liveTestUserId],
            );
            expect(pw2Rows[0]!.pw, "encrypted_password must be '' after trigger wipe on re-send").toBe("");
          } finally {
            c.release();
          }
        } finally {
          // Cleanup regardless of test outcome; afterAll also attempts this as a safety net
          await admin.auth.admin.deleteUser(liveTestUserId).catch(() => {});
          liveTestUserId = undefined;
        }
      },
      30_000,
    );

    // ── SNE-AC3g: first send keeps password (old.confirmation_sent_at IS NULL) ─

    it(
      "SNE-AC3g-wipe-first-send: first confirmation send (confirmation_sent_at was NULL) does NOT wipe the password",
      async () => {
        await withTx(client, async (c) => {
          const originalHash = await bcryptHash(c, "victim-pw");
          await seedUnconfirmedUser(c, WIPE_UUID_3, WIPE_EMAIL_3, undefined, null, originalHash);
          await assertProfileRole(c, WIPE_UUID_3, "monitor_user");

          // First send: old.confirmation_sent_at IS NULL → guard rejects wipe
          await c.query(
            `UPDATE auth.users
               SET confirmation_sent_at = $2::timestamptz, confirmation_token = 'first-token'
             WHERE id = $1`,
            [WIPE_UUID_3, NEW_CONF_SENT_AT],
          );

          const pw = await readPw(c, WIPE_UUID_3);
          expect(pw, "password must NOT be wiped on first send").toBe(originalHash);
          expect(await pgcryptMatches(c, WIPE_UUID_3, "victim-pw")).toBe(true);
        });
      },
      15_000,
    );

    // ── SNE-AC3h: confirmed monitor_user — confirmation_sent_at update does not wipe ─

    it(
      "SNE-AC3h-wipe-confirmed-unchanged: confirmed monitor_user — UPDATE confirmation_sent_at does NOT wipe (old.email_confirmed_at IS NOT NULL)",
      async () => {
        await withTx(client, async (c) => {
          const originalHash = await bcryptHash(c, "confirmed-user-pw");
          // Confirmed user (email_confirmed_at = now()), prior confirmation_sent_at already set.
          // The INSERT fires on_auth_user_created → creates profiles row (monitor_user).
          // The INSERT of confirmation_sent_at does NOT fire BEFORE UPDATE OF confirmation_sent_at.
          await c.query(
            `INSERT INTO auth.users
               (id, aud, role, email, email_confirmed_at, confirmation_sent_at,
                created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
                is_super_admin, encrypted_password)
             VALUES ($1, 'authenticated', 'authenticated', $2,
                     now(), $3::timestamptz, now(), now(), '{}'::jsonb, '{}'::jsonb, false, $4)`,
            [WIPE_UUID_4, WIPE_EMAIL_4, OLD_CONF_SENT_AT, originalHash],
          );
          await assertProfileRole(c, WIPE_UUID_4, "monitor_user");

          // Hypothetical re-send to a confirmed user: trigger fires but old.email_confirmed_at IS NOT NULL
          await c.query(
            `UPDATE auth.users SET confirmation_sent_at = $2::timestamptz WHERE id = $1`,
            [WIPE_UUID_4, NEW_CONF_SENT_AT],
          );

          const pw = await readPw(c, WIPE_UUID_4);
          expect(pw, "confirmed user password must NOT be wiped").toBe(originalHash);
          expect(await pgcryptMatches(c, WIPE_UUID_4, "confirmed-user-pw")).toBe(true);
        });
      },
      15_000,
    );

    it(
      "SNE-AC3h-wipe-confirming-update: the confirming UPDATE (sets email_confirmed_at AND confirmation_sent_at together) does NOT wipe (new.email_confirmed_at IS NOT NULL)",
      async () => {
        await withTx(client, async (c) => {
          const originalHash = await bcryptHash(c, "victim-confirming-pw");
          // Unconfirmed, prior send (all conditions met except new.email_confirmed_at IS NULL)
          await seedUnconfirmedUser(c, WIPE_UUID_5, WIPE_EMAIL_5, undefined, OLD_CONF_SENT_AT, originalHash);
          await assertProfileRole(c, WIPE_UUID_5, "monitor_user");

          // Confirming UPDATE: trigger fires but new.email_confirmed_at IS NOT NULL → not wiped
          await c.query(
            `UPDATE auth.users
               SET email_confirmed_at = now(), confirmation_sent_at = $2::timestamptz
             WHERE id = $1`,
            [WIPE_UUID_5, NEW_CONF_SENT_AT],
          );

          const pw = await readPw(c, WIPE_UUID_5);
          expect(pw, "password must NOT be wiped on the confirming UPDATE").toBe(originalHash);
          expect(await pgcryptMatches(c, WIPE_UUID_5, "victim-confirming-pw")).toBe(true);
        });
      },
      15_000,
    );

    // ── SNE-AC3i: other roles — trigger does not wipe (profile role guard) ──────

    const OTHER_ROLE_CASES: Array<{
      id: string;
      email: string;
      appRole: AppRole | "null-role";
      expectedProfileRole: AppRole | null;
      label: string;
    }> = [
      { id: WIPE_UUID_10, email: WIPE_EMAIL_10, appRole: "owner",       expectedProfileRole: "owner",       label: "owner" },
      { id: WIPE_UUID_11, email: WIPE_EMAIL_11, appRole: "admin",       expectedProfileRole: "admin",       label: "admin" },
      { id: WIPE_UUID_12, email: WIPE_EMAIL_12, appRole: "mylife_user", expectedProfileRole: "mylife_user", label: "mylife_user" },
      { id: WIPE_UUID_13, email: WIPE_EMAIL_13, appRole: "null-role",   expectedProfileRole: null,          label: "null-role" },
    ];

    for (const { id, email, appRole, expectedProfileRole, label } of OTHER_ROLE_CASES) {
      it(
        `SNE-AC3i-wipe-role-${label}: unconfirmed ${label} — UPDATE confirmation_sent_at does NOT wipe (role guard: not monitor_user)`,
        async () => {
          await withTx(client, async (c) => {
            const originalHash = await bcryptHash(c, `${label}-pw`);

            if (appRole === "null-role") {
              await seedUnconfirmedRolelessUser(c, id, email, originalHash);
            } else {
              await seedUnconfirmedUser(c, id, email, appRole as AppRole, OLD_CONF_SENT_AT, originalHash);
            }

            // Non-vacuous: assert the profile actually has the expected role (not monitor_user)
            await assertProfileRole(c, id, expectedProfileRole);

            // Re-send: all trigger conditions are met EXCEPT profile.role = 'monitor_user'
            await c.query(
              `UPDATE auth.users
                 SET confirmation_sent_at = $2::timestamptz, confirmation_token = 'token-${label}'
               WHERE id = $1`,
              [id, NEW_CONF_SENT_AT],
            );

            const pw = await readPw(c, id);
            expect(pw, `password for ${label} must NOT be wiped (role guard)`).toBe(originalHash);
            expect(await pgcryptMatches(c, id, `${label}-pw`)).toBe(true);
          });
        },
        15_000,
      );
    }

    // ── SNE-AC3j: trigger function hardening ────────────────────────────────────

    describe("SNE-AC3j: trigger function hardening (pg_proc + pg_trigger catalog)", () => {
      it("SNE-AC3j-fn-definer: private.monitor_wipe_password_on_resignup() is SECURITY DEFINER", async () => {
        const { rows } = await client.query<{ definer: boolean }>(
          "SELECT prosecdef AS definer FROM pg_proc WHERE oid = $1::regprocedure",
          [WIPE_FN_SIG],
        );
        expect(rows[0]?.definer).toBe(true);
      });

      it("SNE-AC3j-fn-owner: owned by postgres", async () => {
        const { rows } = await client.query<{ owner: string }>(
          "SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = $1::regprocedure",
          [WIPE_FN_SIG],
        );
        expect(rows[0]?.owner).toBe("postgres");
      });

      it("SNE-AC3j-fn-searchpath: proconfig contains search_path=''", async () => {
        const { rows } = await client.query<{ proconfig: string[] | null }>(
          "SELECT proconfig FROM pg_proc WHERE oid = $1::regprocedure",
          [WIPE_FN_SIG],
        );
        expect(rows[0]?.proconfig).toEqual(['search_path=""']);
      });

      it("SNE-AC3j-fn-priv-anon: anon has no EXECUTE", async () => {
        const { rows } = await client.query<{ ok: boolean }>(
          "SELECT has_function_privilege('anon', $1::regprocedure, 'execute') AS ok",
          [WIPE_FN_SIG],
        );
        expect(rows[0]?.ok).toBe(false);
      });

      it("SNE-AC3j-fn-priv-authenticated: authenticated has no EXECUTE", async () => {
        const { rows } = await client.query<{ ok: boolean }>(
          "SELECT has_function_privilege('authenticated', $1::regprocedure, 'execute') AS ok",
          [WIPE_FN_SIG],
        );
        expect(rows[0]?.ok).toBe(false);
      });

      it("SNE-AC3j-fn-priv-public: public has no EXECUTE", async () => {
        const { rows } = await client.query<{ ok: boolean }>(
          "SELECT has_function_privilege('public', $1::regprocedure, 'execute') AS ok",
          [WIPE_FN_SIG],
        );
        expect(rows[0]?.ok).toBe(false);
      });

      it("SNE-AC3j-fn-priv-service-role: service_role has no EXECUTE (private trigger fn not callable directly)", async () => {
        const { rows } = await client.query<{ ok: boolean }>(
          "SELECT has_function_privilege('service_role', $1::regprocedure, 'execute') AS ok",
          [WIPE_FN_SIG],
        );
        expect(rows[0]?.ok).toBe(false);
      });


      it(
        "SNE-AC3j-trigger-enabled: tgenabled = 'O' — fires in origin session_replication_role (the default; confirmed by SNE-AC3f-generate-link-live that GoTrue UPDATEs fire the trigger)",
        async () => {
          const { rows } = await client.query<{ tgenabled: string }>(
            `SELECT t.tgenabled
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'auth' AND c.relname = 'users' AND t.tgname = $1`,
            [TRIGGER_NAME],
          );
          // 'O' = enabled in origin mode (the default for all connections, including supabase_auth_admin).
          // SNE-AC3f-generate-link-live confirms a real GoTrue UPDATE fires the trigger.
          // SECURITY DEFINER means the trigger runs as postgres regardless of invoking role.
          expect(rows[0]?.tgenabled).toBe("O");
        },
      );

      it(
        "SNE-AC3j-trigger-table: trigger is on auth.users (not on a view or other schema)",
        async () => {
          const { rows } = await client.query<{ relname: string; nspname: string }>(
            `SELECT c.relname, n.nspname
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE t.tgname = $1`,
            [TRIGGER_NAME],
          );
          expect(rows[0]).toEqual({ relname: "users", nspname: "auth" });
        },
      );

      it(
        "SNE-AC3j-trigger-columns: trigger is defined on both confirmation_sent_at and recovery_sent_at — pg_trigger.tgattr maps to exactly these two column names",
        async () => {
          const { rows } = await client.query<{ attname: string }>(
            `SELECT a.attname
               FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN LATERAL unnest(t.tgattr) AS col_attnum ON true
               JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = col_attnum
              WHERE n.nspname = 'auth' AND c.relname = 'users' AND t.tgname = $1
              ORDER BY a.attname`,
            [TRIGGER_NAME],
          );
          expect(rows.map((r) => r.attname)).toEqual(["confirmation_sent_at", "recovery_sent_at"]);
        },
      );
    });

    // ── SNE-AC3k: recovery branch — recovery_sent_at wipes ──────────────────────

    it(
      "SNE-AC3k-wipe-recovery-null-to-now: unconfirmed monitor_user, recovery_sent_at NULL→non-NULL — recovery branch wipes encrypted_password to '' (SNE-AC3k)",
      async () => {
        await withTx(client, async (c) => {
          const attackerHash = await bcryptHash(c, "attacker-pw-k-null-now");
          // Seed with confirmation_sent_at=NULL, recovery_sent_at=NULL (default)
          await seedUnconfirmedUser(c, WIPE_UUID_20, WIPE_EMAIL_20, undefined, null, attackerHash);
          await assertProfileRole(c, WIPE_UUID_20, "monitor_user");

          // Control: attacker's password verifies before the wipe
          expect(await pgcryptMatches(c, WIPE_UUID_20, "attacker-pw-k-null-now")).toBe(true);

          // Recovery send: recovery_sent_at NULL→non-NULL.
          // new.recovery_sent_at IS NOT NULL ✓, DISTINCT FROM old (NULL) ✓,
          // email_confirmed_at IS NULL (unchanged) ✓, monitor_user ✓ → wipe.
          await c.query(
            `UPDATE auth.users
               SET recovery_token = 'rec-token-k1', recovery_sent_at = $2::timestamptz
             WHERE id = $1`,
            [WIPE_UUID_20, NEW_RECOVERY_SENT_AT],
          );

          const pw = await readPw(c, WIPE_UUID_20);
          expect(pw, "encrypted_password must be '' after recovery wipe (NULL→non-NULL)").toBe("");
          expect(await pgcryptMatches(c, WIPE_UUID_20, "attacker-pw-k-null-now")).toBe(false);
        });
      },
      15_000,
    );

    it(
      "SNE-AC3k-wipe-recovery-earlier-to-later: unconfirmed monitor_user, recovery_sent_at non-NULL→distinct non-NULL — recovery branch wipes encrypted_password to '' (SNE-AC3k)",
      async () => {
        await withTx(client, async (c) => {
          const attackerHash = await bcryptHash(c, "attacker-pw-k-earlier");
          // Seed with recovery_sent_at = OLD_RECOVERY_SENT_AT via INSERT (no trigger fires on INSERT)
          await seedUnconfirmedUser(c, WIPE_UUID_21, WIPE_EMAIL_21, undefined, null, attackerHash, OLD_RECOVERY_SENT_AT);
          await assertProfileRole(c, WIPE_UUID_21, "monitor_user");

          // Control: attacker's password verifies before the wipe
          expect(await pgcryptMatches(c, WIPE_UUID_21, "attacker-pw-k-earlier")).toBe(true);

          // Recovery re-send: recovery_sent_at non-NULL→distinct non-NULL.
          // new.recovery_sent_at IS NOT NULL ✓, DISTINCT FROM old ✓ → wipe.
          await c.query(
            `UPDATE auth.users
               SET recovery_token = 'rec-token-k2', recovery_sent_at = $2::timestamptz
             WHERE id = $1`,
            [WIPE_UUID_21, NEW_RECOVERY_SENT_AT],
          );

          const pw = await readPw(c, WIPE_UUID_21);
          expect(pw, "encrypted_password must be '' after recovery wipe (earlier→later)").toBe("");
          expect(await pgcryptMatches(c, WIPE_UUID_21, "attacker-pw-k-earlier")).toBe(false);
        });
      },
      15_000,
    );

    // ── SNE-AC3k: recovery send on confirmed user — no wipe ──────────────────────

    it(
      "SNE-AC3k-no-wipe-recovery-confirmed: confirmed monitor_user — UPDATE recovery_sent_at does NOT wipe (old.email_confirmed_at IS NOT NULL guard) (SNE-AC3k)",
      async () => {
        await withTx(client, async (c) => {
          const originalHash = await bcryptHash(c, "confirmed-pw-k");
          // Confirmed user (email_confirmed_at = now()), prior recovery_sent_at set via INSERT
          await c.query(
            `INSERT INTO auth.users
               (id, aud, role, email, email_confirmed_at, recovery_sent_at,
                created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
                is_super_admin, encrypted_password)
             VALUES ($1, 'authenticated', 'authenticated', $2,
                     now(), $3::timestamptz,
                     now(), now(), '{}'::jsonb, '{}'::jsonb, false, $4)`,
            [WIPE_UUID_22, WIPE_EMAIL_22, OLD_RECOVERY_SENT_AT, originalHash],
          );
          await assertProfileRole(c, WIPE_UUID_22, "monitor_user");

          // Recovery re-send on confirmed user: trigger fires, old.email_confirmed_at IS NOT NULL → no wipe.
          await c.query(
            `UPDATE auth.users
               SET recovery_token = 'rec-token-k3', recovery_sent_at = $2::timestamptz
             WHERE id = $1`,
            [WIPE_UUID_22, NEW_RECOVERY_SENT_AT],
          );

          const pw = await readPw(c, WIPE_UUID_22);
          expect(pw, "confirmed user password must NOT be wiped on recovery send").toBe(originalHash);
          expect(await pgcryptMatches(c, WIPE_UUID_22, "confirmed-pw-k")).toBe(true);
        });
      },
      15_000,
    );

    // ── SNE-AC3k: recovery send on other roles — no wipe (role guard) ───────────

    const OTHER_ROLE_RECOVERY_CASES: Array<{
      id: string;
      email: string;
      appRole: AppRole | "null-role";
      expectedProfileRole: AppRole | null;
      label: string;
    }> = [
      { id: WIPE_UUID_23, email: WIPE_EMAIL_23, appRole: "owner",       expectedProfileRole: "owner",       label: "owner" },
      { id: WIPE_UUID_24, email: WIPE_EMAIL_24, appRole: "admin",       expectedProfileRole: "admin",       label: "admin" },
      { id: WIPE_UUID_25, email: WIPE_EMAIL_25, appRole: "mylife_user", expectedProfileRole: "mylife_user", label: "mylife_user" },
      { id: WIPE_UUID_26, email: WIPE_EMAIL_26, appRole: "null-role",   expectedProfileRole: null,          label: "null-role" },
    ];

    for (const { id, email, appRole, expectedProfileRole, label } of OTHER_ROLE_RECOVERY_CASES) {
      it(
        `SNE-AC3k-no-wipe-recovery-role-${label}: unconfirmed ${label} — UPDATE recovery_sent_at does NOT wipe (role guard: not monitor_user) (SNE-AC3k)`,
        async () => {
          await withTx(client, async (c) => {
            const originalHash = await bcryptHash(c, `${label}-rec-pw`);

            if (appRole === "null-role") {
              await seedUnconfirmedRolelessUser(c, id, email, originalHash);
            } else {
              await seedUnconfirmedUser(c, id, email, appRole as AppRole, null, originalHash);
            }

            // Non-vacuous: assert the profile does not have the monitor_user role
            await assertProfileRole(c, id, expectedProfileRole);

            // Recovery send: all trigger conditions met EXCEPT profile.role = 'monitor_user'
            await c.query(
              `UPDATE auth.users
                 SET recovery_token = $2, recovery_sent_at = $3::timestamptz
               WHERE id = $1`,
              [id, `rec-token-k-${label}`, NEW_RECOVERY_SENT_AT],
            );

            const pw = await readPw(c, id);
            expect(pw, `password for ${label} must NOT be wiped (role guard)`).toBe(originalHash);
            expect(await pgcryptMatches(c, id, `${label}-rec-pw`)).toBe(true);
          });
        },
        15_000,
      );
    }

    // ── SNE-AC3k: UpdatePassword also sets recovery_sent_at=NULL — no wipe via recovery branch ─

    it(
      "SNE-AC3k-updatepassword-also-sets-recovery-null: UpdatePassword shape (new encrypted_password + recovery_sent_at=NULL, confirmation_sent_at was already NULL) — recovery branch does NOT wipe; new hash is stored (SNE-AC3k exception, source reading; hosted version unverified)",
      async () => {
        await withTx(client, async (c) => {
          const oldHash = await bcryptHash(c, "old-pw-k-rec-null");
          // Seed with confirmation_sent_at=NULL, recovery_sent_at=OLD_RECOVERY_SENT_AT (non-NULL)
          await seedUnconfirmedUser(c, WIPE_UUID_27, WIPE_EMAIL_27, undefined, null, oldHash, OLD_RECOVERY_SENT_AT);
          await assertProfileRole(c, WIPE_UUID_27, "monitor_user");

          const newHash = await bcryptHash(c, "new-pw-k-rec-null");

          // UpdatePassword shape: new hash + confirmation_token='' + confirmation_sent_at=NULL (unchanged, was NULL)
          // + recovery_sent_at=NULL (non-NULL→NULL: trigger fires via recovery_sent_at column).
          // Recovery branch: new.recovery_sent_at IS NOT NULL → FALSE (is NULL) → no recovery wipe.
          // Confirmation branch: old.confirmation_sent_at IS NOT NULL → FALSE (was NULL) → no confirmation wipe.
          // Result: new hash stored, not wiped. Pins this accepted shape.
          await c.query(
            `UPDATE auth.users
               SET encrypted_password = $2, confirmation_token = '',
                   confirmation_sent_at = NULL, recovery_sent_at = NULL
             WHERE id = $1`,
            [WIPE_UUID_27, newHash],
          );

          const pw = await readPw(c, WIPE_UUID_27);
          expect(pw, "password must NOT be wiped (recovery: new IS NULL; confirmation: old IS NULL)").not.toBe("");
          expect(pw, "UpdatePassword hash must be stored when neither branch wipes").toBe(newHash);
        });
      },
      15_000,
    );

    // ── SNE-AC3k: live GoTrue admin path — generateLink recovery wipes password ─

    it(
      "SNE-AC3k-generate-link-recovery-live: admin generateLink(type='recovery') on unconfirmed monitor_user changes recovery_sent_at → trigger wipes encrypted_password (SNE-AC3k; source reading — hosted version unverified)",
      async () => {
        const admin = makeAdminClient();
        const liveEmail = `wipe-gl-rec-${Date.now()}@alnyron-test.local`;

        // Create an unconfirmed monitor_user (no password, email_confirm: false).
        // GoTrue stores a non-empty encrypted_password even without an explicit password.
        const { data: created, error: createErr } = await admin.auth.admin.createUser({
          email: liveEmail,
          email_confirm: false,
          user_metadata: {},
        });
        if (createErr) throw new Error(`Failed to create live-recovery-test user: ${createErr.message}`);
        liveRecoveryTestUserId = created.user.id;

        try {
          const c = await getClient();
          try {
            // Control: profile is monitor_user (handle_new_user assigns it for unlisted email)
            const { rows: profRows } = await c.query<{ role: string | null }>(
              "SELECT role FROM public.profiles WHERE user_id = $1",
              [liveRecoveryTestUserId],
            );
            expect(profRows, "profile row not created by trigger").toHaveLength(1);
            expect(profRows[0]!.role, "profile role must be monitor_user").toBe("monitor_user");

            const { rows: initRows } = await c.query<{ pw: string; rec_sent: string | null }>(
              `SELECT encrypted_password AS pw,
                      (recovery_sent_at AT TIME ZONE 'UTC')::text AS rec_sent
                FROM auth.users WHERE id = $1`,
              [liveRecoveryTestUserId],
            );
            const initialPw = initRows[0]!.pw;
            expect(initialPw, "GoTrue must store a non-empty hash on createUser").not.toBe("");
            expect(initRows[0]!.rec_sent, "recovery_sent_at must be NULL before any recovery send").toBeNull();

            // generateLink(type='recovery') writes recovery_token + recovery_sent_at = now().
            // old.recovery_sent_at IS NULL (newly created) → new IS NOT NULL, DISTINCT FROM NULL
            // → recovery branch wipes encrypted_password to ''.
            // Source: mail.go recovery send writes recovery_token, recovery_sent_at
            // (v2.197.0 and master; hosted version unverified).
            const { error: linkErr } = await admin.auth.admin.generateLink({
              type: "recovery",
              email: liveEmail,
            });
            if (linkErr) throw new Error(`generateLink (recovery) failed: ${linkErr.message}`);

            const { rows: afterRows } = await c.query<{ pw: string; rec_sent: string | null }>(
              `SELECT encrypted_password AS pw,
                      (recovery_sent_at AT TIME ZONE 'UTC')::text AS rec_sent
                FROM auth.users WHERE id = $1`,
              [liveRecoveryTestUserId],
            );
            // Assert GoTrue wrote recovery_sent_at first — if this fails, the column was not
            // set by generateLink and the trigger could not have fired via the recovery branch.
            expect(afterRows[0]!.rec_sent, "generateLink must set recovery_sent_at to non-NULL (GoTrue mail.go recovery send; source reading — hosted version unverified)").not.toBeNull();
            expect(afterRows[0]!.pw, "encrypted_password must be '' after recovery trigger wipe").toBe("");
          } finally {
            c.release();
          }
        } finally {
          // Cleanup regardless of test outcome; afterAll also attempts this as a safety net
          await admin.auth.admin.deleteUser(liveRecoveryTestUserId).catch(() => {});
          liveRecoveryTestUserId = undefined;
        }
      },
      30_000,
    );
  },
);
