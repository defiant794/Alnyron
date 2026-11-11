/**
 * E2E tests — /admin/monitor-users (admin-monitor-users-cleanup + admin-monitor-users-sites)
 * Journey: admin-monitor-users       AC-AMU-01, AC-AMU-02, AC-AMU-04, AC-AMU-05, AC-AMU-09, AC-AMU-16,
 *                                    AC-AMU-20, AC-AMU-21
 * Journey: admin-monitor-users-cleanup  AMC-16, AMC-18, AMC-19, AMC-20, AMC-21,
 *                                        AMC-22, AMC-23, AMC-26, E2E-AMC-1..4
 * Journey: admin-monitor-users-sites    AMSS-E-1, AMSS-E-2, AMSS-E-3 (Overvåger header: AMC-16)
 *
 * Approach: cloud-only (no local Docker).
 *   - Seeds dedicated admin + four monitor_user fixtures (confirmed, fresh-pending,
 *     expired, sites with two monitors) + a non-admin, all via pg, then logs in.
 *   - The e2e project is shared: asserts only on fixture rows, never on total row count.
 *   - beforeAll removes leftovers of an aborted run before seeding; afterAll removes
 *     the fixtures, then release → endPool.
 *
 * Uses DEDICATED UUIDs (E2E_AMU_*) so this spec never races admin-auth.spec.ts
 * (E2E_ADMIN_UUID) or pages-editor.spec.ts (E2E_PAGES_ADMIN_UUID).
 * All emails are @alnyron-test.local — the global sweep removes leftovers.
 *
 * SUPABASE_E2E_REF gates every test that needs DB credentials or auth.
 * Requires dev server at PLAYWRIGHT_BASE_URL (default http://localhost:3000).
 * --retries=0: delete tests are non-idempotent; never retry them automatically.
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
  E2E_AMU_FRESH_EMAIL,
  E2E_AMU_EXPIRED_EMAIL,
  E2E_AMU_SITES_EMAIL,
  E2E_AMU_SITES_LABEL_ACTIVE,
  E2E_AMU_SITES_URL_ACTIVE,
  E2E_AMU_SITES_URL_PAUSED,
  E2E_AMU_SITES_DISPLAY_PAUSED,
  seedE2eAmuAdmin,
  seedE2eAmuMonitorUser,
  seedE2eAmuNonAdminUser,
  seedE2eAmuFreshUser,
  seedE2eAmuExpiredUser,
  seedE2eAmuSitesUser,
  cleanupE2eAmuAdmin,
  cleanupE2eAmuMonitorUser,
  cleanupE2eAmuNonAdminUser,
  cleanupE2eAmuFreshUser,
  cleanupE2eAmuExpiredUser,
  cleanupE2eAmuSitesUser,
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

/**
 * rowControlName(email, action): whitespace-tolerant accessible-name regex
 * for buttons whose visible text is `action` with the email appended via an
 * sr-only suffix. Chromium may insert a space before the sr-only text.
 */
function rowControlName(email: string, action: string): RegExp {
  // Escape the email for use in a regex
  const escapedEmail = email.replace(/[.+@]/g, (c) => `\\${c}`);
  return new RegExp(`^\\s*${action}[\\s\\S]*${escapedEmail}`);
}

// ── Seed state ────────────────────────────────────────────────────────────────

let pgClient: PoolClient | undefined;
let adminPassword: string;
let nonAdminPassword: string;

async function cleanupFixtures(c: PoolClient): Promise<void> {
  await cleanupE2eAmuSitesUser(c);
  await cleanupE2eAmuNonAdminUser(c);
  await cleanupE2eAmuExpiredUser(c);
  await cleanupE2eAmuFreshUser(c);
  await cleanupE2eAmuMonitorUser(c);
  await cleanupE2eAmuAdmin(c);
}

// ── All tests serialised so seed/cleanup is deterministic ─────────────────────

