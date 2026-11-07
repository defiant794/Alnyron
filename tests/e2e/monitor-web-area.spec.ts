/**
 * E2E tests — monitor web area (MON-AC1..MON-AC68)
 * Journey: monitor-web-area
 *
 * Approach: cloud-only (no local Docker / Mailpit).
 *   Login/logout    — seed a real password-enabled monitor_user via pg.
 *   Email verify    — generate_link(type=signup) token → /auth/confirm (no inbox).
 *   Recovery        — generate_link(type=recovery) token → /auth/confirm.
 *   Invite          — generate_link(type=invite) with new 0400 runbook.
 *   Privilege bleed — seed admin, mylife_user, owner; verify cross-area gates.
 *   SSRF / cap      — drive via UI; verify via pg.
 *
 * Requires dev server at PLAYWRIGHT_BASE_URL (http://localhost:3000).
 * DB_AVAILABLE guards pg-dependent groups; SECRET_KEY_AVAILABLE guards
 * generate_link groups.
 */
import { randomUUID } from "node:crypto";
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  DB_AVAILABLE,
  SECRET_KEY_AVAILABLE,
  E2E_MONITOR_EMAIL,
  E2E_MONITOR_UUID,
  E2E_MONITOR_RESET_EMAIL,
  E2E_MONITOR_BLEED_ADMIN_EMAIL,
  E2E_MONITOR_OWNER_EMAIL,
  E2E_MONITOR_OWNER_UUID,
  E2E_MONITOR_MYLIFE_EMAIL,
  E2E_MONITOR_SIGNUP_EMAIL,
  seedE2eMonitorUser,
  cleanupE2eMonitorUser,
  seedE2eMonitorResetUser,
  cleanupE2eMonitorResetUser,
  seedE2eMonitorBleedAdmin,
  cleanupE2eMonitorBleedAdmin,
  seedE2eMonitorOwner,
  cleanupE2eMonitorOwner,
  seedE2eMonitorMyLifeUser,
  cleanupE2eMonitorMyLifeUser,
  cleanupE2eMonitorSignupUser,
  E2E_MONITOR_OTHER_UUID,
  seedE2eMonitorOtherUser,
  cleanupE2eMonitorOtherUser,
  seedMonitors,
  cleanupMonitors,
  seedMonitorEvent,
  endPool,
  randomE2ePassword,
  generateAuthLink,
} from "./fixtures/monitor-seed";
import { getClient, type PoolClient } from "../integration/rls/helpers/db";
import messages from "../../messages/da.json";

const { Auth, Monitor } = messages;

const BASE = "http://localhost:3000";

// ── Shared page helpers ───────────────────────────────────────────────────────

