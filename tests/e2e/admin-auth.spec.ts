/**
 * E2E tests — admin auth (F1.1)
 * Journey: admin-auth  AC-ADMINAUTH-07..11, AC-LOGIN-01..03, AC-INVITE-01..02, AC-RESET-01..02, F-1, F-7, F-8
 *
 * Approach: cloud-only (no local Docker / Mailpit).
 *   Login/logout — seed a real password-enabled admin user via pg (bcrypt +
 *     auth.identities), clean up before and after the block.
 *   Reset password — call Supabase admin REST generate_link (type: recovery)
 *     to obtain the action_link without waiting for email.
 *   Invite → set-password — generate_link (type: invite) after seeding allowlist.
 *
 * The users are admins on the production project while a block runs: every
 * password is random per run, and each DB block is serial (one worker, in
 * order) so its seed/cleanup hooks never race a parallel copy of itself.
 *
 * Requires dev server at PLAYWRIGHT_BASE_URL (default http://localhost:3000).
 * DB_AVAILABLE guards pg-dependent groups; SECRET_KEY_AVAILABLE guards
 * generate_link groups.  Tests skip gracefully when credentials are absent.
 *
 * Covers the real routes end to end: /admin/login, /admin, /admin/set-password
 * and /auth/confirm, each against the live Supabase project.
 */

import { test, expect } from "@playwright/test";
import {
  DB_AVAILABLE,
  SECRET_KEY_AVAILABLE,
  E2E_ADMIN_EMAIL,
  E2E_RESET_ADMIN_EMAIL,
  E2E_INVITE_EMAIL,
  randomE2ePassword,
  seedE2eAdmin,
  cleanupE2eAdmin,
  seedE2eResetAdmin,
  cleanupE2eResetAdmin,
  cleanupE2eInviteUser,
  generateAuthLink,
  endPool,
} from "./fixtures/admin-auth-seed";
import { getClient, type PoolClient } from "../integration/rls/helpers/db";

// ── Pool lifecycle ────────────────────────────────────────────────────────────

test.afterAll(async () => {
  await endPool();
});

// ── AC-ADMINAUTH-09: login page renders ──────────────────────────────────────

test("AC-ADMINAUTH-09: GET /admin/login renders an email field", async ({ page }) => {
  await page.goto("/admin/login");
  await expect(page.getByRole("textbox", { name: /e-?mail/i })).toBeVisible();
});

test("AC-ADMINAUTH-09b: GET /admin/login renders a password field", async ({ page }) => {
  await page.goto("/admin/login");
  await expect(page.getByLabel(/adgangskode|password/i)).toBeVisible();
});

test("AC-ADMINAUTH-09c: GET /admin/login renders a submit button", async ({ page }) => {
  await page.goto("/admin/login");
  await expect(page.getByRole("button", { name: /log ind|sign in/i })).toBeVisible();
});

// ── AC-ADMINAUTH-10: invalid credentials show generic error ──────────────────

test("AC-ADMINAUTH-10: submitting wrong credentials shows generic Danish error", async ({
  page,
}) => {
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: /e-?mail/i }).fill("nobody@example.com");
  await page.getByLabel(/adgangskode|password/i).fill("wrongpassword123");
  await page.getByRole("button", { name: /log ind|sign in/i }).click();

  await expect(page.getByText("Forkert e-mail eller adgangskode")).toBeVisible();
});

test("AC-ADMINAUTH-10b: error message does not expose Supabase internals", async ({ page }) => {
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: /e-?mail/i }).fill("nobody@example.com");
  await page.getByLabel(/adgangskode|password/i).fill("wrongpassword123");
  await page.getByRole("button", { name: /log ind|sign in/i }).click();

  // None of these raw Supabase strings must leak to the user.
  await expect(page.getByText("Invalid login credentials")).not.toBeVisible();
  await expect(page.getByText("Email not confirmed")).not.toBeVisible();
  await expect(page.getByText("User not found")).not.toBeVisible();
  // The generic Danish message must always be shown instead.
  await expect(page.getByText("Forkert e-mail eller adgangskode")).toBeVisible();
});

// ── Design review F-8 / F-1: focus after submit, link tap targets ────────────

test("F-8: a failed sign-in moves focus to the error message", async ({ page }) => {
  await page.goto("/admin/login");
  await page.getByRole("textbox", { name: /e-?mail/i }).fill("nobody@example.com");
  await page.getByLabel(/adgangskode|password/i).fill("wrongpassword123");
  await page.getByLabel(/adgangskode|password/i).press("Enter");

  // Not <body>: the busy (disabled) submit button no longer drops the focus.
  // (Filtered by text: Next's empty route announcer is also a role="alert".)
  await expect(
    page.getByRole("alert").filter({ hasText: "Forkert e-mail eller adgangskode" }),
  ).toBeFocused();
});

