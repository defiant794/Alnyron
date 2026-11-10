/**
 * E2E tests — /admin/monitor-users (admin-monitor-users)
 * Journey: admin-monitor-users  AC-AMU-01, AC-AMU-02, AC-AMU-03, AC-AMU-04,
 *          AC-AMU-05, AC-AMU-06, AC-AMU-09, AC-AMU-16, AC-AMU-20, AC-AMU-21
 *
 * Approach: cloud-only (no local Docker).
 *   - Seeds dedicated admin + monitor_user fixture via pg, then logs in.
 *   - The e2e project is shared: asserts only on the fixture row, never on
 *     total row count or the page being empty.
 *   - beforeAll removes leftovers of an aborted run before seeding; afterAll
 *     removes the fixtures, then release → endPool.
 *
 * Uses DEDICATED UUIDs (E2E_AMU_*) so this spec never races admin-auth.spec.ts
 * (E2E_ADMIN_UUID) or pages-editor.spec.ts (E2E_PAGES_ADMIN_UUID).
 * All emails are @alnyron-test.local — the global sweep removes leftovers.
 *
 * SUPABASE_E2E_REF gates every test that needs DB credentials or auth.
 * Requires dev server at PLAYWRIGHT_BASE_URL (default http://localhost:3000).
 */

import { test, expect } from "@playwright/test";
import {
  DB_AVAILABLE,
  getClient,
  endPool,
  randomE2ePassword,
  E2E_AMU_ADMIN_EMAIL,
  E2E_AMU_MONITOR_EMAIL,
  E2E_AMU_NONADMIN_EMAIL,
  seedE2eAmuAdmin,
  seedE2eAmuMonitorUser,
  seedE2eAmuNonAdminUser,
  cleanupE2eAmuAdmin,
  cleanupE2eAmuMonitorUser,
  cleanupE2eAmuNonAdminUser,
} from "./fixtures/admin-monitor-seed";
import type { PoolClient } from "../integration/rls/helpers/db";
import { loginAs } from "./fixtures/admin-login";

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN_MONITOR_USERS_PATH = "/admin/monitor-users";

/**
 * formatDateTime(E2E_AMU_MONITOR_CREATED_AT): 2026-10-20 10:00 UTC is 12.00
 * in Copenhagen (CEST, UTC+2).
 */
const FORMATTED_CREATED_AT = "20. okt. 2026, 12.00";

const E2E_REF_AVAILABLE = DB_AVAILABLE && !!process.env.SUPABASE_E2E_REF;

// ── Seed state ────────────────────────────────────────────────────────────────

let pgClient: PoolClient | undefined;
let adminPassword: string;
let nonAdminPassword: string;

async function cleanupFixtures(c: PoolClient): Promise<void> {
  await cleanupE2eAmuNonAdminUser(c);
  await cleanupE2eAmuMonitorUser(c);
  await cleanupE2eAmuAdmin(c);
}

// ── All tests serialised so seed/cleanup is deterministic ─────────────────────