/**
 * Signs in on /monitor/login and waits until the sign-in has navigated away from it (the
 * dashboard, or the no-access page for a role Monitor does not admit), so the session cookies
 * are set before the caller's next navigation.
 */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE}/monitor/login`);
  await page.getByLabel(/e-mail/i).fill(email);
  await page.getByLabel(/adgangskode/i).fill(password);
  await page.getByRole("button", { name: Auth.login.submit }).click();
  await page.waitForURL((url) => url.pathname !== "/monitor/login");
}

/** Waits until React has hydrated `locator`, so its handlers receive the events sent to it. */
async function expectHydrated(locator: Locator): Promise<void> {
  await expect
    .poll(() => locator.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactProps$"))))
    .toBe(true);
}

/** Signs in an owner or monitor_user and waits for the dashboard, where Monitor sign-in lands. */
async function signInToDashboard(page: Page, email: string, password: string): Promise<void> {
  await signIn(page, email, password);
  await expect(page).toHaveURL(/\/monitor\/dashboard$/);
}

// ── (a) Landing: MON-AC1 ─────────────────────────────────────────────────────

test.describe("MON-AC1: /monitor landing page", () => {
  test("MON-AC1a: renders with signup CTA, login link, free-cap copy, noindex", async ({ page }) => {
    await page.goto(`${BASE}/monitor`);
    // CTA to signup
    await expect(page.getByRole("link", { name: Monitor.landing.ctaSignup })).toBeVisible();
    // Login link
    await expect(page.getByRole("link", { name: Monitor.landing.ctaLogin })).toBeVisible();
    // Free cap copy (5)
    await expect(page.locator("body")).toContainText("5");
    // noindex meta
    const robots = await page.locator('meta[name="robots"]').getAttribute("content");
    expect(robots).toContain("noindex");
    // X-Robots-Tag header
    const response = await page.request.get(`${BASE}/monitor`);
    expect(response.headers()["x-robots-tag"]).toContain("noindex");
  });
});

// ── (b) Signup: MON-AC4, MON-AC5, MON-AC9, MON-AC10 ──────────────────────────

test.describe("MON-AC4/MON-AC10: /monitor/signup → generic confirmation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/monitor/signup`);
  });

  test("MON-AC5d: has labeled email and password fields, submit button", async ({ page }) => {
    await expect(page.getByLabel(/e-mail/i)).toBeVisible();
    await expect(page.getByLabel(/adgangskode/i)).toBeVisible();
    await expect(page.getByRole("button", { name: Monitor.signup.submit })).toBeVisible();
  });

  test("MON-AC9a: privacy note with link present", async ({ page }) => {
    await expect(page.getByRole("link", { name: Monitor.signup.privacyLinkText })).toBeVisible();
  });

  test("MON-AC10c: existing account's email → same generic confirmation (no enumeration)", async ({ page }) => {
    test.skip(!DB_AVAILABLE, "Requires DB credentials");
    // An address that already holds a confirmed account gets the answer a new address gets
    // ("Tjek din e-mail" naming the typed address), and no email. GoTrue's rate limit (HTTP 429)
    // can still answer first; that outcome says nothing about enumeration, so it skips the test.
    const client = await getClient();
    try {
      await cleanupE2eMonitorUser(client);
      await seedE2eMonitorUser(client, randomE2ePassword());

      const email = page.getByLabel(/e-mail/i);
      await expectHydrated(email);
      await email.fill(E2E_MONITOR_EMAIL);
      await page.getByLabel(/adgangskode/i).fill(randomE2ePassword());
      await page.getByRole("button", { name: Monitor.signup.submit }).click();
      // The Server Action's answer: the confirmation replaces the form, so never both.
      const confirmation = page.getByRole("heading", { name: Monitor.signup.confirmationTitle, exact: true });
      const rateLimited = page.getByRole("alert").filter({ hasText: Monitor.signup.rateLimitedCopy });
      await expect(confirmation.or(rateLimited)).toBeVisible({ timeout: 10_000 });
      test.skip(
        await rateLimited.isVisible(),
        "GoTrue rate limit (HTTP 429) answered before the signup ran; MON-AC10 not exercised",
      );
      await expect(confirmation).toBeVisible();
      await expect(
        page.getByText(Monitor.signup.confirmationBody.replace("{email}", E2E_MONITOR_EMAIL)),
      ).toBeVisible();
    } finally {
      await cleanupE2eMonitorUser(client);
      client.release();
    }
  });
});

// ── (c) Email verification: MON-AC11, MON-AC12, MON-AC13 ─────────────────────

test.describe("MON-AC11: email verification via /auth/confirm", () => {
  let client: PoolClient;

  test.beforeAll(async () => {
    if (SECRET_KEY_AVAILABLE) client = await getClient();
  });

  test.afterAll(async () => {
    if (SECRET_KEY_AVAILABLE && client) {
      await cleanupE2eMonitorSignupUser(client);
      client.release();
    }
  });

  test("MON-AC11a: valid signup token → /monitor/dashboard", async ({ page }) => {
    test.skip(!SECRET_KEY_AVAILABLE, "Requires SUPABASE_SECRET_KEY");
    const confirmUrl = `${BASE}/auth/confirm?next=/monitor/dashboard`;
    const link = await generateAuthLink("signup", E2E_MONITOR_SIGNUP_EMAIL, confirmUrl, "admin", randomE2ePassword());
    await page.goto(link);
    await expect(page).toHaveURL(/\/monitor\/dashboard/);
  });

  test("MON-AC13a: signup link with cross-area next=/admin/set-password → /monitor/dashboard", async ({ page }) => {
    test.skip(!SECRET_KEY_AVAILABLE, "Requires SUPABASE_SECRET_KEY");
    // generate_link(type=signup) needs an address without an account: drop MON-AC11a's.
    await cleanupE2eMonitorSignupUser(client);
    const confirmUrl = `${BASE}/auth/confirm?next=/admin/set-password`;
    const link = await generateAuthLink("signup", E2E_MONITOR_SIGNUP_EMAIL, confirmUrl, "admin", randomE2ePassword());
    await page.goto(link);
    // A signup link stays in Monitor: the cross-area next is ignored, never /admin or /monitor/reset.
    await expect(page).toHaveURL(/\/monitor\/dashboard$/);
    await expect(page.getByRole("heading", { level: 1, name: Monitor.dashboard.title })).toBeVisible();
  });

  test("MON-AC12a: invalid token → /monitor/login?error=link_invalid", async ({ page }) => {
    await page.goto(`${BASE}/auth/confirm?token_hash=INVALID_TOKEN_HASH&type=signup&next=/monitor/dashboard`);
    await expect(page).toHaveURL(/\/monitor\/login\?error=link_invalid/);
  });
});