test.describe.serial("admin-monitor-users E2E", () => {
  test.beforeAll(async () => {
    if (!E2E_REF_AVAILABLE) return;

    const c = await getClient();
    pgClient          = c;
    adminPassword     = randomE2ePassword();
    nonAdminPassword  = randomE2ePassword();

    await cleanupFixtures(c); // leftovers of an aborted run
    await seedE2eAmuAdmin(c, adminPassword);
    await seedE2eAmuMonitorUser(c, randomE2ePassword());
    await seedE2eAmuNonAdminUser(c, nonAdminPassword);
    await seedE2eAmuFreshUser(c, randomE2ePassword());
    await seedE2eAmuExpiredUser(c, randomE2ePassword());
    await seedE2eAmuSitesUser(c, randomE2ePassword());
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

  // ── AMC-16: six column headers in order ───────────────────────────────────

  test("AMC-16: table has six column headers in order: E-mail, Oprettet, Status, Overvåger, Overvågninger, Handlinger", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    await expect(table).toBeVisible();

    const headers = table.getByRole("columnheader");
    await expect(headers.nth(0)).toHaveText("E-mail");
    await expect(headers.nth(1)).toHaveText("Oprettet");
    await expect(headers.nth(2)).toHaveText("Status");
    await expect(headers.nth(3)).toHaveText("Overvåger");
    await expect(headers.nth(4)).toHaveText("Overvågninger");
    await expect(headers.nth(5)).toHaveText("Handlinger");
  });

  // ── AC-AMU-16: 768px width ────────────────────────────────────────────────

  test("AC-AMU-16: at 768px wide the table scrolls inside its card and the page has no horizontal overflow", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await page.setViewportSize({ width: 768, height: 1024 });
    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    await expect(table).toBeVisible();

    const metrics = await table.locator("xpath=..").evaluate((wrapper) => ({
      wrapperScrollWidth: wrapper.scrollWidth,
      wrapperClientWidth: wrapper.clientWidth,
      wrapperRight: wrapper.getBoundingClientRect().right,
      viewportWidth: window.innerWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth,
    }));

    expect(metrics.wrapperScrollWidth).toBeGreaterThan(metrics.wrapperClientWidth);
    expect(metrics.wrapperRight).toBeLessThanOrEqual(metrics.viewportWidth);
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

  // ── AC-AMU-05: Oprettet cell shows Danish formatted date ──────────────────

  test("AC-AMU-05: fixture row Oprettet cell shows the Danish-formatted signup date", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    const fixtureRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_MONITOR_EMAIL }),
    });

    // cells: [Oprettet=0, Status=1, Overvåger=2, Overvågninger=3, Handlinger=4]
    await expect(fixtureRow.getByRole("cell").nth(0)).toHaveText(FORMATTED_CREATED_AT);
  });

  // ── AC-AMU-09: monitor count ──────────────────────────────────────────────

  test("AC-AMU-09: fixture monitor_user row shows monitor count '2' in Overvågninger cell", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    const fixtureRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_MONITOR_EMAIL }),
    });

    // cells[3] = Overvågninger (shifted right: Overvåger now at cells[2])
    await expect(fixtureRow.getByRole("cell").nth(3)).toHaveText("2");
  });

  // ── E2E-AMC-1: three status badges visible ────────────────────────────────

  test("E2E-AMC-1 / AMC-18/19/20: admin sees all three status badges — Tilmeldt, Afventer bekræftelse, Udløbet", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    await expect(table).toBeVisible();

    // AMC-18: confirmed fixture row → "Tilmeldt" badge
    const confirmedRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_MONITOR_EMAIL }),
    });
    await expect(confirmedRow.getByRole("cell").nth(1)).toContainText("Tilmeldt");

    // AMC-19: fresh-unconfirmed row → "Afventer bekræftelse" badge
    const freshRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_FRESH_EMAIL }),
    });
    await expect(freshRow.getByRole("cell").nth(1)).toContainText("Afventer bekræftelse");

    // AMC-20: expired row → "Udløbet" badge
    const expiredRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_EXPIRED_EMAIL }),
    });
    await expect(expiredRow.getByRole("cell").nth(1)).toContainText("Udløbet");
  });

  // ── E2E-AMC-2: expired row is visible and has Slet button ────────────────

  test("E2E-AMC-2 / AMC-20/AMC-16: expired row visible with Slet button in Handlinger column", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    const expiredRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_EXPIRED_EMAIL }),
    });

    await expect(expiredRow).toBeVisible();

    // Slet button in the Handlinger cell (cells[4]) — whitespace-tolerant regex
    const sletBtn = expiredRow.getByRole("button", {
      name: rowControlName(E2E_AMU_EXPIRED_EMAIL, "Slet"),
    });
    await expect(sletBtn).toBeVisible();
  });

  // ── E2E-AMC-3: Slet → dialog → Annuller keeps row ────────────────────────

  test("E2E-AMC-3 / AMC-21/AMC-22: Slet opens dialog with email → Annuller closes without deleting", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    const expiredRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_EXPIRED_EMAIL }),
    });

    // Click the Slet button
    await expiredRow.getByRole("button", {
      name: rowControlName(E2E_AMU_EXPIRED_EMAIL, "Slet"),
    }).click();

    // Dialog appears and shows the email
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(E2E_AMU_EXPIRED_EMAIL)).toBeVisible();

    // Annuller closes the dialog
    await dialog.getByRole("button", { name: "Annuller" }).click();
    await expect(dialog).not.toBeVisible();

    // Row still visible
    await expect(expiredRow).toBeVisible();
  });

  // ── E2E-AMC-4: Slet → confirm → row disappears and stays gone ────────────
  // Deletes the expired fixture, so it runs only after E2E-AMC-1..3, which need
  // that row (the serial suite keeps the order). Gate on SUPABASE_E2E_REF (needs live DB).

  test("E2E-AMC-4 / AMC-23/AMC-26: Slet → 'Slet tilmelding' removes expired row permanently", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    const expiredRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_EXPIRED_EMAIL }),
    });

    // Click the Slet button for the expired row
    await expiredRow.getByRole("button", {
      name: rowControlName(E2E_AMU_EXPIRED_EMAIL, "Slet"),
    }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Confirm deletion
    await dialog.getByRole("button", { name: "Slet tilmelding" }).click();

    // Row disappears (revalidation removes it)
    await expect(expiredRow).not.toBeVisible({ timeout: 10_000 });

    // Reload and confirm the row is still gone: the list itself is back (the
    // confirmed fixture's row is there), only the deleted signup is missing.
    await page.reload();
    await page.waitForURL(ADMIN_MONITOR_USERS_PATH, { timeout: 10_000 });

    const reloadedTable = page.getByRole("table");
    await expect(
      reloadedTable.getByRole("rowheader", { name: E2E_AMU_MONITOR_EMAIL, exact: true }),
    ).toBeVisible();
    await expect(
      reloadedTable.getByRole("rowheader", { name: E2E_AMU_EXPIRED_EMAIL, exact: true }),
    ).toHaveCount(0);
  });

  // ── AC-AMU-20: non-admin → /admin/no-access ───────────────────────────────

  test("AC-AMU-20: signed-in non-admin visiting /admin/monitor-users is redirected to /admin/no-access", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_NONADMIN_EMAIL, nonAdminPassword, "/admin/no-access");
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

  // ══════════════════════════════════════════════════════════════════════════
  // Journey: admin-monitor-users-sites — Overvåger column E2E (AMSS-E-1 … AMSS-E-3)
  // ══════════════════════════════════════════════════════════════════════════

  // ── AMSS-E-1: monitor links in created_at order; labelled active link ──────

  test("AMSS-E-1: sites fixture monitors are links ordered by created_at; the active one has label text, correct href + rel/target", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    const sitesRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_SITES_EMAIL }),
    });

    // Both monitors are links in the Overvåger cell, oldest first: seedE2eAmuSitesUser
    // creates the active one at 10:01 and the paused one at 10:02.
    const sitesLinks = sitesRow.getByRole("cell").nth(2).getByRole("link");
    await expect(sitesLinks).toHaveCount(2);
    await expect(sitesLinks.nth(0)).toHaveAttribute("href", E2E_AMU_SITES_URL_ACTIVE);
    await expect(sitesLinks.nth(1)).toHaveAttribute("href", E2E_AMU_SITES_URL_PAUSED);

    // Active monitor: link text = label
    const activeLink = sitesRow.getByRole("link", { name: new RegExp(E2E_AMU_SITES_LABEL_ACTIVE) });
    await expect(activeLink).toBeVisible();
    await expect(activeLink).toHaveAttribute("href", E2E_AMU_SITES_URL_ACTIVE);
    await expect(activeLink).toHaveAttribute("target", "_blank");
    await expect(activeLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  // ── AMSS-E-2: null-label paused monitor uses displayUrl + paused indicator ─

  test("AMSS-E-2: sites fixture paused monitor uses displayUrl as link text and shows paused indicator", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    const sitesRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_SITES_EMAIL }),
    });

    // Paused monitor: link text = displayUrl (hostname, no scheme)
    const pausedLink = sitesRow.getByRole("link", { name: new RegExp(E2E_AMU_SITES_DISPLAY_PAUSED) });
    await expect(pausedLink).toBeVisible();
    await expect(pausedLink).toHaveAttribute("href", E2E_AMU_SITES_URL_PAUSED);

    // Paused indicator must appear somewhere in the Overvåger cell
    await expect(sitesRow.getByRole("cell").nth(2)).toContainText(/pause/i);
  });

  // ── AMSS-E-3: user with no monitors shows 'Ingen' in Overvåger column ─────

  test("AMSS-E-3: fresh user (no monitors) shows 'Ingen' in Overvåger column, no links", async ({ page }) => {
    test.skip(!E2E_REF_AVAILABLE, "Requires SUPABASE_E2E_REF");

    await loginAs(page, E2E_AMU_ADMIN_EMAIL, adminPassword, ADMIN_MONITOR_USERS_PATH);

    const table = page.getByRole("table");
    // Fresh user has 0 monitors (seeded without seedMonitors)
    const freshRow = table.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: E2E_AMU_FRESH_EMAIL }),
    });

    const sitesCell = freshRow.getByRole("cell").nth(2);
    await expect(sitesCell).toHaveText(/Ingen/i);
    await expect(sitesCell.getByRole("link")).toHaveCount(0);
  });
});
