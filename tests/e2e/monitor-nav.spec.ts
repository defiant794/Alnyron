/**
 * E2E tests — monitor nav slice (Slice B: Monitor entry in public nav)
 * Journey: monitor-nav  E2E scenarios AC-MONNAV-1 through AC-MONNAV-6
 *
 * Runs against the ISOLATED e2e Supabase project.
 * Guard: SUPABASE_E2E_REF (from tests/.env.e2e-project) prevents any DB/nav mutation
 * reaching the production project. DB_AVAILABLE is true with the production
 * SUPABASE_DB_PASSWORD alone and must NOT be used as this spec's guard.
 *
 * Data safety:
 *   - beforeAll snapshots id, show_in_nav, nav_order for ALL pages (admin_reorder_nav
 *     renumbers every non-pinned page; restoring only the monitor row would drift others),
 *     then hides Monitor and makes it the last row of the Sider list.
 *   - beforeAll also snapshots the apps categories' status; AC3 publishes the first one
 *     and adds a published test item (DA slug prefix `e2e-monnav-`, swept in beforeAll
 *     too) so the nav has a category link to sit after.
 *   - afterAll removes the test items, restores the category status and every page to
 *     its original values in one tx (each only when its snapshot was taken), then calls
 *     revalidateSite() so the shared e2e project is left exactly as found.
 *   - A dedicated admin UUID (00000000-0000-0000-e2e0-000000000030) prevents races with
 *     other specs.
 *
 * Saves: a click on the nav switch or a Flyt button runs a Server Action. `clickAndSave`
 * waits for its response and for the table to leave `aria-busy` (the transition ends
 * once the refreshed list is rendered), so the DB holds the change before the next step
 * revalidates or navigates, and the switch shows the saved row value, not the optimistic one.
 *
 * Serial mode + workers=1 safety: DB-dependent block is serial; Flyt op/ned
 * reorders shared state so parallel execution would corrupt the snapshot baseline.
 *
 * Requires: dev server at PLAYWRIGHT_BASE_URL against the e2e project (`npm run dev:e2e`).
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import messages from "../../messages/da.json";
import type { PoolClient } from "../integration/rls/helpers/db";
import {
  getClient,
  endPool,
  randomE2ePassword,
  E2E_MONNAV_ADMIN_EMAIL,
  seedMonitorNavAdmin,
  cleanupMonitorNavAdmin,
  snapshotAllPages,
  restoreAllPages,
  monitorPageId,
  hideMonitorAtEnd,
  setMonitorShown,
  categoryNavHrefs,
  type PageNavSnapshot,
} from "./fixtures/monitor-nav-seed";
import {
  addCatalogTestItem,
  removeCatalogTestItems,
  restoreCategoryStatuses,
  setCategoryStatus,
  snapshotCategoryStatuses,
  type CategoryStatusSnapshot,
} from "./fixtures/db-state";
import { loginAs } from "./fixtures/admin-login";
import { revalidateSite } from "./fixtures/revalidate";

const { Admin, Nav } = messages;

/** Escapes `text` for literal use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Exact accessible name of a row control whose visible `label` is followed by an sr-only
 * `: <name>` span (the nav switch, the Flyt buttons). Chromium joins the absolutely
 * positioned span with a space ("Flyt op : Monitor"), jsdom without one ("Flyt op: Monitor"),
 * so only the whitespace around the colon may vary.
 */
function rowControlName(label: string, name: string): RegExp {
  return new RegExp(`^${escapeRegExp(label)}\\s*:\\s*${escapeRegExp(name)}$`);
}

/** The Monitor row's fixed name and the accessible names of its nav switch and move buttons. */
const MONITOR = Nav.monitor;
const MONITOR_TOGGLE = rowControlName(Admin.pages.menu.toggle, MONITOR);
const MONITOR_UP = rowControlName(Admin.pages.moveUp, MONITOR);
const MONITOR_DOWN = rowControlName(Admin.pages.moveDown, MONITOR);