// ── (d) Login / sign-out / forgot / reset: MON-AC15..MON-AC21 ────────────────

test.describe("MON-AC15: /monitor/login page structure", () => {
  test("MON-AC15a: labeled fields, Log ind button, Nulstil link", async ({ page }) => {
    await page.goto(`${BASE}/monitor/login`);
    await expect(page.getByLabel(/e-mail/i)).toBeVisible();
    await expect(page.getByLabel(/adgangskode/i)).toBeVisible();
    await expect(page.getByRole("button", { name: Auth.login.submit })).toBeVisible();
    const nulstil = page.getByRole("link", { name: Auth.login.resetPassword });
    await expect(nulstil).toBeVisible();
    await expect(nulstil).toHaveAttribute("href", expect.stringContaining("/monitor/forgot-password"));
    // noindex meta
    const robots = await page.locator('meta[name="robots"]').getAttribute("content");
    expect(robots).toContain("noindex");
  });

  test("MON-AC15f: error=link_invalid shows role=alert", async ({ page }) => {
    await page.goto(`${BASE}/monitor/login?error=link_invalid`);
    await expect(page.getByRole("alert").filter({ hasText: Monitor.login.linkInvalid })).toBeVisible();
  });
});

test.describe("MON-AC16/MON-AC17/MON-AC18: login/logout flow", () => {
  test.skip(!DB_AVAILABLE, "Requires DB credentials");

  let client: PoolClient;
  let password: string;

  test.beforeAll(async () => {
    client = await getClient();
    password = randomE2ePassword();
    await cleanupE2eMonitorUser(client);
    await seedE2eMonitorUser(client, password);
  });

  test.afterAll(async () => {
    await cleanupE2eMonitorUser(client);
    client.release();
    await endPool();
  });

  test("MON-AC16a: valid credentials → /monitor/dashboard", async ({ page }) => {
    await signIn(page, E2E_MONITOR_EMAIL, password);
    await expect(page).toHaveURL(/\/monitor\/dashboard/);
  });

  test("MON-AC17a: invalid credentials → generic error shown", async ({ page }) => {
    await page.goto(`${BASE}/monitor/login`);
    await page.getByLabel(/e-mail/i).fill(E2E_MONITOR_EMAIL);
    await page.getByLabel(/adgangskode/i).fill("WrongPassword1!");
    await page.getByRole("button", { name: Auth.login.submit }).click();
    await expect(page.getByRole("alert").filter({ hasText: Auth.login.invalidCredentials })).toBeVisible();
    await expect(page).not.toHaveURL(/dashboard/);
  });

  test("MON-AC18a: sign out → /monitor/login; dashboard inaccessible", async ({ page }) => {
    await signIn(page, E2E_MONITOR_EMAIL, password);
    await expect(page).toHaveURL(/\/monitor\/dashboard/);
    // Sign out
    await page.getByRole("button", { name: Auth.signOut }).click();
    await expect(page).toHaveURL(/\/monitor\/login/);
    // Try to visit dashboard again
    await page.goto(`${BASE}/monitor/dashboard`);
    await expect(page).toHaveURL(/\/monitor\/login/);
  });
});

test.describe("MON-AC19: forgot-password → generic confirmation", () => {
  test("MON-AC19a: any email → generic confirmation", async ({ page }) => {
    await page.goto(`${BASE}/monitor/forgot-password`);
    await page.getByLabel(/e-mail/i).fill("any@alnyron-test.local");
    await page.getByRole("button", { name: Auth.forgotPassword.submit }).click();
    // Generic confirmation copy
    await expect(page.locator("body")).toContainText(Monitor.forgotPassword.confirmationTitle);
  });
});

// ── Recovery → reset, settings change-password: MON-AC20, MON-AC21, MON-AC43 ──