test("F-1: the auth screens' text links are at least 44px tall tap targets", async ({ page }) => {
  for (const [path, name] of [
    ["/admin/login", "Glemt adgangskode?"],
    ["/admin/forgot-password", "Tilbage til log ind"],
  ] as const) {
    await page.goto(path);
    const box = await page.getByRole("link", { name }).boundingBox();
    expect(box?.height, name).toBeGreaterThanOrEqual(44);
  }
});

// ── AC-ADMINAUTH-11: protected routes redirect unauthenticated to login ───────

test("AC-ADMINAUTH-11: GET /admin redirects unauthenticated user to /admin/login", async ({
  page,
}) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login/);
});

test("AC-ADMINAUTH-11b: GET /admin/settings redirects unauthenticated user to /admin/login", async ({
  page,
}) => {
  await page.goto("/admin/settings");
  await expect(page).toHaveURL(/\/admin\/login/);
});

// ── AC-INVITE-02 (no credentials needed): error branch of /auth/confirm ───────

test("AC-INVITE-02: expired/invalid token with external next → /admin/login?error=link_invalid, not evil.com", async ({
  page,
}) => {
  // Uses a fake token so verifyOtp fails; confirms the route sends to
  // /admin/login?error=link_invalid and never follows the external `next`.
  // Runs without SUPABASE_SECRET_KEY or SUPABASE_DB_PASSWORD.
  await page.goto(
    "/auth/confirm?token_hash=fakehash000&type=invite&next=https%3A%2F%2Fevil.com",
  );

  await expect(page).toHaveURL(/\/admin\/login/);
  expect(page.url()).not.toContain("evil.com");
  expect(page.url()).toContain("error=link_invalid");
});

// ── Login → /admin (needs DB, no secret key) ─────────────────────────────────

test.describe("Login flow — AC-LOGIN-01..03, F-7 / needs DB", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DB_AVAILABLE, "SUPABASE_DB_PASSWORD not set — skipping login e2e");

  let pgClient: PoolClient;
  let password: string;

  test.beforeAll(async () => {
    pgClient = await getClient();
    password = randomE2ePassword();
    // Clean up any leftover user from a previous failed run, then seed fresh.
    await cleanupE2eAdmin(pgClient);
    await seedE2eAdmin(pgClient, password);
  });

  test.afterAll(async () => {
    if (pgClient) {
      await cleanupE2eAdmin(pgClient);
      pgClient.release();
    }
  });

  test("AC-LOGIN-01: valid credentials redirect to /admin panel", async ({ page }) => {
    await page.goto("/admin/login");
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_ADMIN_EMAIL);
    await page.getByLabel(/adgangskode|password/i).fill(password);
    await page.getByRole("button", { name: /log ind|sign in/i }).click();

    await expect(page).toHaveURL(/\/admin\/?$/);
    await expect(page.getByRole("heading", { name: /Oversigt/i })).toBeVisible();

    // The session cookies are hidden from page scripts and never sent on
    // cross-site subrequests (AUTH_COOKIE_OPTIONS; `secure` only in production).
    const authCookies = (await page.context().cookies()).filter((c) =>
      /^sb-.+-auth-token/.test(c.name),
    );
    expect(authCookies.length).toBeGreaterThan(0);
    for (const cookie of authCookies) {
      expect(cookie, cookie.name).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    }
  });

  // ── Logout (needs a prior login) ─────────────────────────────────────────

  test("AC-LOGIN-02: logout redirects to /admin/login", async ({ page }) => {
    // Login first.
    await page.goto("/admin/login");
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_ADMIN_EMAIL);
    await page.getByLabel(/adgangskode|password/i).fill(password);
    await page.getByRole("button", { name: /log ind|sign in/i }).click();
    await expect(page).toHaveURL(/\/admin\/?$/);

    // Logout.
    await page.getByRole("button", { name: /log ud|logout|sign out/i }).click();

    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("AC-LOGIN-03: after logout, /admin redirects back to /admin/login", async ({ page }) => {
    // Login.
    await page.goto("/admin/login");
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_ADMIN_EMAIL);
    await page.getByLabel(/adgangskode|password/i).fill(password);
    await page.getByRole("button", { name: /log ind|sign in/i }).click();
    await expect(page).toHaveURL(/\/admin\/?$/);

    // Logout.
    await page.getByRole("button", { name: /log ud|logout|sign out/i }).click();
    await expect(page).toHaveURL(/\/admin\/login/);

    // Confirm the panel is now inaccessible.
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("F-7: at 375px the account sits beside the logo, the navigation leads into the content", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/admin/login");
    await page.getByRole("textbox", { name: /e-?mail/i }).fill(E2E_ADMIN_EMAIL);
    await page.getByLabel(/adgangskode|password/i).fill(password);
    await page.getByRole("button", { name: /log ind|sign in/i }).click();
    await expect(page).toHaveURL(/\/admin\/?$/);

    const account = await page.getByRole("region", { name: "Konto" }).boundingBox();
    const nav = await page.getByRole("navigation", { name: "Administration" }).boundingBox();
    const main = await page.getByRole("main").boundingBox();
    expect(account && nav && main).toBeTruthy();
    // Top row (logo + "Log ud") above the navigation, the content right below it.
    expect(account!.y + account!.height).toBeLessThanOrEqual(nav!.y);
    expect(nav!.y + nav!.height).toBeLessThanOrEqual(main!.y);
    await expect(page.getByRole("button", { name: /log ud/i })).toBeVisible();
  });
});