test.describe.serial("admin-monitor-users E2E", () => {
  test.beforeAll(async () => {
    if (!E2E_REF_AVAILABLE) return;

    const c = await getClient();
    pgClient         = c;
    adminPassword    = randomE2ePassword();
    nonAdminPassword = randomE2ePassword();

    await cleanupFixtures(c); // leftovers of an aborted run
    await seedE2eAmuAdmin(c, adminPassword);
    await seedE2eAmuMonitorUser(c, randomE2ePassword());
    await seedE2eAmuNonAdminUser(c, nonAdminPassword);
  });

  test.afterAll(async () => {
    const c = pgClient;
    if (c) {
      await cleanupFixtures(c);
      c.release();
    }
    await endPool();
  });

  // ── AC-AMU-01: nav link navigates to the page ─────────────────────────────

  test("AC-AMU-01: clicking 'Monitor-brugere' in nav navigates to /admin/monitor-users", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword);

    const nav = page.getByRole("navigation", { name: "Administration" });
    await nav.getByRole("link", { name: "Monitor-brugere" }).click();
    await page.waitForURL(ADMIN_MONITOR_USERS_PATH, { timeout: 10_000 });

    await expect(page).toHaveURL(ADMIN_MONITOR_USERS_PATH);
  });

  test("AC-AMU-01b: 'Monitor-brugere' link has aria-current='page' on /admin/monitor-users", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const nav = page.getByRole("navigation", { name: "Administration" });
    await expect(nav.getByRole("link", { name: "Monitor-brugere" })).toHaveAttribute("aria-current", "page");
  });

  // ── AC-AMU-02: title + heading ────────────────────────────────────────────

  test("AC-AMU-02a: browser tab title contains 'Monitor-brugere'", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    await expect(page).toHaveTitle(/Monitor-brugere/);
  });

  test("AC-AMU-02b: page renders h1 heading 'Monitor-brugere' in main region", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    await expect(
      page.getByRole("main").getByRole("heading", { level: 1, name: "Monitor-brugere" }),
    ).toBeVisible();
  });

  // ── AC-AMU-03: column headers ─────────────────────────────────────────────

  test("AC-AMU-03: table has four column headers in order: E-mail, Tilmeldt, Bekræftet, Overvågninger", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    await expect(table).toBeVisible();

    const headers = table.getByRole("columnheader");
    await expect(headers.nth(0)).toHaveText("E-mail");
    await expect(headers.nth(1)).toHaveText("Tilmeldt");
    await expect(headers.nth(2)).toHaveText("Bekræftet");
    await expect(headers.nth(3)).toHaveText("Overvågninger");
  });

  // ── AC-AMU-16: 768px width ────────────────────────────────────────────────

  test("AC-AMU-16: at 768px wide the table scrolls inside its card and the page has no horizontal overflow", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    // At 768px the 256px sidebar sits beside the content column, which is
    // narrower than the table's columns.
    await page.setViewportSize({ width: 768, height: 1024 });
    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    await expect(table).toBeVisible();

    // The table's parent element is its horizontal scroll container.
    const metrics = await table.locator("xpath=..").evaluate((wrapper) => ({
      wrapperScrollWidth: wrapper.scrollWidth,
      wrapperClientWidth: wrapper.clientWidth,
      wrapperRight: wrapper.getBoundingClientRect().right,
      viewportWidth: window.innerWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth,
    }));

    // The table is wider than the container's visible box: it scrolls inside the card.
    expect(metrics.wrapperScrollWidth).toBeGreaterThan(metrics.wrapperClientWidth);
    // The scroll container ends within the window.
    expect(metrics.wrapperRight).toBeLessThanOrEqual(metrics.viewportWidth);
    // The page itself has no horizontal overflow.
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.pageClientWidth);
  });

  // ── AC-AMU-04: email as row header ────────────────────────────────────────

  test("AC-AMU-04: fixture user's email is shown as a row header in the table", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    await expect(
      page.getByRole("table").getByRole("rowheader", { name: E2E_AMU_MONITOR_EMAIL, exact: true }),
    ).toBeVisible();
  });

  // ── AC-AMU-05: Tilmeldt cell shows Danish formatted date ─────────────────

  test("AC-AMU-05: fixture row Tilmeldt cell shows the Danish-formatted signup date", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    const fixtureRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_MONITOR_EMAIL }),
    });

    // cells: [Tilmeldt=0, Bekræftet=1, Overvågninger=2]
    await expect(fixtureRow.getByRole("cell").nth(0)).toHaveText(FORMATTED_CREATED_AT);
  });

  // ── AC-AMU-06: confirmed badge ────────────────────────────────────────────

  test("AC-AMU-06: fixture monitor_user (confirmed) shows '✓ Ja' badge in Bekræftet cell", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    const fixtureRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_MONITOR_EMAIL }),
    });

    // cells[1] = Bekræftet
    await expect(fixtureRow.getByRole("cell").nth(1)).toHaveText(/✓\s*Ja/);
  });

  // ── AC-AMU-09: monitor count ──────────────────────────────────────────────

  test("AC-AMU-09: fixture monitor_user row shows monitor count '2' in Overvågninger cell", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    const fixtureRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_MONITOR_EMAIL }),
    });

    // cells[2] = Overvågninger
    await expect(fixtureRow.getByRole("cell").nth(2)).toHaveText("2");
  });

  // ── AC-AMU-20: non-admin → /admin/no-access ───────────────────────────────

  test("AC-AMU-20: signed-in non-admin visiting /admin/monitor-users is redirected to /admin/no-access", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    // Log in as a non-admin (monitor_user role) — lands on /admin/no-access by default.
    await loginAs(page, E2E_AMU_NONADMIN_EMAIL, nonAdminPassword, "/admin/no-access");
    // Now navigate directly to the page under test.
    await page.goto(ADMIN_MONITOR_USERS_PATH);
    await page.waitForURL("/admin/no-access", { timeout: 10_000 });

    await expect(page).toHaveURL("/admin/no-access");
  });

  // ── AC-AMU-21: anonymous → /admin/login ──────────────────────────────────

  test("AC-AMU-21: anonymous visitor navigating to /admin/monitor-users is redirected to /admin/login", async ({ page }) => {
    await page.goto(ADMIN_MONITOR_USERS_PATH);
    await page.waitForURL(/\/admin\/login/, { timeout: 10_000 });

    await expect(page).toHaveURL(/\/admin\/login/);
  });
});