test.describe("MON-AC20/MON-AC21/MON-AC43: set a new password", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DB_AVAILABLE, "Requires DB credentials");

  let client: PoolClient;
  let password: string;

  test.beforeAll(async () => {
    client = await getClient();
  });

  // Every test starts from a freshly seeded account with a known password.
  test.beforeEach(async () => {
    password = randomE2ePassword();
    await cleanupE2eMonitorResetUser(client);
    await seedE2eMonitorResetUser(client, password);
  });

  test.afterAll(async () => {
    await cleanupE2eMonitorResetUser(client);
    client.release();
  });

  test("MON-AC20a+MON-AC21a: recovery link → /monitor/reset → new password → /monitor/dashboard", async ({ page }) => {
    test.skip(!SECRET_KEY_AVAILABLE, "Requires SUPABASE_SECRET_KEY");
    // The DA recovery link carries next=/admin/set-password; /auth/confirm lands a
    // monitor_user on Monitor's reset page instead (role-aware landing).
    const link = await generateAuthLink("recovery", E2E_MONITOR_RESET_EMAIL, `${BASE}/auth/confirm?next=/admin/set-password`);
    await page.goto(link);
    await expect(page).toHaveURL(/\/monitor\/reset$/);

    const newPassword = randomE2ePassword();
    await page.getByLabel(Auth.setPassword.password, { exact: true }).fill(newPassword);
    await page.getByLabel(Auth.setPassword.confirm, { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: Auth.setPassword.submit }).click();
    await expect(page).toHaveURL(/\/monitor\/dashboard$/);

    // The new password is the account's password now.
    await page.context().clearCookies();
    await signInToDashboard(page, E2E_MONITOR_RESET_EMAIL, newPassword);
  });

  test("MON-AC43a: settings change-password (fresh session) → /monitor/dashboard; the new password signs in", async ({ page }) => {
    await signInToDashboard(page, E2E_MONITOR_RESET_EMAIL, password);
    await page.goto(`${BASE}/monitor/settings`);

    const newPassword = randomE2ePassword();
    await page.getByLabel(Auth.setPassword.password, { exact: true }).fill(newPassword);
    await page.getByLabel(Monitor.settings.passwordConfirm, { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: Auth.setPassword.submit }).click();
    await expect(page).toHaveURL(/\/monitor\/dashboard$/);

    await page.context().clearCookies();
    await signInToDashboard(page, E2E_MONITOR_RESET_EMAIL, newPassword);
  });
});

// ── (e) Dashboard: MON-AC23, MON-AC24, MON-AC25 ──────────────────────────────

test.describe("MON-AC23/MON-AC24/MON-AC25: dashboard", () => {
  test.skip(!DB_AVAILABLE, "Requires DB credentials");

  let client: PoolClient;
  let password: string;

  test.beforeAll(async () => {
    client = await getClient();
    password = randomE2ePassword();
    await cleanupE2eMonitorUser(client);
    await seedE2eMonitorUser(client, password);
  });

  test.afterAll(async () => {
    await cleanupMonitors(client, E2E_MONITOR_UUID);
    await cleanupE2eMonitorUser(client);
    client.release();
  });

  test("MON-AC24a: empty dashboard shows teaching empty state", async ({ page }) => {
    await signIn(page, E2E_MONITOR_EMAIL, password);
    await expect(page).toHaveURL(/\/monitor\/dashboard/);
    await expect(page.locator("body")).toContainText(Monitor.dashboard.emptyTitle);
  });

  test("MON-AC23e: dashboard with 2 monitors shows rows and usage pill", async ({ page }) => {
    await seedMonitors(client, E2E_MONITOR_UUID, 2);
    await signIn(page, E2E_MONITOR_EMAIL, password);
    await expect(page).toHaveURL(/\/monitor\/dashboard/);
    // Two monitors should appear
    await expect(page.locator("body")).toContainText("example-0.com");
    await expect(page.locator("body")).toContainText("example-1.com");
    // Usage pill: the full text a user reads
    await expect(page.getByText("2 / 5 overvågninger brugt", { exact: true })).toBeVisible();
  });
});

test.describe("MON-AC25: owner dashboard usage pill (no cap)", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DB_AVAILABLE, "Requires DB credentials");

  let client: PoolClient;
  let password: string;

  test.beforeAll(async () => {
    client = await getClient();
    password = randomE2ePassword();
    await cleanupE2eMonitorOwner(client);
    await seedE2eMonitorOwner(client, password);
    await seedMonitors(client, E2E_MONITOR_OWNER_UUID, 2);
  });

  test.afterAll(async () => {
    await cleanupMonitors(client, E2E_MONITOR_OWNER_UUID);
    await cleanupE2eMonitorOwner(client);
    client.release();
  });

  test("MON-AC25d: owner with 2 monitors → pill reads '2 overvågninger', no '/ 5'", async ({ page }) => {
    await signInToDashboard(page, E2E_MONITOR_OWNER_EMAIL, password);
    await expect(page.getByText("2 overvågninger", { exact: true })).toBeVisible();
    await expect(page.getByText(/overvågninger brugt/)).toHaveCount(0);
  });
});

// ── (f) Add monitor: MON-AC27, MON-AC28, MON-AC32 ────────────────────────────