/** The category AC3 makes public, and the DA slug prefix of the test item that does it. */
const PUBLIC_CATEGORY_KIND = "apps";
const CATEGORY_ITEM_PREFIX = "e2e-monnav-";

/** The Sider table on /admin/pages. */
function pagesTable(page: Page): Locator {
  return page.getByRole("table", { name: Admin.pages.table.caption });
}

/** The Sider table row whose row header names the Monitor page. */
function monitorRow(page: Page): Locator {
  return pagesTable(page)
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: new RegExp(`^${MONITOR}`) }) });
}

/** Position of the Monitor row among the table's rows (each row header starts with the page name). */
async function monitorIndex(page: Page): Promise<number> {
  const headers = await pagesTable(page).getByRole("rowheader").allInnerTexts();
  return headers.findIndex((text) => text.split("\n")[0]?.trim() === MONITOR);
}

/** Waits until React has hydrated `locator`, so its handlers receive the events sent to it. */
async function expectHydrated(locator: Locator): Promise<void> {
  await expect
    .poll(() => locator.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactProps$"))))
    .toBe(true);
}

/**
 * Clicks `control` (the nav switch or a Flyt button), then waits for its Server
 * Action to answer and for the table to leave `aria-busy`: the save is committed
 * and the list shows the server's values again.
 */
async function clickAndSave(page: Page, control: Locator): Promise<void> {
  await expectHydrated(control);
  const answered = page.waitForResponse(
    (response) => response.request().method() === "POST" && "next-action" in response.request().headers(),
  );
  await control.click();
  expect((await answered).ok(), "the Server Action must answer 2xx").toBe(true);
  await expect(pagesTable(page)).not.toHaveAttribute("aria-busy");
}

// ── Pool lifecycle ─────────────────────────────────────────────────────────────

test.afterAll(async () => {
  await endPool();
});

// ── DB-dependent block ─────────────────────────────────────────────────────────

test.describe("Monitor nav — needs DB", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!process.env.SUPABASE_E2E_REF, "monitor-nav E2E requires tests/.env.e2e-project (SUPABASE_E2E_REF). Running without it would mutate the production nav and pages order.");

  let pgClient: PoolClient | undefined;
  let password: string;
  let snapshot: PageNavSnapshot[] | undefined;
  let categorySnapshot: CategoryStatusSnapshot[] | undefined;
  let monitorId: string;

  test.beforeAll(async () => {
    pgClient = await getClient();
    password = randomE2ePassword();

    // Confirm migration was applied — fail loudly if the monitor row is missing.
    const id = await monitorPageId(pgClient);
    if (!id) {
      throw new Error(
        "monitor-nav E2E: pages row with system_key='monitor' not found. " +
          "Apply 20261107000100_monitor_page_key.sql, then 20261107000200_monitor_nav_page.sql, to the e2e project first.",
      );
    }
    monitorId = id;

    // Snapshot ALL pages before any test mutates nav_order or show_in_nav.
    snapshot = await snapshotAllPages(pgClient);
    categorySnapshot = await snapshotCategoryStatuses(PUBLIC_CATEGORY_KIND);
    await removeCatalogTestItems(CATEGORY_ITEM_PREFIX);

    // Known start: Monitor hidden and the last row of the Sider list (seed may differ between runs).
    await hideMonitorAtEnd(pgClient, monitorId);
    await revalidateSite();

    await cleanupMonitorNavAdmin(pgClient);
    await seedMonitorNavAdmin(pgClient, password);
  });

  test.afterAll(async () => {
    if (!pgClient) return;
    try {
      // An undefined snapshot means beforeAll failed before that data was changed: nothing to restore.
      await removeCatalogTestItems(CATEGORY_ITEM_PREFIX);
      if (categorySnapshot) await restoreCategoryStatuses(categorySnapshot);
      // Restores the pages last: it revalidates the site for every change above.
      if (snapshot) await restoreAllPages(pgClient, snapshot);
      await cleanupMonitorNavAdmin(pgClient);
    } finally {
      pgClient.release();
    }
  });

  // ── AC-MONNAV-E01: Monitor row in /admin/pages ───────────────────────────

  test("AC-MONNAV-E01: /admin/pages shows Monitor row with Synlig switch and no Rediger link", async ({
    page,
  }) => {
    await loginAs(page, E2E_MONNAV_ADMIN_EMAIL, password, "/admin/pages");

    const row = monitorRow(page);
    await expect(row).toHaveCount(1);

    // Must have an accessible switch (the Synlig toggle), off at the start.
    const toggle = row.getByRole("switch", { name: MONITOR_TOGGLE });
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();

    // Must NOT have a Rediger link (Monitor has no content editor).
    await expect(row.getByRole("link", { name: new RegExp(Admin.pages.edit) })).toHaveCount(0);
  });

  // ── AC-MONNAV-E02: Flyt op/ned on Monitor row ────────────────────────────

  test("AC-MONNAV-E02: /admin/pages Monitor row has Flyt op enabled and Flyt ned disabled (last row)", async ({
    page,
  }) => {
    await loginAs(page, E2E_MONNAV_ADMIN_EMAIL, password, "/admin/pages");
    const row = monitorRow(page);

    // beforeAll made Monitor the last row: it can move up, not down.
    await expect(row.getByRole("button", { name: MONITOR_UP })).toBeEnabled();
    await expect(row.getByRole("button", { name: MONITOR_DOWN })).toBeDisabled();
  });

  // ── AC-MONNAV-E03/AC-MONNAV-E06: toggle on → Monitor in header on / ──────

  test("AC-MONNAV-E03: toggling Synlig on shows Monitor link in header on /", async ({
    page,
  }) => {
    await loginAs(page, E2E_MONNAV_ADMIN_EMAIL, password, "/admin/pages");
    const toggle = monitorRow(page).getByRole("switch", { name: MONITOR_TOGGLE });

    // Toggle on; the saved row value (not the optimistic one) must be on before ISR is revalidated.
    await clickAndSave(page, toggle);
    await expect(toggle).toBeChecked();
    await revalidateSite();

    // Public home — Monitor link must be present.
    await page.goto("/");
    const header = page.getByRole("banner");
    await expect(header.getByRole("link", { name: MONITOR, exact: true })).toBeVisible();
  });

  // ── AC-MONNAV-E04/AC6: href is /monitor on / (DA) ────────────────────────

  test("AC-MONNAV-E04: Monitor link on / has href '/monitor' (no locale prefix, AC6) and no hreflang", async ({
    page,
  }) => {
    // Monitor was toggled on by the previous test (serial block).
    await page.goto("/");
    const header = page.getByRole("banner");
    const link = header.getByRole("link", { name: MONITOR, exact: true });
    await expect(link).toHaveAttribute("href", "/monitor");
    // The Danish page links the Danish area: no language change to announce.
    await expect(link).not.toHaveAttribute("hreflang");
  });

  // ── AC-MONNAV-E05/AC6: href is /monitor on /en (EN) ──────────────────────

  test("AC-MONNAV-E05: Monitor link on /en has href '/monitor', NOT '/en/monitor' (AC6), and hreflang 'da'", async ({
    page,
  }) => {
    await page.goto("/en");
    const header = page.getByRole("banner");
    const link = header.getByRole("link", { name: MONITOR, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/monitor");
    // The Monitor area is Danish only: the English page's link says so.
    await expect(link).toHaveAttribute("hreflang", "da");
  });

  // ── AC-MONNAV-E06: clicking Monitor link navigates to /monitor ────────────

  test("AC-MONNAV-E06: clicking Monitor link on / navigates to /monitor", async ({
    page,
  }) => {
    await page.goto("/");
    const header = page.getByRole("banner");
    await header.getByRole("link", { name: MONITOR, exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === "/monitor");
  });

  // ── AC-MONNAV-E07: toggle off → Monitor gone from header ─────────────────

  test("AC-MONNAV-E07: toggling Synlig off removes Monitor from public header", async ({
    page,
  }) => {
    await loginAs(page, E2E_MONNAV_ADMIN_EMAIL, password, "/admin/pages");
    const toggle = monitorRow(page).getByRole("switch", { name: MONITOR_TOGGLE });

    // Toggle off; the saved row value must be off before ISR is revalidated.
    await clickAndSave(page, toggle);
    await expect(toggle).not.toBeChecked();
    await revalidateSite();

    await page.goto("/");
    const nav = page.getByRole("banner").getByRole("navigation", { name: Nav.label });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: MONITOR, exact: true })).toHaveCount(0);
  });

  // ── AC-MONNAV-E08: Flyt op/ned moves Monitor among other Sider ───────────

  test("AC-MONNAV-E08: Flyt op moves Monitor's position in the admin list; it stays after the category links", async ({
    page,
  }) => {
    await loginAs(page, E2E_MONNAV_ADMIN_EMAIL, password, "/admin/pages");
    const row = monitorRow(page);
    await expect(row).toHaveCount(1);

    // Monitor starts as the last row (beforeAll).
    const rowCount = await pagesTable(page).getByRole("rowheader").count();
    const before = await monitorIndex(page);
    expect(before, "Monitor must be the last row before the move").toBe(rowCount - 1);

    await clickAndSave(page, row.getByRole("button", { name: MONITOR_UP }));

    // The saved order: Monitor one row up, so it can now move down too.
    await expect.poll(() => monitorIndex(page), { message: "Monitor must move one row up" }).toBe(before - 1);
    await expect(row.getByRole("button", { name: MONITOR_DOWN })).toBeEnabled();

    // AC3: with a public category (published, holding a published test item) and Monitor
    // shown, Monitor must come after every category link in the public nav.
    await setCategoryStatus(PUBLIC_CATEGORY_KIND, "published");
    await addCatalogTestItem(PUBLIC_CATEGORY_KIND, "published", {
      daSlug: `${CATEGORY_ITEM_PREFIX}item`,
      daTitle: "E2E Monitor nav item",
      enSlug: `${CATEGORY_ITEM_PREFIX}item-en`,
    });
    const client = await getClient();
    let categoryHrefs: Set<string>;
    try {
      categoryHrefs = await categoryNavHrefs(client);
      await setMonitorShown(client, monitorId, true);
    } finally {
      client.release();
    }
    await revalidateSite();

    await page.goto("/");
    const nav = page.getByRole("banner").getByRole("navigation", { name: Nav.label });
    await expect(nav.getByRole("link", { name: MONITOR, exact: true })).toBeVisible();
    const hrefs = await nav.getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    const categoryAt = hrefs.flatMap((href, index) => (href !== null && categoryHrefs.has(href) ? [index] : []));
    expect(categoryAt.length, `the published ${PUBLIC_CATEGORY_KIND} category must be linked in the nav`).toBeGreaterThan(0);
    expect(hrefs.indexOf("/monitor"), "Monitor must appear after every category link in the nav").toBeGreaterThan(
      Math.max(...categoryAt),
    );
  });

  // ── AC-MONNAV-E09: editor route for monitor → not-found ──────────────────

  test("AC-MONNAV-E09: GET /admin/pages/<monitor-id> returns HTTP 404 — no content editor (AC4)", async ({
    page,
  }) => {
    // Use page.goto() response status — avoids English title heuristics; admin is in Danish.
    // getSystemPageForEdit returns null for area pages → Next.js notFound() → 404.
    await loginAs(page, E2E_MONNAV_ADMIN_EMAIL, password, "/admin/pages");
    const response = await page.goto(`/admin/pages/${monitorId}`);
    expect(response?.status(), "Editor route for monitor must return 404").toBe(404);
  });
});