// ── Reset password flow (needs DB + secret key) ───────────────────────────────

test.describe("Reset password flow — AC-RESET-01..02, AC-ADMINAUTH-07-e2e / needs DB + SUPABASE_SECRET_KEY", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!SECRET_KEY_AVAILABLE, "SUPABASE_SECRET_KEY not set — skipping reset e2e");

  let pgClient: PoolClient;

  test.beforeAll(async () => {
    pgClient = await getClient();
    await cleanupE2eResetAdmin(pgClient);
    await seedE2eResetAdmin(pgClient, randomE2ePassword());
  });

  test.afterAll(async () => {
    if (pgClient) {
      await cleanupE2eResetAdmin(pgClient);
      pgClient.release();
    }
  });

  test("AC-RESET-01: recovery link → /admin/set-password → set new password → /admin", async ({
    page,
  }) => {
    // get the recovery link directly (no email / Mailpit needed).
    const actionLink = await generateAuthLink(
      "recovery",
      E2E_RESET_ADMIN_EMAIL,
      `${process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"}/auth/confirm?next=/admin/set-password`,
    );

    // The action_link points to /auth/confirm which redirects to /admin/set-password.
    await page.goto(actionLink);
    await expect(page).toHaveURL(/\/admin\/set-password/);

    const newPassword = randomE2ePassword();
    await page.getByLabel(/ny adgangskode|new password/i).fill(newPassword);
    await page.getByLabel(/gentag|confirm/i).fill(newPassword);
    await page.getByRole("button", { name: /gem|save|opdater/i }).click();

    await expect(page).toHaveURL(/\/admin\/?$/);
    await expect(page.getByRole("heading", { name: /Oversigt/i })).toBeVisible();
  });

  test("AC-RESET-02: requestPasswordReset shows same success message regardless of email", async ({
    page,
  }) => {
    await page.goto("/admin/forgot-password");

    // Unknown email — no account enumeration.
    await page.getByRole("textbox", { name: /e-?mail/i }).fill("nobody@nowhere.test");
    await page.getByRole("button", { name: /send|nulstil/i }).click();

    // The same message should appear as for a real email.
    await expect(page.getByText(/tjek din e-?mail|check your email/i)).toBeVisible();
  });

  test("AC-ADMINAUTH-07-e2e: valid recovery token + external next → safeNext rejects → /admin/login (no error=)", async ({
    page,
  }) => {
    // Uses a REAL token so verifyOtp succeeds; safeNext then rejects the external
    // next and redirects to /admin/login WITHOUT an error= param.
    // (A fake-token test would exercise the verifyOtp-failure path, not safeNext.)
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const actionLink = await generateAuthLink(
      "recovery",
      E2E_RESET_ADMIN_EMAIL,
      `${baseUrl}/auth/confirm?next=https%3A%2F%2Fevil.com`,
    );

    await page.goto(actionLink);

    await expect(page).toHaveURL(/\/admin\/login/);
    expect(page.url()).not.toContain("evil.com");
    expect(page.url()).not.toContain("error="); // safeNext rejected, NOT verifyOtp failure
  });
});

// ── Invite → set-password flow (needs secret key) ────────────────────────────

test.describe("Invite flow — AC-INVITE-01 / needs SUPABASE_SECRET_KEY", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!SECRET_KEY_AVAILABLE, "SUPABASE_SECRET_KEY not set — skipping invite e2e");

  let pgClient: PoolClient;

  test.beforeAll(async () => {
    pgClient = await getClient();
    // Clean up any leftover invite user from a previous run.
    await cleanupE2eInviteUser(pgClient);
  });

  test.afterAll(async () => {
    if (pgClient) {
      await cleanupE2eInviteUser(pgClient);
      pgClient.release();
    }
  });

  test("AC-INVITE-01: invite link → /admin/set-password → new password → /admin", async ({
    page,
  }) => {
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const actionLink = await generateAuthLink(
      "invite",
      E2E_INVITE_EMAIL,
      `${baseUrl}/auth/confirm?next=/admin/set-password`,
    );

    await page.goto(actionLink);
    await expect(page).toHaveURL(/\/admin\/set-password/);

    const password = randomE2ePassword();
    await page.getByLabel(/ny adgangskode|new password/i).fill(password);
    await page.getByLabel(/gentag|confirm/i).fill(password);
    await page.getByRole("button", { name: /gem|save|opdater/i }).click();

    await expect(page).toHaveURL(/\/admin\/?$/);
    await expect(page.getByRole("heading", { name: /Oversigt/i })).toBeVisible();
  });
});