test.describe("MON-AC27/MON-AC28/MON-AC32: add monitor", () => {
  test.skip(!DB_AVAILABLE, "Requires DB credentials");

  let client: PoolClient;
  let password: string;

  test.beforeAll(async () => {
    client = await getClient();
    password = randomE2ePassword();
    await cleanupE2eMonitorUser(client);
    await seedE2eMonitorUser(client, password);
  });

  test.afterAll(async () => {
    await cleanupMonitors(client, E2E_MONITOR_UUID);
    await cleanupE2eMonitorUser(client);
    client.release();
  });

  test("MON-AC27a: add valid monitor → redirected to detail page", async ({ page }) => {
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    await page.goto(`${BASE}/monitor/monitors/new`);
    const url = page.getByLabel(/url/i);
    await expectHydrated(url);
    await url.fill("https://example.com/e2e-test");
    await page.getByRole("button", { name: Monitor.monitors.add.submit }).click();
    await expect(page).toHaveURL(/\/monitor\/monitors\/[0-9a-f-]+$/);
  });

  test("MON-AC28a: SSRF URL localhost → error shown; no row", async ({ page }) => {
    const { rows: before } = await client.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM public.monitors WHERE user_id = $1",
      [E2E_MONITOR_UUID],
    );
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    await page.goto(`${BASE}/monitor/monitors/new`);
    const url = page.getByLabel(/url/i);
    await expectHydrated(url);
    await url.fill("http://localhost/attack");
    await page.getByRole("button", { name: Monitor.monitors.add.submit }).click();
    // The blocked-host error on the URL field, still on the form
    await expect(page.getByRole("alert").filter({ hasText: Monitor.form.errors.urlBlockedHost })).toBeVisible();
    const { rows: after } = await client.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM public.monitors WHERE user_id = $1",
      [E2E_MONITOR_UUID],
    );
    expect(Number(after[0]!.count)).toBe(Number(before[0]!.count));
  });

  test("MON-AC32a: cap reached (5 monitors) → friendly error; count stays 5", async ({ page }) => {
    // Seed 5 monitors (replace any existing)
    await cleanupMonitors(client, E2E_MONITOR_UUID);
    await seedMonitors(client, E2E_MONITOR_UUID, 5);
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    await page.goto(`${BASE}/monitor/monitors/new`);
    const url = page.getByLabel(/url/i);
    await expectHydrated(url);
    await url.fill("https://extra.com/");
    await page.getByRole("button", { name: Monitor.monitors.add.submit }).click();
    // Friendly Danish cap error
    await expect(page.getByRole("alert").filter({ hasText: Monitor.form.limitReached })).toBeVisible();
    const { rows } = await client.query<{ count: string }>(
      "SELECT count(*)::int AS count FROM public.monitors WHERE user_id = $1",
      [E2E_MONITOR_UUID],
    );
    expect(Number(rows[0]!.count)).toBe(5);
  });
});

// ── (g) Edit, pause/resume, delete: MON-AC36, MON-AC37, MON-AC38, MON-AC39 ───

test.describe("MON-AC36/MON-AC37/MON-AC38: edit, pause/resume, delete", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DB_AVAILABLE, "Requires DB credentials");

  let client: PoolClient;
  let password: string;
  let monitorId: string;

  test.beforeAll(async () => {
    client = await getClient();
    password = randomE2ePassword();
    await cleanupE2eMonitorUser(client);
    await seedE2eMonitorUser(client, password);
  });

  // Every test gets one fresh monitor ("Monitor 1", https://example-0.com/, daily, active).
  test.beforeEach(async () => {
    await cleanupMonitors(client, E2E_MONITOR_UUID);
    monitorId = (await seedMonitors(client, E2E_MONITOR_UUID, 1))[0]!;
  });

  test.afterAll(async () => {
    await cleanupMonitors(client, E2E_MONITOR_UUID);
    await cleanupE2eMonitorUser(client);
    client.release();
  });

  test("MON-AC36e: edit the label → redirected to the detail page, which shows the new label", async ({ page }) => {
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    await page.goto(`${BASE}/monitor/monitors/${monitorId}/edit`);
    const label = page.getByLabel(Monitor.form.label, { exact: true });
    await expectHydrated(label);
    await label.fill("E2E omdøbt");
    await page.getByRole("button", { name: Monitor.monitors.edit.submit }).click();

    await expect(page).toHaveURL(new RegExp(`/monitor/monitors/${monitorId}$`));
    await expect(page.getByRole("heading", { level: 1, name: "E2E omdøbt" })).toBeVisible();
    const { rows } = await client.query<{ label: string | null }>("SELECT label FROM public.monitors WHERE id = $1", [
      monitorId,
    ]);
    expect(rows).toEqual([{ label: "E2E omdøbt" }]);
  });

  test("MON-AC37e: Pause → paused; Genoptag → active", async ({ page }) => {
    const status = async () =>
      (await client.query<{ status: string }>("SELECT status FROM public.monitors WHERE id = $1", [monitorId])).rows[0]
        ?.status;
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    await page.goto(`${BASE}/monitor/monitors/${monitorId}`);

    await page.getByRole("button", { name: Monitor.detail.pause, exact: true }).click();
    await expect(page.getByRole("button", { name: Monitor.detail.resume, exact: true })).toBeVisible();
    await expect(page.getByText(Monitor.status.paused, { exact: true })).toBeVisible();
    expect(await status()).toBe("paused");

    await page.getByRole("button", { name: Monitor.detail.resume, exact: true }).click();
    await expect(page.getByRole("button", { name: Monitor.detail.pause, exact: true })).toBeVisible();
    await expect(page.getByText(Monitor.status.active, { exact: true })).toBeVisible();
    expect(await status()).toBe("active");
  });

  test("MON-AC38e: Slet → confirm → dashboard; the monitor is gone", async ({ page }) => {
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    await page.goto(`${BASE}/monitor/monitors/${monitorId}`);
    const open = page.getByRole("button", { name: Monitor.detail.delete, exact: true });
    await expectHydrated(open);
    await open.click();
    const dialog = page.getByRole("dialog", { name: Monitor.detail.deleteTitle });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: Monitor.detail.deleteConfirm, exact: true }).click();

    await expect(page).toHaveURL(/\/monitor\/dashboard$/);
    await expect(page.getByText(Monitor.dashboard.emptyTitle)).toBeVisible();
    const { rows } = await client.query("SELECT 1 FROM public.monitors WHERE id = $1", [monitorId]);
    expect(rows).toHaveLength(0);
  });
});

test.describe("MON-AC39: another user's (or a missing) monitor → 404", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DB_AVAILABLE, "Requires DB credentials");

  let client: PoolClient;
  let password: string;
  let foreignId: string;

  test.beforeAll(async () => {
    client = await getClient();
    password = randomE2ePassword();
    await cleanupE2eMonitorUser(client);
    await cleanupE2eMonitorOtherUser(client);
    await seedE2eMonitorUser(client, password);
    await seedE2eMonitorOtherUser(client, randomE2ePassword());
    foreignId = (await seedMonitors(client, E2E_MONITOR_OTHER_UUID, 1))[0]!;
  });

  test.afterAll(async () => {
    await cleanupMonitors(client, E2E_MONITOR_UUID);
    await cleanupMonitors(client, E2E_MONITOR_OTHER_UUID);
    await cleanupE2eMonitorUser(client);
    await cleanupE2eMonitorOtherUser(client);
    client.release();
  });

  /** The Monitor 404 page, showing nothing of the monitor ("Monitor 1", https://example-0.com/). */
  async function expectNotFoundPage(page: Page): Promise<void> {
    await expect(page.getByRole("heading", { level: 1, name: Monitor.notFound.title })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("example-0.com");
  }

  /** Seeds a monitor for the signed-in user; `handOver` later makes it the other account's (as postgres). */
  async function seedOwnMonitor(): Promise<{ id: string; handOver: () => Promise<void> }> {
    const id = (await seedMonitors(client, E2E_MONITOR_UUID, 1))[0]!;
    return {
      id,
      handOver: async () => {
        await client.query("UPDATE public.monitors SET user_id = $1 WHERE id = $2", [E2E_MONITOR_OTHER_UUID, id]);
      },
    };
  }

  test("MON-AC39k: GET another user's monitor → 404 page; nothing of it shown", async ({ page }) => {
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    const response = await page.goto(`${BASE}/monitor/monitors/${foreignId}`);
    expect(response?.status()).toBe(404);
    await expectNotFoundPage(page);
  });

  test("MON-AC39l: GET another user's monitor edit page → 404 page", async ({ page }) => {
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    const response = await page.goto(`${BASE}/monitor/monitors/${foreignId}/edit`);
    expect(response?.status()).toBe(404);
    await expectNotFoundPage(page);
  });

  test("MON-AC39m: GET a monitor id that does not exist → 404 page", async ({ page }) => {
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    const response = await page.goto(`${BASE}/monitor/monitors/${randomUUID()}`);
    expect(response?.status()).toBe(404);
    await expectNotFoundPage(page);
  });

  test("MON-AC39n: saving the edit form of a monitor that became another user's → 404; nothing changed", async ({ page }) => {
    const monitor = await seedOwnMonitor();
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    await page.goto(`${BASE}/monitor/monitors/${monitor.id}/edit`);
    const label = page.getByLabel(Monitor.form.label, { exact: true });
    await expectHydrated(label);
    await monitor.handOver();

    await label.fill("E2E fremmed");
    await page.getByRole("button", { name: Monitor.monitors.edit.submit }).click();
    await expectNotFoundPage(page);
    const { rows } = await client.query("SELECT label, user_id FROM public.monitors WHERE id = $1", [monitor.id]);
    expect(rows).toEqual([{ label: "Monitor 1", user_id: E2E_MONITOR_OTHER_UUID }]);
  });

  test("MON-AC39o: deleting a monitor that became another user's → 404; it still exists", async ({ page }) => {
    const monitor = await seedOwnMonitor();
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    await page.goto(`${BASE}/monitor/monitors/${monitor.id}`);
    const open = page.getByRole("button", { name: Monitor.detail.delete, exact: true });
    await expectHydrated(open);
    await monitor.handOver();

    await open.click();
    await page
      .getByRole("dialog", { name: Monitor.detail.deleteTitle })
      .getByRole("button", { name: Monitor.detail.deleteConfirm, exact: true })
      .click();
    await expectNotFoundPage(page);
    const { rows } = await client.query("SELECT user_id FROM public.monitors WHERE id = $1", [monitor.id]);
    expect(rows).toEqual([{ user_id: E2E_MONITOR_OTHER_UUID }]);
  });

  test("MON-AC39p: pausing a monitor that became another user's → 404; status unchanged", async ({ page }) => {
    const monitor = await seedOwnMonitor();
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    await page.goto(`${BASE}/monitor/monitors/${monitor.id}`);
    const pause = page.getByRole("button", { name: Monitor.detail.pause, exact: true });
    await expectHydrated(pause);
    await monitor.handOver();

    await pause.click();
    await expectNotFoundPage(page);
    const { rows } = await client.query("SELECT status FROM public.monitors WHERE id = $1", [monitor.id]);
    expect(rows).toEqual([{ status: "active" }]);
  });
});

// ── (h) Detail + history: MON-AC40, MON-AC41 ─────────────────────────────────

test.describe("MON-AC40/MON-AC41: monitor detail and history", () => {
  test.skip(!DB_AVAILABLE, "Requires DB credentials");

  let client: PoolClient;
  let password: string;
  let monitorId: string;

  test.beforeAll(async () => {
    client = await getClient();
    password = randomE2ePassword();
    await cleanupE2eMonitorUser(client);
    await seedE2eMonitorUser(client, password);
    monitorId = (await seedMonitors(client, E2E_MONITOR_UUID, 1))[0]!;
  });

  test.afterAll(async () => {
    await cleanupMonitors(client, E2E_MONITOR_UUID);
    await cleanupE2eMonitorUser(client);
    client.release();
  });

  test("MON-AC41a: detail with no events shows 'Ingen ændringer endnu' below the created entry", async ({ page }) => {
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    await page.goto(`${BASE}/monitor/monitors/${monitorId}`);
    await expect(page.locator("body")).toContainText(Monitor.detail.noChanges);
    await expect(page.locator("body")).toContainText(Monitor.detail.createdEntry);
    // MON-AC41: the empty state comes after (below) the creation entry.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.indexOf(Monitor.detail.noChanges)).toBeGreaterThan(bodyText.indexOf(Monitor.detail.createdEntry));
  });

  test("MON-AC40a: detail with events shows them newest-first", async ({ page }) => {
    // Seed two events (older first so we can verify ordering)
    await seedMonitorEvent(client, monitorId, E2E_MONITOR_UUID, "2026-11-04T10:00:00Z", "Older change");
    await seedMonitorEvent(client, monitorId, E2E_MONITOR_UUID, "2026-11-05T10:00:00Z", "Newer change");

    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    await page.goto(`${BASE}/monitor/monitors/${monitorId}`);

    const body = page.locator("body");
    await expect(body).toContainText("Newer change");
    await expect(body).toContainText("Older change");
    const bodyText = await body.innerText();
    const newerIdx = bodyText.indexOf("Newer change");
    const olderIdx = bodyText.indexOf("Older change");
    // Newer change should appear before older change in the DOM
    expect(newerIdx).toBeLessThan(olderIdx);
    // "Overvågning oprettet" is always present
    await expect(page.locator("body")).toContainText(Monitor.detail.createdEntry);
  });
});

// ── (i) Settings: MON-AC42 ───────────────────────────────────────────────────

test.describe("MON-AC42: /monitor/settings", () => {
  test.skip(!DB_AVAILABLE, "Requires DB credentials");

  let client: PoolClient;
  let password: string;

  test.beforeAll(async () => {
    client = await getClient();
    password = randomE2ePassword();
    await cleanupE2eMonitorUser(client);
    await seedE2eMonitorUser(client, password);
  });

  test.afterAll(async () => {
    await cleanupE2eMonitorUser(client);
    client.release();
  });

  test("MON-AC42a: settings page shows notification email and change-password form", async ({ page }) => {
    await signInToDashboard(page, E2E_MONITOR_EMAIL, password);
    await page.goto(`${BASE}/monitor/settings`);
    // Notification address (read-only)
    await expect(page.locator("body")).toContainText(E2E_MONITOR_EMAIL);
    // Change-password form
    await expect(page.getByLabel(/adgangskode/i)).toBeVisible();
    // Sign-out button
    await expect(page.getByRole("button", { name: Auth.signOut })).toBeVisible();
  });
});

// ── (j) Access control: MON-AC44..MON-AC51 ───────────────────────────────────

test.describe("MON-AC44: unauthenticated → redirect to login", () => {
  test("MON-AC44a: GET /monitor/dashboard unauthenticated → 307 to /monitor/login?next=...", async ({ page }) => {
    const response = await page.request.get(`${BASE}/monitor/dashboard`, { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toMatch(/\/monitor\/login/);
    expect(response.headers()["location"]).toContain("next=");
  });

  test("MON-AC50a: GET /monitor/dashboard does not redirect to /da/monitor", async ({ page }) => {
    const response = await page.request.get(`${BASE}/monitor/dashboard`, { maxRedirects: 0 });
    expect(response.headers()["location"] ?? "").not.toContain("/da/monitor");
  });
});

test.describe("MON-AC45/MON-AC46/MON-AC47/MON-AC48/MON-AC49: privilege bleed", () => {
  test.skip(!DB_AVAILABLE, "Requires DB credentials");

  let client: PoolClient;
  let adminPwd: string;
  let mylifePwd: string;
  let ownerPwd: string;
  let monitorPwd: string;

  test.beforeAll(async () => {
    client = await getClient();
    adminPwd = randomE2ePassword();
    mylifePwd = randomE2ePassword();
    ownerPwd = randomE2ePassword();
    monitorPwd = randomE2ePassword();
    await cleanupE2eMonitorBleedAdmin(client);
    await cleanupE2eMonitorMyLifeUser(client);
    await cleanupE2eMonitorOwner(client);
    await cleanupE2eMonitorUser(client);
    await seedE2eMonitorBleedAdmin(client, adminPwd);
    await seedE2eMonitorMyLifeUser(client, mylifePwd);
    await seedE2eMonitorOwner(client, ownerPwd);
    await seedE2eMonitorUser(client, monitorPwd);
  });

  test.afterAll(async () => {
    await cleanupE2eMonitorBleedAdmin(client);
    await cleanupE2eMonitorMyLifeUser(client);
    await cleanupE2eMonitorOwner(client);
    await cleanupE2eMonitorUser(client);
    client.release();
  });

  test("MON-AC45a: admin visits /monitor/dashboard → /monitor/no-access", async ({ page }) => {
    await signIn(page, E2E_MONITOR_BLEED_ADMIN_EMAIL, adminPwd);
    await expect(page).toHaveURL(/\/monitor\/no-access$/);
    await page.goto(`${BASE}/monitor/dashboard`);
    await expect(page).toHaveURL(/\/monitor\/no-access/);
  });

  test("MON-AC46a: mylife_user visits /monitor/dashboard → /monitor/no-access", async ({ page }) => {
    await signIn(page, E2E_MONITOR_MYLIFE_EMAIL, mylifePwd);
    await expect(page).toHaveURL(/\/monitor\/no-access$/);
    await page.goto(`${BASE}/monitor/dashboard`);
    await expect(page).toHaveURL(/\/monitor\/no-access/);
  });

  test("MON-AC47a: owner visits /monitor/dashboard → access allowed", async ({ page }) => {
    await signIn(page, E2E_MONITOR_OWNER_EMAIL, ownerPwd);
    await expect(page).toHaveURL(/\/monitor\/dashboard/);
  });

  test("MON-AC48a: monitor_user visits /admin → /admin/no-access", async ({ page }) => {
    await signInToDashboard(page, E2E_MONITOR_EMAIL, monitorPwd);
    await page.goto(`${BASE}/admin`);
    await expect(page).toHaveURL(/\/admin\/no-access/);
  });

  test("MON-AC49a: monitor_user visits /mylife → /mylife/no-access", async ({ page }) => {
    await signInToDashboard(page, E2E_MONITOR_EMAIL, monitorPwd);
    await page.goto(`${BASE}/mylife`);
    await expect(page).toHaveURL(/\/mylife\/no-access/);
  });
});

